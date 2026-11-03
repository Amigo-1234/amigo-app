/**
 * How receivers treat reactions and edits (src/data/supabase/annotationRule.ts), offline.
 * The server enforces its part on the label it can see (supabase/tests/database.test.sql);
 * this is the part only a receiver can check, against the encrypted type.
 *
 *   node scripts/test/annotations.test.mjs
 */
import { createServer } from "vite";

let failures = 0;
const ok = (label, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
};
const vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
const { annotationKind } = await vite.ssrLoadModule("/src/data/supabase/annotationRule.ts");

const sent = "2026-10-28T10:00:00Z";
const at = (min) => new Date(Date.parse(sent) + min * 60_000).toISOString();
const msg = { sender_id: "ama", created_at: sent };
const row = (sender, min, kind) => ({ sender_id: sender, created_at: at(min), relates_kind: kind });

ok("an edit by the sender within 15 minutes counts", annotationKind(row("ama", 14, "edit"), "amigo.edit", msg) === "edit");
ok("…at exactly 15 minutes too", annotationKind(row("ama", 15, "edit"), "amigo.edit", msg) === "edit");
ok("a late edit is ignored", annotationKind(row("ama", 16, "edit"), "amigo.edit", msg) === null);
ok("a late edit labelled as a reaction is ignored (label doesn't match what's inside)", annotationKind(row("ama", 60, "reaction"), "amigo.edit", msg) === null);
ok("an edit from an app before labels: counts in time…", annotationKind(row("ama", 5, null), "amigo.edit", msg) === "edit");
ok("…and is ignored when late", annotationKind(row("ama", 16, null), "amigo.edit", msg) === null);
ok("an edit by someone else is ignored", annotationKind(row("leo", 1, "edit"), "amigo.edit", msg) === null);
ok("an edit of a message not loaded is ignored", annotationKind(row("ama", 1, "edit"), "amigo.edit", undefined) === null);
ok("a reaction counts at any age", annotationKind(row("leo", 60 * 24, "reaction"), "amigo.reaction", msg) === "reaction");
ok("reacting to (or un-reacting from) your own old message counts", annotationKind(row("ama", 600, "reaction"), "amigo.reaction", msg) === "reaction");
ok("a reaction from an app before labels counts", annotationKind(row("leo", 600, null), "amigo.reaction", msg) === "reaction");
ok("a reaction labelled as an edit is ignored", annotationKind(row("leo", 1, "edit"), "amigo.reaction", msg) === null);
ok("anything else is ignored", annotationKind(row("ama", 1, null), "m.text", msg) === null);

await vite.close();
console.log(failures ? `${failures} FAILURE(S)` : "ALL ANNOTATION TESTS PASSED");
process.exit(failures ? 1 : 0);
