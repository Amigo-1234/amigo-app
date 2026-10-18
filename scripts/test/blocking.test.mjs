/**
 * Blocking across posts (migration 20261019130000) against a local PostgREST
 * on the Neon-built schema: after Ann blocks Ben, neither sees the other's
 * posts or replies, neither can reply to or like the other's posts, mentions
 * and likes don't notify, Ann's earlier notifications from Ben are hidden, and
 * a third person still sees both. Unblocking restores everything.
 *
 *   PGRST_URL=http://localhost:54331 JWT_SECRET=… DATABASE_URL=…/amigo_neon node scripts/test/blocking.test.mjs
 */
import { createHmac, randomUUID } from "node:crypto";
import pg from "pg";

const { PGRST_URL, JWT_SECRET, DATABASE_URL } = process.env;
if (!PGRST_URL || !JWT_SECRET || !DATABASE_URL) throw new Error("Set PGRST_URL, JWT_SECRET, DATABASE_URL");

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (sub) => {
  const h = b64({ alg: "HS256", typ: "JWT" }), b = b64({ exp: Math.floor(Date.now() / 1000) + 3600, sub, role: "authenticated" });
  return `${h}.${b}.${createHmac("sha256", JWT_SECRET).update(`${h}.${b}`).digest("base64url")}`;
};
const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();

let failures = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};
const call = async (token, fn, args = {}) => {
  const r = await fetch(`${PGRST_URL}/rpc/${fn}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(args) });
  const body = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, code: body?.code, body };
};
const read = (token, path) => fetch(`${PGRST_URL}/${path}`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
const postId = (r) => (typeof r.body === "string" ? r.body : r.body?.id ?? r.body?.[0]?.id ?? r.body);
const sees = async (token, id) => (await read(token, `posts?select=id&id=eq.${id}`)).length === 1;
const unread = async (token) => (await call(token, "unread_notification_count")).body;

const tag = randomUUID().slice(0, 6);
const ids = { ann: randomUUID(), ben: randomUUID(), cy: randomUUID() };
try {
  for (const [n, id] of Object.entries(ids)) {
    await db.query("insert into app_auth.users (id, email, email_confirmed_at) values ($1, $2, now())", [id, `block-${n}-${tag}@example.com`]);
    await db.query("update public.profiles set username = $2 where id = $1", [id, `${n}_${tag}`]);
  }
  const [ANN, BEN, CY] = [jwt(ids.ann), jwt(ids.ben), jwt(ids.cy)];

  let r = await call(ANN, "create_post", { p_body: "Ann's post" });
  ok("Ann posts", r.ok, JSON.stringify(r.body).slice(0, 120));
  const annPost = postId(r);
  r = await call(BEN, "create_post", { p_body: "Ben's post" });
  const benPost = postId(r);
  // Before the block: Ben likes and replies to Ann's post → Ann is notified.
  ok("before: Ben can like Ann's post", (await call(BEN, "set_post_like", { p_post_id: annPost, p_liked: true })).ok);
  r = await call(BEN, "create_post", { p_body: "Nice", p_parent_id: annPost });
  ok("before: Ben can reply", r.ok);
  const benReply = postId(r);
  const before = await unread(ANN);
  ok("before: Ann has notifications from Ben", before >= 2, String(before));

  ok("Ann blocks Ben", (await call(ANN, "dm_block", { p_user: ids.ben })).ok);

  ok("Ann no longer sees Ben's posts", !(await sees(ANN, benPost)));
  ok("…or Ben's reply in her thread", !(await sees(ANN, benReply)));
  ok("Ben no longer sees Ann's posts (two-way)", !(await sees(BEN, annPost)));
  ok("Ann still sees her own post", await sees(ANN, annPost));
  ok("a third person still sees both", (await sees(CY, annPost)) && (await sees(CY, benPost)) && (await sees(CY, benReply)));
  const feed = await call(ANN, "feed_posts", { p_scope: "latest", p_limit: 50 });
  ok("Ben's posts are gone from Ann's feed", feed.ok && !feed.body.some((p) => p.author_id === ids.ben), feed.ok ? "" : JSON.stringify(feed.body).slice(0, 120));
  ok("Ann's earlier notifications from Ben are hidden", (await unread(ANN)) === 0, String(await unread(ANN)));
  const likes = await read(ANN, `post_likes?select=user_id&post_id=eq.${annPost}`);
  ok("Ben's like isn't listed on Ann's post", Array.isArray(likes) && !likes.some((l) => l.user_id === ids.ben));

  r = await call(BEN, "create_post", { p_body: "reply", p_parent_id: annPost });
  ok("Ben can't reply to Ann's post", !r.ok);
  r = await call(ANN, "create_post", { p_body: "reply", p_parent_id: benPost });
  ok("…nor Ann to Ben's", !r.ok);
  await call(BEN, "set_post_like", { p_post_id: annPost, p_liked: false });
  r = await call(BEN, "set_post_like", { p_post_id: annPost, p_liked: true });
  ok("Ben can't like Ann's post", !r.ok);
  r = await call(BEN, "create_post", { p_body: `hey @ann_${tag}` });
  ok("Ben can still post to his own followers", r.ok);
  const { rows } = await db.query("select count(*)::int n from public.notifications where recipient_id = $1 and actor_id = $2 and kind = 'mention'", [ids.ann, ids.ben]);
  ok("a mention from Ben doesn't notify Ann", rows[0].n === 0, String(rows[0].n));

  ok("Ann unblocks Ben", (await call(ANN, "dm_unblock", { p_user: ids.ben })).ok);
  ok("after unblocking, they see each other's posts again", (await sees(ANN, benPost)) && (await sees(BEN, annPost)) && (await sees(ANN, benReply)));
  ok("…and Ben can reply again", (await call(BEN, "create_post", { p_body: "back", p_parent_id: annPost })).ok);
  ok("signed-out readers are unaffected", (await fetch(`${PGRST_URL}/posts?select=id&id=eq.${annPost}`).then((x) => x.json())).length === 1);
} catch (e) {
  failures++;
  console.error("error:", e);
} finally {
  await db.query("delete from public.posts where author_id = any($1)", [Object.values(ids)]).catch(() => undefined);
  await db.query("delete from app_auth.users where id = any($1)", [Object.values(ids)]).catch(() => undefined);
  await db.end();
}
console.log(failures ? `${failures} FAILED` : "ALL BLOCKING TESTS PASSED");
process.exit(failures ? 1 : 0);
