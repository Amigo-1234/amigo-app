/**
 * Compare two snapshots and report what changed in Firebase between them.
 * Prints document paths and field names only — never content or emails.
 *
 *   node scripts/migration/diff.ts <older.json> <newer.json>
 *   node scripts/migration/diff.ts            # newest archived vs current
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { RawDoc, Snapshot } from "./lib/snapshot.ts";

let [a, b] = process.argv.slice(2);
if (!a || !b) {
  const archived = readdirSync("migration-data").filter((f) => /^snapshot-.+\.json$/.test(f)).sort();
  if (!archived.length) throw new Error("No archived snapshot to compare with. Pass two files.");
  a = `migration-data/${archived[archived.length - 1]}`;
  b = "migration-data/snapshot.json";
}
const older = JSON.parse(readFileSync(a, "utf8")) as Snapshot;
const newer = JSON.parse(readFileSync(b, "utf8")) as Snapshot;
console.log(`# Snapshot diff\n\n- older: ${older.meta.source} @ ${older.meta.extractedAt}\n- newer: ${newer.meta.source} @ ${newer.meta.extractedAt}\n`);

/** Key-order-independent JSON (Firestore REST returns map fields in varying order). */
const canon = (v: unknown): string =>
  v && typeof v === "object"
    ? Array.isArray(v)
      ? `[${v.map(canon).join(",")}]`
      : `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`
    : JSON.stringify(v);
const hash = (d: RawDoc) => createHash("sha256").update(canon(d.data)).digest("hex");
const sections: [string, keyof Snapshot][] = [
  ["users", "users"], ["following", "following"], ["followers", "followers"],
  ["posts", "posts"], ["comments", "comments"], ["globalChat", "globalChat"],
];

console.log("| Collection | Before | After | Added | Removed | Changed |\n|---|---:|---:|---:|---:|---:|");
const details: string[] = [];
for (const [label, key] of sections) {
  const before = new Map((older[key] as RawDoc[]).map((d) => [d.path, d]));
  const after = new Map((newer[key] as RawDoc[]).map((d) => [d.path, d]));
  const added = [...after.keys()].filter((k) => !before.has(k));
  const removed = [...before.keys()].filter((k) => !after.has(k));
  const changed = [...after.keys()].filter((k) => before.has(k) && hash(before.get(k)!) !== hash(after.get(k)!));
  console.log(`| ${label} | ${before.size} | ${after.size} | ${added.length} | ${removed.length} | ${changed.length} |`);
  for (const k of added) details.push(`+ ${k}`);
  for (const k of removed) details.push(`- ${k}`);
  for (const k of changed) {
    const x = before.get(k)!.data, y = after.get(k)!.data;
    const fields = [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((f) => canon(x[f]) !== canon(y[f]));
    details.push(`~ ${k} (fields: ${fields.join(", ")})`);
  }
}
if (older.authUsers || newer.authUsers) {
  const ua = new Set((older.authUsers ?? []).map((u) => u.uid)), ub = new Set((newer.authUsers ?? []).map((u) => u.uid));
  console.log(`| auth users | ${older.authUsers?.length ?? "n/a"} | ${newer.authUsers?.length ?? "n/a"} | ${[...ub].filter((u) => !ua.has(u)).length} | ${[...ua].filter((u) => !ub.has(u)).length} | — |`);
}
console.log(details.length ? `\n## Documents\n\n${details.map((d) => `- \`${d}\``).join("\n")}` : "\nNo document changes.");
