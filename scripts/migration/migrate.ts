/**
 * Firebase → Supabase migration (steps 2–4: transform, load, validate).
 * Run extract.ts first to produce the snapshot.
 *
 *   # Plan only — no writes anywhere, prints what would happen:
 *   node scripts/migration/migrate.ts --plan-only
 *
 *   # Real run against a Supabase project (HTTPS only — no DB connection needed):
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/migration/migrate.ts --target supabase
 *
 *   # Validate only (read-only), e.g. after a run or before cutover:
 *   node scripts/migration/migrate.ts --target supabase --validate-only
 *
 * Options:
 *   --snapshot <file>              default migration-data/snapshot.json
 *   --orphans skip|placeholder     uids with no email: skip their content (default)
 *                                  or create login-less placeholder accounts
 *   --target supabase|local        local = shim + PostgREST + DATABASE_URL (tests only)
 *
 * Safe to re-run: existing rows are detected through legacy.* maps.
 * Never writes to Firebase.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { MigrationDb } from "./lib/db.ts";
import { load, type LoadResult, type OrphanPolicy } from "./lib/load.ts";
import { buildPlan } from "./lib/normalize.ts";
import { LocalFsStorage, LocalSqlAuth, SupabaseAdminAuth, SupabaseStorage, type AuthPort, type StoragePort } from "./lib/ports.ts";
import { redact } from "./lib/redact.ts";
import type { Snapshot } from "./lib/snapshot.ts";
import { reportMarkdown, validate } from "./lib/validate.ts";

const { values: args } = parseArgs({
  options: {
    snapshot: { type: "string", default: "migration-data/snapshot.json" },
    target: { type: "string", default: "supabase" },
    orphans: { type: "string", default: "skip" },
    "plan-only": { type: "boolean", default: false },
    "validate-only": { type: "boolean", default: false },
    "local-storage-dir": { type: "string", default: "migration-data/local-storage" },
    report: { type: "string" },
  },
});

const snapshot = JSON.parse(readFileSync(args.snapshot!, "utf8")) as Snapshot;
const plan = buildPlan(snapshot);
// Every line printed or written goes through redact(): no full emails, ever.
const log = (m: string) => console.log(redact(m));

log(`snapshot: ${snapshot.meta.source} extract of ${snapshot.meta.projectId} at ${snapshot.meta.extractedAt}`);
if (!snapshot.meta.hasAuthUsers) log("WARNING: snapshot has no Firebase Auth users — emails come only from users/* docs.");
const noEmail = plan.users.filter((u) => !u.email);
log(`plan: ${plan.users.length} users (${noEmail.length} without email), ${plan.posts.filter((p) => p.kind === "post").length} posts, ` +
  `${plan.posts.filter((p) => p.kind === "comment").length} replies, ${plan.posts.reduce((n, p) => n + p.images.length, 0)} images, ` +
  `${plan.posts.reduce((n, p) => n + p.likerUids.length, 0)} likes, ${plan.follows.length} follows, ${plan.chatArchive.length} chat messages, ` +
  `${plan.reactionArchive.length} other reactions, ${plan.savedArchive.length} saves`);
for (const x of plan.skipped) log(`  plan skip ${x.kind} ${x.ref}: ${x.reason}`);

if (args["plan-only"]) process.exit(0);
if (!["skip", "placeholder"].includes(args.orphans!)) throw new Error("--orphans must be skip or placeholder");

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (environment secrets — never commit them).");
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const db = new MigrationDb(admin);

let auth: AuthPort;
let storage: StoragePort;
let closeLocal = async () => {};
if (args.target === "local") {
  // Local testing only: auth users go straight into the shim's auth.users.
  if (/supabase\.co/.test(url)) throw new Error("--target local refuses to run against a hosted Supabase project.");
  const pg = (await import("pg")).default;
  const localDb = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await localDb.connect();
  auth = new LocalSqlAuth(localDb);
  storage = new LocalFsStorage(args["local-storage-dir"]!);
  closeLocal = () => localDb.end();
} else {
  auth = new SupabaseAdminAuth(admin);
  storage = new SupabaseStorage(admin);
}

let result: LoadResult | null = null;
if (!args["validate-only"]) {
  const runId = await db.rpc<number>("legacy_run_start", { p_source: snapshot.meta.source, p_extracted_at: snapshot.meta.extractedAt });
  result = await load(db, auth, storage, plan, { orphans: args.orphans as OrphanPolicy, log });
  const { skipped, ...summary } = result;
  await db.rpc("legacy_run_finish", { p_id: runId, p_summary: { ...summary, skipped: skipped.length } });
  log("\nload summary:");
  for (const [k, v] of Object.entries(summary)) log(`  ${k}: ${typeof v === "object" ? Object.entries(v).map(([a, b]) => `${a}=${b}`).join(" ") : v}`);
}

// Skips = planning skips + load skips (recomputed on validate-only runs).
const skippedAll = [...plan.skipped, ...(result?.skipped ?? [])];
if (!result) {
  const mapped = new Set(Object.keys((await db.state()).users));
  for (const u of plan.users) if (!mapped.has(u.firebaseUid)) skippedAll.push({ kind: "user", ref: u.firebaseUid, reason: u.email ? "not migrated yet" : "no email on record" });
  for (const p of plan.posts) if (!mapped.has(p.authorUid)) skippedAll.push({ kind: p.kind, ref: p.firebasePath, reason: "author account was not migrated" });
}

const report = await validate(db, storage, plan, skippedAll);
await closeLocal();

const md = redact(reportMarkdown("Firebase → Supabase migration report", {
  Generated: new Date().toISOString(),
  Snapshot: `${snapshot.meta.source} extract at ${snapshot.meta.extractedAt}`,
  Target: args.target === "local" ? "local test database" : new URL(url).host,
  "Orphan policy": args.orphans!,
  Mode: args["validate-only"] ? "validate only" : "load + validate",
}, report));
const out = args.report ?? `migration-data/report-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
mkdirSync("migration-data", { recursive: true });
writeFileSync(out, md);
log(`\nreport: ${out}`);
const failed = report.checks.filter((c) => !c.ok);
for (const c of report.checks) log(`  ${c.ok ? "PASS" : "FAIL"} ${c.name} (${c.detail})`);
process.exit(failed.length ? 1 : 0);
