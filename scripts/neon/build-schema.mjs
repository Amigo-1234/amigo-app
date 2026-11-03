#!/usr/bin/env node
/**
 * Builds the Neon schema from the Supabase migrations, so there is one source
 * of truth for tables, RLS and functions.
 *
 *   node scripts/neon/build-schema.mjs [outDir]
 *
 * Writes one file per step (00_prelude.sql, then each migration) into outDir
 * (default: neon/build, git-ignored). Each file is wrapped in a single DO block
 * so it can be applied atomically through a one-statement SQL API.
 *
 * Transforms (see neon/prelude.sql for why):
 *   auth.users  -> app_auth.users
 *   auth.uid()  -> app_auth.uid()
 *   `alter publication supabase_realtime ...` lines are dropped (no Realtime).
 *   The Supabase `session_id` JWT claim (used to sign out a removed device's
 *   auth session) is read as null: Neon Auth session ids aren't uuids and
 *   live in neon_auth.session. Removing a device still revokes its keys.
 * Skipped: the Firebase legacy-import migrations (Supabase-only tooling).
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../..", import.meta.url).pathname;
const outDir = process.argv[2] ?? join(root, "neon/build");
const SKIP = /_legacy_/;

const transform = (sql) =>
  sql
    .replace(/\bauth\.users\b/g, "app_auth.users")
    .replace(/\bauth\.uid\(\)/g, "app_auth.uid()")
    .replace(/^alter publication supabase_realtime .*$/gm, "-- (Realtime publication omitted on Neon)")
    .replace("nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'session_id', '')::uuid", "null::uuid");

const wrap = (sql) => {
  if (sql.includes("$neon_step$")) throw new Error("migration uses the reserved $neon_step$ tag");
  return `do $neon_wrap$ begin execute $neon_step$\n${sql}\n$neon_step$; end $neon_wrap$;\n`;
};

mkdirSync(outDir, { recursive: true });
const steps = [["00_prelude.sql", readFileSync(join(root, "neon/prelude.sql"), "utf8")]];
const dir = join(root, "supabase/migrations");
for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql") && !SKIP.test(f)).sort()) {
  steps.push([f, transform(readFileSync(join(dir, f), "utf8"))]);
}
for (const [name, sql] of steps) writeFileSync(join(outDir, name), wrap(sql));
console.log(`${steps.length} steps -> ${outDir}`);
