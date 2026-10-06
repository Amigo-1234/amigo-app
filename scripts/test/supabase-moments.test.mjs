/**
 * Moments through the app's Supabase layer (src/data/supabase/moments.ts)
 * and a real PostgREST, as real users: audiences, seen state, reactions,
 * viewers, expiry, deleting, reporting and admin removal.
 *
 * Needs: a database with the migrations applied (local shim is fine) and a
 * PostgREST pointing at it. Creates throwaway users and removes them after.
 *
 *   PGRST_URL=http://localhost:54330 JWT_SECRET=… DATABASE_URL=… \
 *     node scripts/test/supabase-api.test.mjs
 *
 * Storage (photo upload / signed URLs) isn't available locally; the database
 * rules for photos are covered by supabase/tests/database.test.sql.
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
const { createSupabaseMoments } = await vite.ssrLoadModule("/src/data/supabase/moments.ts");

const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();

const anonKey = jwt({ role: "anon" });
const asUser = (id) =>
  createClient(baseUrl, anonKey, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${jwt({ sub: id, role: "authenticated" })}` } } });

let failures = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};
const code = async (fn) => { try { await fn(); return null; } catch (e) { return e.code ?? e.message; } };
const oneShot = (name, fetcher, sub) => { fetcher().then(sub.onData, sub.onError); return () => {}; };
const value = (subscribe) => new Promise((resolve, reject) => subscribe({ onData: resolve, onError: reject }));

const tag = randomUUID().slice(0, 8);
const ids = { ama: randomUUID(), leo: randomUUID(), zoe: randomUUID(), boss: randomUUID() };
try {
  for (const [name, id] of Object.entries(ids)) {
    await db.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)", [id, `${name}-${tag}@example.com`, { display_name: `${name} ${tag}` }]);
  }
  await db.query("insert into public.follows (follower_id, followee_id) values ($1, $2)", [ids.leo, ids.ama]);
  await db.query("insert into public.app_admins (user_id, note) values ($1, 'test')", [ids.boss]);
  const m = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, createSupabaseMoments(asUser(id), oneShot, () => {})]));
  const me = (k) => ({ id: ids[k], name: k, handle: k, email: null, avatarUrl: null });
  const feed = (k) => value((sub) => m[k].api.subscribeFeed(ids[k], sub));

  ok("empty Moment rejected", (await code(() => m.ama.api.create(me("ama"), { text: " ", background: "coral", audience: "everyone" }))) === "empty");
  const pub = await m.ama.api.create(me("ama"), { text: `hello ${tag}`, background: "ocean", audience: "everyone" });
  await m.ama.api.create(me("ama"), { text: `followers ${tag}`, background: "night", audience: "followers" });
  const own = await feed("ama");
  ok("author's own group first, both Moments, oldest first", own[0].isViewer && own[0].moments.length === 2 && own[0].moments[0].text === `hello ${tag}`);
  ok("expires 24h after posting", own[0].moments[0].expiresAt - own[0].moments[0].createdAt === 24 * 3600 * 1000);
  const leoFeed = await feed("leo");
  const amaAtLeo = leoFeed.find((g) => g.author.id === ids.ama);
  ok("follower sees both, unseen, with the author's profile", amaAtLeo?.moments.length === 2 && amaAtLeo.hasUnseen && amaAtLeo.author.name === `ama ${tag}`);
  ok("non-follower sees only the public one", (await feed("zoe")).find((g) => g.author.id === ids.ama)?.moments.length === 1);
  ok("others don't get view counts", amaAtLeo.moments[0].viewCount === undefined);

  await m.leo.api.markSeen(ids.leo, pub.id);
  await m.leo.api.react(ids.leo, pub.id, "🔥");
  await m.zoe.api.react(ids.zoe, pub.id, "❤️");
  const leoAfter = (await feed("leo")).find((g) => g.author.id === ids.ama).moments[0];
  ok("seen + reaction reflected for the viewer", leoAfter.seen && leoAfter.viewerReaction === "🔥");
  const ownAfter = (await feed("ama"))[0].moments[0];
  ok("author sees how many have seen it", ownAfter.viewCount === 2);
  const viewers = await m.ama.api.viewers(ids.ama, pub.id);
  ok("author lists viewers with names and reactions", viewers.length === 2 && viewers.map((v) => v.reaction).sort().join("") === "❤️🔥" && viewers.every((v) => v.person.name.endsWith(tag)));
  ok("only the author can list viewers", (await code(() => m.leo.api.viewers(ids.leo, pub.id))) === "not-allowed");
  ok("can't react to your own", (await code(() => m.ama.api.react(ids.ama, pub.id, "❤️"))) === "not-allowed");

  await m.zoe.api.report(ids.zoe, pub.id, { reason: "spam", note: "test" });
  ok("non-admins can't list reports", (await code(() => m.leo.admin.listReports(ids.leo))) === "not-admin");
  const reports = await m.boss.admin.listReports(ids.boss);
  const rep = reports.find((r) => r.moment?.id === pub.id);
  ok("admin sees the reported Moment with its author", rep && rep.moment.text === `hello ${tag}` && rep.moment.author.id === ids.ama && rep.reporter.id === ids.zoe);
  await m.boss.admin.remove(ids.boss, pub.id, "test removal");
  ok("removed Moment gone for viewers", !(await feed("leo")).find((g) => g.author.id === ids.ama)?.moments.some((x) => x.id === pub.id));
  const { rows: [audit] } = await db.query("select summary from public.admin_audit_log where action = 'moment.remove' order by created_at desc limit 1");
  ok("removal audit-logged", audit?.summary.includes("test removal"));

  const fol = (await feed("ama"))[0].moments.find((x) => x.audience === "followers");
  ok("someone else can't delete it", (await code(() => m.leo.api.delete(ids.leo, fol.id))) === "not-allowed");
  await db.query("update public.moments set expires_at = now() - interval '1 minute' where id = $1", [fol.id]);
  ok("expired Moment disappears", !(await feed("leo")).some((g) => g.author.id === ids.ama));
  await db.query("update public.moments set expires_at = now() + interval '1 hour' where id = $1", [fol.id]);
  await m.ama.api.delete(ids.ama, fol.id);
  ok("author deletes their own Moment", !(await feed("ama")).some((g) => g.isViewer));
} catch (e) {
  failures++;
  console.error("FAIL (exception)", e);
} finally {
  await db.query("delete from auth.users where id = any($1)", [Object.values(ids)]);
  await db.end();
  await vite.close();
  proxy.close();
}
console.log(failures ? `${failures} FAILED` : "ALL MOMENTS TESTS PASSED");
process.exit(failures ? 1 : 0);
