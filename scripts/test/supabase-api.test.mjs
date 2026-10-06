/**
 * End-to-end API test of the app's Supabase query layer
 * (src/data/supabase/queries.ts) through a real PostgREST, as real users.
 *
 * Needs: a database with the migrations applied (local shim is fine) and a
 * PostgREST pointing at it. Creates throwaway users and removes them after.
 *
 *   PGRST_URL=http://localhost:54330 JWT_SECRET=… DATABASE_URL=… \
 *     node scripts/test/supabase-api.test.mjs
 *
 * Realtime, Storage and Auth (GoTrue) are not covered here — see README.
 */
import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { createServer } from "vite";

const { PGRST_URL, JWT_SECRET, DATABASE_URL } = process.env;
if (!PGRST_URL || !JWT_SECRET || !DATABASE_URL) throw new Error("Set PGRST_URL, JWT_SECRET and DATABASE_URL");

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims) => {
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims });
  return `${head}.${body}.${createHmac("sha256", JWT_SECRET).update(`${head}.${body}`).digest("base64url")}`;
};

// supabase-js talks to <url>/rest/v1 — forward that to PostgREST.
const proxy = http.createServer(async (req, res) => {
  const target = PGRST_URL + req.url.replace(/^\/rest\/v1/, "");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !["host", "connection", "content-length"].includes(k)));
  const r = await fetch(target, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
  res.writeHead(r.status, Object.fromEntries([...r.headers].filter(([k]) => k !== "content-encoding" && k !== "content-length")));
  res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise((ok) => proxy.listen(0, ok));
const baseUrl = `http://127.0.0.1:${proxy.address().port}`;

const vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
const q = await vite.ssrLoadModule("/src/data/supabase/queries.ts");

const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();

const anonKey = jwt({ role: "anon" });
const asUser = (id) =>
  createClient(baseUrl, anonKey, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${jwt({ sub: id, role: "authenticated" })}` } } });
const anon = createClient(baseUrl, anonKey, { auth: { persistSession: false } });

let failures = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};
const rejects = async (label, fn, code) => {
  try {
    await fn();
    ok(label, false, "did not fail");
  } catch (e) {
    ok(label, !code || e.code === code || e.pgCode === code, `${e.code}/${e.pgCode}`);
  }
};

const tag = randomUUID().slice(0, 8);
const ids = { ama: randomUUID(), leo: randomUUID(), zoe: randomUUID() };
try {
  for (const [name, id] of Object.entries(ids)) {
    await db.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)", [id, `${name}-${tag}@example.com`, { display_name: `${name} ${tag}` }]);
  }
  const ama = asUser(ids.ama), leo = asUser(ids.leo), zoe = asUser(ids.zoe);

  // profile
  const prof = await q.fetchProfile(ama, ids.ama);
  ok("profile created by trigger and readable", prof?.display_name === `ama ${tag}` && /^ama_/.test(prof.username));
  const { data: emailProbe, error: emailErr } = await ama.from("profiles").select("email").limit(1);
  ok("profiles expose no email column", !!emailErr && !emailProbe, emailErr?.code);

  // posting
  const p1 = await q.createPost(ama, `hello ${tag}`);
  ok("create_post returns the new row", p1?.body === `hello ${tag}`);
  await rejects("empty post rejected through the API", () => q.createPost(ama, "  "), "22023");
  await rejects("anon cannot post", () => q.createPost(anon, "nope"));
  await rejects("media outside your folder rejected", () =>
    q.createPost(ama, "x", { media: [{ kind: "image", storage_path: `${ids.leo}/x.jpg`, mime_type: "image/jpeg" }] }), "permission-denied");
  const p2 = await q.createPost(ama, `with photo ${tag}`, { media: [{ kind: "image", storage_path: `${ids.ama}/p.jpg`, mime_type: "image/jpeg", width: 1200, height: 900 }] });

  // feed
  const feed = await q.fetchFeed(leo, "latest", 10, ids.leo);
  const mine = feed.posts.filter((p) => p.text.endsWith(tag));
  ok("latest feed returns posts with embedded author", mine.length === 2 && mine.every((p) => p.author.name === `ama ${tag}`));
  const photo = feed.posts.find((p) => p.id === p2.id);
  ok("media embedded with public URL and size", photo?.media[0]?.url.endsWith(`/storage/v1/object/public/post-media/${ids.ama}/p.jpg`) && photo.media[0].width === 1200);
  ok("feed is newest first", feed.posts.length < 2 || feed.posts[0].createdAt >= feed.posts[1].createdAt);
  const anonFeed = await q.fetchFeed(anon, "latest", 10, null);
  ok("anon can read the public feed", anonFeed.posts.some((p) => p.id === p1.id));
  const paged = await q.fetchFeed(leo, "latest", 1, ids.leo);
  ok("hasMore paging", paged.posts.length === 1 && paged.hasMore === true);

  // likes
  await q.setLike(leo, p1.id, true);
  await q.setLike(leo, p1.id, true);
  await q.setLike(zoe, p1.id, true);
  let post = await q.fetchPost(leo, p1.id, ids.leo);
  ok("like toggle idempotent, counted, likedByViewer", post.likeCount === 2 && post.likedByViewer === true);
  await q.setLike(leo, p1.id, false);
  post = await q.fetchPost(leo, p1.id, ids.leo);
  ok("unlike", post.likeCount === 1 && post.likedByViewer === false);
  const { error: forged } = await zoe.from("post_likes").insert({ user_id: ids.leo, post_id: p1.id });
  ok("cannot like as someone else", forged?.code === "42501", forged?.code);

  // replies
  await q.createPost(leo, `reply ${tag}`, { parentId: p1.id });
  const replies = await q.fetchReplies(zoe, p1.id);
  ok("replies listed with author", replies.length === 1 && replies[0].author.name === `leo ${tag}`);
  post = await q.fetchPost(zoe, p1.id, ids.zoe);
  ok("reply_count updated", post.replyCount === 1);
  const latestAfterReply = await q.fetchFeed(zoe, "latest", 50, ids.zoe);
  ok("replies are not in the home feed", !latestAfterReply.posts.some((p) => p.text === `reply ${tag}`));

  // follows + following feed + suggestions
  await q.follow(zoe, ids.zoe, ids.ama);
  await q.follow(zoe, ids.zoe, ids.ama); // duplicate is fine
  ok("following ids", (await q.fetchFollowingIds(zoe, ids.zoe)).has(ids.ama));
  const following = await q.fetchFeed(zoe, "following", 50, ids.zoe);
  ok("following feed = people you follow", following.posts.length >= 2 && following.posts.every((p) => p.author.id === ids.ama || p.author.id === ids.zoe));
  const leoFollowing = await q.fetchFeed(leo, "following", 50, ids.leo);
  ok("following feed empty when following nobody", leoFollowing.posts.every((p) => p.author.id === ids.leo));
  const sugg = await q.fetchSuggestions(zoe, 50);
  ok("suggestions skip self and followed", !sugg.some((s) => s.id === ids.zoe || s.id === ids.ama));
  await rejects("cannot follow on someone else's behalf", () => q.follow(zoe, ids.leo, ids.ama), "permission-denied");
  await q.unfollow(zoe, ids.zoe, ids.ama);
  ok("unfollow", !(await q.fetchFollowingIds(zoe, ids.zoe)).has(ids.ama));
  const { data: anonFollows, error: anonFollowErr } = await anon.from("follows").select("*");
  ok("anon cannot read the follow graph", !!anonFollowErr && !anonFollows, anonFollowErr?.code);

  // profile edits
  await q.updateDisplayName(ama, ids.ama, `Ama Renamed ${tag}`);
  ok("rename own profile", (await q.fetchProfile(leo, ids.ama)).display_name === `Ama Renamed ${tag}`);
  await q.updateDisplayName(leo, ids.ama, "hijack"); // RLS filters to zero rows
  ok("cannot rename someone else", (await q.fetchProfile(leo, ids.ama)).display_name === `Ama Renamed ${tag}`);
  const { error: counterErr } = await ama.from("profiles").update({ follower_count: 1e6 }).eq("id", ids.ama);
  ok("counters not writable through the API", counterErr?.code === "42501", counterErr?.code);

  // private surfaces
  const { error: legacyErr } = await ama.rpc("legacy_find_unmigrated_user", { p_email: "x@example.com" });
  ok("legacy lookup blocked for users", legacyErr?.code === "42501", legacyErr?.code);
  const { error: genErr } = await ama.rpc("generate_username", { seed: "x" });
  ok("internal helpers blocked", genErr?.code === "42501", genErr?.code);
} finally {
  await db.query("delete from auth.users where id = any($1)", [Object.values(ids)]);
  await db.end();
  await vite.close();
  proxy.close();
}

console.log(failures ? `\n${failures} API TEST(S) FAILED` : "\nALL API TESTS PASSED");
process.exit(failures ? 1 : 0);
