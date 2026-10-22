/**
 * Profile a snapshot: field shapes, value types, relationship integrity.
 * Prints no personal data (no emails, no text), only structure and counts.
 *
 *   node scripts/migration/audit.ts [migration-data/snapshot.json]
 */
import { readFileSync } from "node:fs";
import { isTs, parentId, type Plain, type RawDoc, type Snapshot } from "./lib/snapshot.ts";

const file = process.argv[2] ?? "migration-data/snapshot.json";
const snap = JSON.parse(readFileSync(file, "utf8")) as Snapshot;

const typeOf = (v: Plain): string => {
  if (v === null) return "null";
  if (Array.isArray(v)) return `array<${[...new Set(v.map(typeOf))].join("|") || "empty"}>`;
  if (isTs(v)) return "timestamp";
  if (typeof v === "object") return "map";
  if (typeof v === "string") {
    if (v === "") return "string(empty)";
    if (v.startsWith("data:")) return `dataurl(${v.slice(5, v.indexOf(";"))})`;
    if (/^https?:/.test(v)) return "url";
  }
  return typeof v;
};

function profile(name: string, docs: RawDoc[]) {
  console.log(`\n## ${name} — ${docs.length} docs${docs.some((d) => d.missing) ? ` (${docs.filter((d) => d.missing).length} phantom)` : ""}`);
  const shapes = new Map<string, number>();
  const fieldTypes = new Map<string, Map<string, number>>();
  for (const d of docs) {
    const key = Object.keys(d.data).sort().join(", ");
    shapes.set(key, (shapes.get(key) ?? 0) + 1);
    for (const [k, v] of Object.entries(d.data)) {
      const t = fieldTypes.get(k) ?? new Map();
      t.set(typeOf(v), (t.get(typeOf(v)) ?? 0) + 1);
      fieldTypes.set(k, t);
    }
  }
  console.log("shapes:");
  for (const [k, n] of [...shapes].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)} × {${k}}`);
  console.log("field types:");
  for (const [k, t] of [...fieldTypes].sort()) console.log(`  ${k}: ${[...t].map(([ty, n]) => `${ty}×${n}`).join(", ")}`);
}

profile("users", snap.users);
profile("users/*/following", snap.following);
profile("users/*/followers", snap.followers);
profile("posts", snap.posts);
profile("posts/*/comments", snap.comments);
profile("globalChat", snap.globalChat);

// ---- relationships
const str = (v: Plain | undefined) => (typeof v === "string" && v ? v : undefined);
const author = (d: RawDoc) => str(d.data.authorId) ?? str(d.data.userId) ?? str(d.data.uid);
const userDocIds = new Set(snap.users.map((u) => u.id));
const authIds = new Set(snap.authUsers?.map((u) => u.uid) ?? []);
const referenced = new Map<string, Set<string>>();
const ref = (uid: string | undefined, why: string) => uid && (referenced.get(uid) ?? referenced.set(uid, new Set()).get(uid)!).add(why);

snap.posts.forEach((p) => ref(author(p), "post author"));
snap.comments.forEach((c) => ref(author(c), "comment author"));
snap.globalChat.forEach((m) => ref(author(m), "chat author"));
snap.following.forEach((f) => (ref(parentId(f.path), "follower"), ref(f.id, "followee")));
snap.followers.forEach((f) => (ref(parentId(f.path), "followee"), ref(f.id, "follower")));
for (const p of snap.posts) {
  const reacted = p.data.reacted as Record<string, Plain> | undefined;
  for (const [kind, arr] of Object.entries(reacted ?? {})) if (Array.isArray(arr)) arr.forEach((u) => ref(str(u), `reacted.${kind}`));
  if (Array.isArray(p.data.likes)) p.data.likes.forEach((u) => ref(str(u), "likes[]"));
  if (Array.isArray(p.data.savedBy)) p.data.savedBy.forEach((u) => ref(str(u), "savedBy"));
}

console.log(`\n## identities`);
console.log(`  distinct uids referenced anywhere: ${referenced.size}`);
console.log(`  with a users/{uid} doc: ${[...referenced.keys()].filter((u) => userDocIds.has(u)).length}`);
console.log(`  auth users in snapshot: ${snap.authUsers ? snap.authUsers.length : "not available (REST extract)"}`);
if (snap.authUsers) console.log(`  referenced but missing from Firebase Auth: ${[...referenced.keys()].filter((u) => !authIds.has(u)).length}`);
const noDoc = [...referenced].filter(([u]) => !userDocIds.has(u));
console.log(`  referenced without users doc: ${noDoc.length}`);
for (const [, why] of noDoc) console.log(`    - via ${[...why].join(", ")}`);

