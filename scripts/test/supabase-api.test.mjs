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

  // profiles (Phase 3)
  const amaHandle = (await q.fetchProfile(leo, ids.ama)).username;
  let profile = await q.fetchProfileByHandle(leo, amaHandle.toUpperCase(), ids.leo);
  ok("profile by handle is case-insensitive", profile?.id === ids.ama && profile.isViewer === false);
  ok("profile has counts and join date", profile.postCount === 2 && profile.joinedAt instanceof Date);
  ok("unknown handle → null", (await q.fetchProfileByHandle(leo, `nobody_${tag}`, ids.leo)) === null);
  await q.follow(leo, ids.leo, ids.ama);
  profile = await q.fetchProfileByHandle(leo, amaHandle, ids.leo);
  ok("viewerFollows + followerCount", profile.viewerFollows === true && profile.followerCount === 1);
  ok("own profile isViewer", (await q.fetchProfileByHandle(ama, amaHandle, ids.ama)).isViewer === true);

  const amaPosts = await q.fetchProfilePosts(leo, ids.ama, ids.leo, "posts", 10);
  ok("posts tab: top-level only, newest first", amaPosts.posts.length === 2 && amaPosts.posts.every((x) => !x.replyTo));
  const leoReplies = await q.fetchProfilePosts(ama, ids.leo, ids.ama, "replies", 10);
  ok("replies tab: replies with 'replying to' handle", leoReplies.posts.length === 1 && leoReplies.posts[0].replyTo?.handle === amaHandle);
  const amaMedia = await q.fetchProfilePosts(leo, ids.ama, ids.leo, "media", 10);
  ok("media tab: only posts with media", amaMedia.posts.length === 1 && amaMedia.posts[0].media.length === 1);
  const paged2 = await q.fetchProfilePosts(leo, ids.ama, ids.leo, "posts", 1);
  ok("profile paging", paged2.posts.length === 1 && paged2.hasMore === true);

  const amaFollowers = await q.fetchFollowList(zoe, ids.ama, "followers", ids.zoe);
  ok("followers list with viewer follow state", amaFollowers.length === 1 && amaFollowers[0].id === ids.leo && amaFollowers[0].viewerFollows === false);
  const leoFollowingList = await q.fetchFollowList(zoe, ids.leo, "following", ids.zoe);
  ok("following list", leoFollowingList.length === 1 && leoFollowingList[0].id === ids.ama);

  ok("own handle counts as available", await q.isHandleAvailable(ama, amaHandle, ids.ama));
  ok("someone else's handle is taken", !(await q.isHandleAvailable(leo, amaHandle, ids.leo)));
  await rejects("rename to a taken handle", () => q.updateProfileRow(leo, ids.leo, { username: amaHandle }), "handle-taken");
  await rejects("invalid handle format", () => q.updateProfileRow(leo, ids.leo, { username: "Bad Name" }), "handle-invalid");
  await rejects("over-long bio is not reported as a username problem", () => q.updateProfileRow(leo, ids.leo, { bio: "x".repeat(161) }), "unknown");
  await q.updateProfileRow(leo, ids.leo, { username: `leo_${tag}`, bio: "Hiking." });
  ok("rename + bio saved", (await q.fetchProfileByHandle(ama, `leo_${tag}`, ids.ama))?.bio === "Hiking.");
  await q.updateProfileRow(zoe, ids.leo, { bio: "hijacked" }); // RLS filters to zero rows
  ok("cannot edit someone else's profile", (await q.fetchProfileByHandle(ama, `leo_${tag}`, ids.ama))?.bio === "Hiking.");

  // discovery (Phase 4)
  const zoeHandle = (await q.fetchProfile(leo, ids.zoe)).username;
  let people = await q.searchPeople(leo, zoeHandle.slice(0, 5).toUpperCase(), ids.leo, 10);
  ok("people search by username prefix, case-insensitive", people.some((x) => x.id === ids.zoe));
  people = await q.searchPeople(leo, `zoe ${tag}`, ids.leo, 10);
  ok("people search by display name", people.length === 1 && people[0].id === ids.zoe && typeof people[0].bio === "string");
  people = await q.searchPeople(leo, `@${zoeHandle}`, ids.leo, 10);
  ok("leading @ ignored", people[0]?.id === ids.zoe);
  people = await q.searchPeople(leo, `Ama Renamed ${tag}`, ids.leo, 10);
  ok("search reflects profile edits and follow state", people[0]?.id === ids.ama && people[0].viewerFollows === true);
  ok("'%' is literal, not match-all", (await q.searchPeople(leo, "%", ids.leo, 10)).length === 0);
  ok("'_' is literal", (await q.searchPeople(leo, "_x_x_", ids.leo, 10)).length === 0);
  ok("commas/parentheses don't break the filter", (await q.searchPeople(leo, "a,b(c)", ids.leo, 10)).length === 0);

  const hits = await q.searchPosts(zoe, tag, ids.zoe, { order: "latest", limit: 20 });
  ok("post text search incl. replies", hits.posts.length === 3 && hits.posts.some((x) => x.replyTo));
  ok("latest order", hits.posts[0].createdAt >= hits.posts[1].createdAt);
  const topHits = await q.searchPosts(zoe, tag, ids.zoe, { order: "top", limit: 20 });
  ok("top order = most liked first", topHits.posts[0].likeCount >= topHits.posts[1].likeCount);
  const mediaHits = await q.searchPosts(zoe, tag, ids.zoe, { order: "latest", mediaOnly: true, limit: 20 });
  ok("media-only search", mediaHits.posts.length === 1 && mediaHits.posts[0].media.length === 1);
  ok("search paging", (await q.searchPosts(zoe, tag, ids.zoe, { order: "latest", limit: 1 })).hasMore === true);
  ok("no matches → empty", (await q.searchPosts(zoe, `nothing_${tag}`, ids.zoe, { order: "latest", limit: 5 })).posts.length === 0);
  ok("blank query → empty without a request", (await q.searchPosts(zoe, "   ", ids.zoe, { order: "latest", limit: 5 })).posts.length === 0);

  const ex = await q.fetchExplore(zoe, ids.zoe);
  ok("explore: suggestions exclude self", ex.suggestedPeople.every((x) => x.id !== ids.zoe));
  ok("explore: popular this week (7-day window)", ex.popular.windowDays === 7 && ex.popular.posts.length > 0);
  ok("explore: conversations only have replies", ex.conversations.length > 0 && ex.conversations.every((x) => x.replyCount > 0));
  ok("explore: media only has media", ex.media.every((x) => x.media.length > 0));
  const { error: anonSugg } = await anon.rpc("suggested_profiles", { p_limit: 3 });
  ok("suggestions are for signed-in people only", anonSugg?.code === "42501", anonSugg?.code);

  // multi-image posts (Phase 5)
  const m = (n, w, h) => ({ kind: "image", storage_path: `${ids.ama}/multi-${tag}-${n}.jpg`, mime_type: "image/jpeg", width: w, height: h, byte_size: 1000 + n });
  const multiPost = await q.createPost(ama, `three photos ${tag}`, { media: [m(1, 1080, 1350), m(2, 1600, 900), m(3, 1000, 1000)] });
  ok("create_post returns the new id", typeof multiPost.id === "string");
  const readBack = await q.fetchPost(leo, multiPost.id, ids.leo);
  ok("media come back in composer order with dimensions",
    JSON.stringify(readBack.media.map((x) => `${x.width}x${x.height}`)) === JSON.stringify(["1080x1350", "1600x900", "1000x1000"]) &&
    readBack.media.every((x, i) => x.url.endsWith(`multi-${tag}-${i + 1}.jpg`)));
  const inFeed = (await q.fetchFeed(leo, "latest", 50, ids.leo)).posts.find((x) => x.id === multiPost.id);
  ok("multi-image post in the feed with all media", inFeed?.media.length === 3);
  const inMedia = (await q.fetchProfilePosts(leo, ids.ama, ids.leo, "media", 20)).posts.find((x) => x.id === multiPost.id);
  ok("multi-image post on Profile Media with all media", inMedia?.media.length === 3);
  await rejects("5 images rejected (schema allows 4)", () => q.createPost(ama, "too many", { media: [1, 2, 3, 4, 5].map((n) => m(10 + n, 10, 10)) }), "unknown");
  await rejects("image-only post needs no text", async () => { await q.createPost(ama, "", { media: [m(20, 800, 800)] }); throw Object.assign(new Error("ok"), { code: "accepted" }); }, "accepted");

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
