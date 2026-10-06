/**
 * Firebase → Supabase migration (steps 2–4: transform, load, validate).
 * Run extract.ts first to produce the snapshot.
 *
 *   # Plan only — no writes anywhere, prints what would happen:
 *   node scripts/migration/migrate.ts --plan-only
 *
 *   # Real run against a Supabase project (staging/branch first!):
 *   DATABASE_URL=… SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
 *     node scripts/migration/migrate.ts --target supabase
 *
 *   # Validate only (read-only), e.g. after a run or before cutover:
 *   node scripts/migration/migrate.ts --target supabase --validate-only
 *
 * Options:
 *   --snapshot <file>              default migration-data/snapshot.json
 *   --orphans skip|placeholder     uids with no email: skip their content (default)
 *                                  or create login-less placeholder accounts
 *   --target supabase|local        local = plain Postgres + local shim (tests only)
 *
 * Safe to re-run: existing rows are detected through legacy.* maps.
 * Never writes to Firebase.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import pg from "pg";
import { load, type LoadResult, type OrphanPolicy } from "./lib/load.ts";
import { buildPlan } from "./lib/normalize.ts";
import { LocalFsStorage, LocalSqlAuth, SupabaseAdminAuth, SupabaseStorage, type AuthPort, type StoragePort } from "./lib/ports.ts";
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
const log = (m: string) => console.log(m);

log(`snapshot: ${snapshot.meta.source} extract of ${snapshot.meta.projectId} at ${snapshot.meta.extractedAt}`);
if (!snapshot.meta.hasAuthUsers) log("WARNING: snapshot has no Firebase Auth users — emails come only from users/* docs.");
const noEmail = plan.users.filter((u) => !u.email);
log(`plan: ${plan.users.length} users (${noEmail.length} without email), ${plan.posts.filter((p) => p.kind === "post").length} posts, ` +
  `${plan.posts.filter((p) => p.kind === "comment").length} replies, ${plan.posts.reduce((s, p) => s + p.images.length, 0)} images, ` +
  `${plan.posts.reduce((s, p) => s + p.likerUids.length, 0)} likes, ${plan.follows.length} follows, ${plan.chatArchive.length} chat messages`);
for (const s of plan.skipped) log(`  plan skip ${s.kind} ${s.ref}: ${s.reason}`);

if (args["plan-only"]) process.exit(0);

if (!["skip", "placeholder"].includes(args.orphans!)) throw new Error("--orphans must be skip or placeholder");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("Set DATABASE_URL (Supabase → Connect → session pooler connection string).");

const db = new pg.Client({ connectionString: databaseUrl });
await db.connect();

let auth: AuthPort;
let storage: StoragePort;
if (args.target === "local") {
  const { rows } = await db.query("select exists (select 1 from pg_roles where rolname = 'supabase_admin') as real");
  if (rows[0].real) throw new Error("--target local refuses to run against a real Supabase database.");
  auth = new LocalSqlAuth(db);
  storage = new LocalFsStorage(args["local-storage-dir"]!);
} else {
  const { createClient } = await import("@supabase/supabase-js");
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  auth = new SupabaseAdminAuth(admin);
  storage = new SupabaseStorage(admin);
}

let result: LoadResult | null = null;
if (!args["validate-only"]) {
  const run = await db.query<{ id: number }>(
    "insert into legacy.migration_runs (snapshot_source, snapshot_extracted_at) values ($1, $2) returning id",
    [snapshot.meta.source, snapshot.meta.extractedAt],
  );
  result = await load(db, auth, storage, plan, { orphans: args.orphans as OrphanPolicy, log });
  const { skipped, ...summary } = result;
  await db.query("update legacy.migration_runs set finished_at = now(), summary = $2 where id = $1", [run.rows[0].id, { ...summary, skipped: skipped.length }]);
  log("\nload summary:");
  for (const [k, v] of Object.entries(summary)) log(`  ${k}: ${typeof v === "object" ? Object.entries(v).map(([a, b]) => `${a}=${b}`).join(" ") : v}`);
}

// Skips = planning skips + load skips (load skips are recomputed on validate-only runs).
const skippedAll = [...plan.skipped, ...(result?.skipped ?? [])];
if (!result) {
  // On a validate-only run, explain gaps using the same rules the loader applies.
  const mapped = new Set((await db.query<{ firebase_uid: string }>("select firebase_uid from legacy.user_map")).rows.map((r) => r.firebase_uid));
  for (const u of plan.users) if (!mapped.has(u.firebaseUid)) skippedAll.push({ kind: "user", ref: u.firebaseUid, reason: u.email ? "not migrated yet" : "no email on record" });
  for (const p of plan.posts) if (!mapped.has(p.authorUid)) skippedAll.push({ kind: p.kind, ref: p.firebasePath, reason: "author account was not migrated" });
}

const report = await validate(db, storage, plan, skippedAll);
await db.end();

const md = reportMarkdown("Firebase → Supabase migration report", {
  Generated: new Date().toISOString(),
  Snapshot: `${snapshot.meta.source} extract at ${snapshot.meta.extractedAt}`,
  Target: args.target!,
  "Orphan policy": args.orphans!,
  Mode: args["validate-only"] ? "validate only" : "load + validate",
}, report);
const out = args.report ?? `migration-data/report-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
mkdirSync("migration-data", { recursive: true });
writeFileSync(out, md);
log(`\nreport: ${out}`);
const failed = report.checks.filter((c) => !c.ok);
for (const c of report.checks) log(`  ${c.ok ? "PASS" : "FAIL"} ${c.name} (${c.detail})`);
process.exit(failed.length ? 1 : 0);