const postsWithoutAuthor = snap.posts.filter((p) => !author(p)).length;
const postsWithoutDate = snap.posts.filter((p) => !isTs(p.data.createdAt)).length;
const emptyPosts = snap.posts.filter((p) => !str(p.data.text) && !String(p.data.imageDataUrl ?? p.data.imageUrl ?? p.data.image ?? "")).length;
console.log(`\n## data quality`);
console.log(`  posts without author: ${postsWithoutAuthor}, without createdAt: ${postsWithoutDate}, without text or image: ${emptyPosts}`);

const postIds = new Set(snap.posts.map((p) => p.id));
const orphanComments = snap.comments.filter((c) => !postIds.has(parentId(c.path))).length;
console.log(`  comments whose post is missing: ${orphanComments}`);
const commentCountMismatch = snap.posts.filter((p) => {
  const declared = Number(p.data.commentsCount ?? p.data.commentCount ?? 0);
  return declared !== snap.comments.filter((c) => parentId(c.path) === p.id).length;
}).length;
console.log(`  posts whose declared comment count ≠ actual comments: ${commentCountMismatch}`);

let heartArr = 0, heartCount = 0, likesArr = 0, likesNum = 0;
for (const p of snap.posts) {
  const r = p.data.reactions as Record<string, Plain> | undefined;
  const a = (p.data.reacted as Record<string, Plain> | undefined)?.heart;
  heartArr += Array.isArray(a) ? a.length : 0;
  heartCount += typeof r?.heart === "number" ? r.heart : 0;
  if (Array.isArray(p.data.likes)) likesArr += p.data.likes.length;
  if (typeof p.data.likes === "number") likesNum += p.data.likes;
}
console.log(`  likes: reacted.heart uids=${heartArr}, reactions.heart counters=${heartCount}, likes[] uids=${likesArr}, likes:number counters=${likesNum}`);

const edges = (docs: RawDoc[], flip: boolean) => new Set(docs.map((d) => (flip ? `${d.id}->${parentId(d.path)}` : `${parentId(d.path)}->${d.id}`)));
const a = edges(snap.following, false), b = edges(snap.followers, true);
console.log(`  follow edges: following-side=${a.size}, followers-side=${b.size}, union=${new Set([...a, ...b]).size}, only one side=${[...a].filter((e) => !b.has(e)).length + [...b].filter((e) => !a.has(e)).length}, self-follows=${[...a, ...b].filter((e) => e.split("->")[0] === e.split("->")[1]).length}`);

const images = snap.posts.map((p) => str(p.data.imageDataUrl) ?? str(p.data.imageUrl) ?? str(p.data.image)).filter(Boolean) as string[];
const sizes = images.map((i) => Math.round(i.length / 1024));
console.log(`  images: ${images.length} (${images.filter((i) => i.startsWith("data:")).length} inline data URLs, ${images.filter((i) => /^https?:/.test(i)).length} remote URLs), sizes KB: ${sizes.join(", ")}`);
console.log(`  chat messages: ${snap.globalChat.length}, date range: ${[...snap.globalChat].map((m) => (isTs(m.data.createdAt) ? m.data.createdAt.__ts.slice(0, 10) : "?")).sort().filter((_, i, arr) => i === 0 || i === arr.length - 1).join(" → ")}`);
