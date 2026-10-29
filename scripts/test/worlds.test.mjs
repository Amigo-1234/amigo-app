/**
 * Worlds server rules (migrations 20261006160000 + 20261019120000) against a
 * local PostgREST on the Neon-built schema: admin create/edit/cancel and their
 * fairness rules, joining, posting, chat, server-timed "live" notices and their
 * pushes (api/worlds-tick.ts, push services simulated), Amigo picks, chat
 * moderation, and the server clock.
 *
 *   PGRST_URL=http://localhost:54331 JWT_SECRET=… DATABASE_URL=…/amigo_neon node scripts/test/worlds.test.mjs
 */
import { createHash, createHmac, randomUUID, webcrypto as wc } from "node:crypto";
import pg from "pg";
import { createServer } from "vite";

const { PGRST_URL, JWT_SECRET, DATABASE_URL } = process.env;
if (!PGRST_URL || !JWT_SECRET || !DATABASE_URL) throw new Error("Set PGRST_URL, JWT_SECRET, DATABASE_URL");
const subtle = wc.subtle;
const b64u = (b) => Buffer.from(b).toString("base64url");

const vapidPair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const SECRET = `test-${randomUUID()}`;
Object.assign(process.env, {
  NEON_REST_URL_OVERRIDE: PGRST_URL,
  VAPID_PUBLIC_KEY: b64u(new Uint8Array(await subtle.exportKey("raw", vapidPair.publicKey))),
  VAPID_PRIVATE_KEY: (await subtle.exportKey("jwk", vapidPair.privateKey)).d,
  VAPID_SUBJECT: "https://amigo.test",
  PUSH_SERVER_SECRET: SECRET,
});
const received = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.startsWith("https://fcm.googleapis.com/")) {
    received.push({ url, body: new Uint8Array(init.body) });
    return new Response(null, { status: 201 });
  }
  return realFetch(input, init);
};

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (sub, role = "authenticated") => {
  const h = b64({ alg: "HS256", typ: "JWT" }), b = b64({ exp: Math.floor(Date.now() / 1000) + 3600, ...(sub ? { sub } : {}), role });
  return `${h}.${b}.${createHmac("sha256", JWT_SECRET).update(`${h}.${b}`).digest("base64url")}`;
};
const vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
const tickFn = (await vite.ssrLoadModule("/api/worlds-tick.ts")).default;
const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();

let failures = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};
const call = async (token, fn, args = {}) => {
  const r = await realFetch(`${PGRST_URL}/rpc/${fn}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(args) });
  const body = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, code: body?.code, body };
};
const rest = (token, path, init = {}) =>
  realFetch(`${PGRST_URL}/${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", prefer: "return=minimal", ...(init.headers ?? {}) } });
const tick = (token) => tickFn(new Request("http://app.test/api/worlds-tick", { method: "POST", headers: { authorization: `Bearer ${token}` } }));
const iso = (ms) => new Date(Date.now() + ms).toISOString();

const ids = { admin: randomUUID(), ann: randomUUID(), ben: randomUUID(), cy: randomUUID() };
const slug = `test-world-${randomUUID().slice(0, 8)}`;
try {
  for (const [n, id] of Object.entries(ids)) await db.query("insert into app_auth.users (id, email, email_confirmed_at) values ($1, $2, now())", [id, `worlds-${n}-${id.slice(0, 6)}@example.com`]);
  await db.query("insert into public.app_admins (user_id, note) values ($1, 'worlds test')", [ids.admin]);
  await db.query("insert into public.push_server (id, key_hash) values (1, $1) on conflict (id) do update set key_hash = excluded.key_hash", [createHash("sha256").update(SECRET).digest("hex")]);
  const [ADMIN, ANN, BEN, CY] = [jwt(ids.admin), jwt(ids.ann), jwt(ids.ben), jwt(ids.cy)];

  // ------------------------------------------------ server clock
  const t = await call(jwt(null, "anonymous"), "server_now");
  ok("server time is available to everyone", t.ok && Math.abs(new Date(t.body).getTime() - Date.now()) < 5000, String(t.status));

  // ------------------------------------------------ create
  const base = { slug, title: "Test Jam", tagline: "A test", description: "", startsAt: iso(3600_000), endsAt: iso(3 * 3600_000), competition: true, entriesCloseAt: iso(2 * 3600_000), entryLimit: 1, pointsReaction: 1, pointsReply: 2, pointsHostPick: 10 };
  let r = await call(ANN, "admin_create_world", { p: base });
  ok("only admins can create Worlds", !r.ok && r.code === "42501");
  r = await call(ADMIN, "admin_create_world", { p: { ...base, endsAt: iso(1800_000) } });
  ok("a World must end after it starts", !r.ok && r.code === "AW011", r.code);
  r = await call(ADMIN, "admin_create_world", { p: { ...base, entriesCloseAt: iso(5 * 3600_000) } });
  ok("entries must close within the World", !r.ok && r.code === "AW011", r.code);
  r = await call(ADMIN, "admin_create_world", { p: base });
  const wid = r.body;
  ok("an admin creates a World", r.ok && /^[0-9a-f-]{36}$/.test(wid), JSON.stringify(r.body));
  r = await call(ADMIN, "admin_create_world", { p: base });
  ok("links are unique", !r.ok && r.code === "AW010");
  const audit = await db.query("select count(*)::int as n from public.admin_audit_log where target_id = $1 and action = 'world.create'", [wid]);
  ok("creating is audit-logged", audit.rows[0].n === 1);

  // ------------------------------------------------ join before start, can't post yet
  ok("people join an upcoming World", (await rest(ANN, "world_members", { method: "POST", body: JSON.stringify({ world_id: wid, user_id: ids.ann }) })).ok);
  ok("…and another", (await rest(BEN, "world_members", { method: "POST", body: JSON.stringify({ world_id: wid, user_id: ids.ben }) })).ok);
  r = await call(ANN, "create_world_post", { p_world_id: wid, p_body: "too early" });
  ok("no posting before it starts", !r.ok && r.code === "AW001", r.code);

  // ------------------------------------------------ edits before start
  r = await call(ADMIN, "admin_update_world", { p_id: wid, p: { pointsReaction: 3, title: "Test Jam 2" } });
  ok("before the start, an admin can change the rules", r.ok);
  r = await call(ANN, "admin_update_world", { p_id: wid, p: { title: "hacked" } });
  ok("non-admins can't edit", !r.ok && r.code === "42501");

  // ------------------------------------------------ it starts (on the server's clock)
  await db.query("update public.worlds set starts_at = now() - interval '1 minute' where id = $1", [wid]);
  let before = await call(ANN, "unread_notification_count");
  r = await tick(ANN);
  const t1 = await r.json();
  ok("the first app to tick after the start opens it (no admin needed)", r.status === 200 && t1.started === 1, JSON.stringify(t1));
  const notices = await db.query("select recipient_id, kind from public.world_notices where world_id = $1 order by recipient_id", [wid]);
  ok("every member gets a 'live' notice", notices.rows.length === 2 && notices.rows.every((n) => n.kind === "live"));
  r = await tick(BEN);
  ok("ticking again does nothing (idempotent)", (await r.json()).started === 0);
  let after = await call(ANN, "unread_notification_count");
  ok("the notice counts in the badge", after.body === before.body + 1, `${before.body} → ${after.body}`);
  r = await call(CY, "world_push_targets", { p_key: "guess" });
  ok("the app can't ask for World push targets (server secret)", !r.ok);
  const noticeRows = await rest(ANN, `world_notices?select=kind,world_id`).then((x) => x.json());
  ok("you see your own notices only", noticeRows.length === 1 && noticeRows[0].world_id === wid);
  await call(ANN, "mark_world_notices_read");
  after = await call(ANN, "unread_notification_count");
  ok("notices can be marked read", after.body === before.body);

  // Pushes for a fresh notice reach members with push on (simulated push service).
  const pushPair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pushPub = new Uint8Array(await subtle.exportKey("raw", pushPair.publicKey));
  const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
  await call(BEN, "push_subscribe", { p_endpoint: endpoint, p_p256dh: b64u(pushPub), p_auth: b64u(wc.getRandomValues(new Uint8Array(16))), p_label: "test" });
  await db.query("update public.world_notices set pushed_at = null where world_id = $1", [wid]);
  r = await tick(BEN);
  const t2 = await r.json();
  ok("members with notifications on get a push that it's live", t2.pushed === 1 && received.length === 1 && received[0].url === endpoint, JSON.stringify(t2));
  r = await tick(BEN);
  ok("each notice is pushed once", (await r.json()).pushed === 0 && received.length === 1);

  // ------------------------------------------------ live: posting, entries, chat, fairness
  r = await call(CY, "create_world_post", { p_world_id: wid, p_body: "not a member" });
  ok("non-members can't post", !r.ok && r.code === "AW002");
  r = await call(ANN, "create_world_post", { p_world_id: wid, p_body: "my entry", p_entry: true });
  const entry = r.body?.id;
  ok("members submit an entry while entries are open", r.ok && !!entry, r.code);
  r = await call(ANN, "create_world_post", { p_world_id: wid, p_body: "second", p_entry: true });
  ok("the entry limit holds", !r.ok && r.code === "AW004");
  ok("members chat while it's live", (await rest(BEN, "world_chat_messages", { method: "POST", body: JSON.stringify({ world_id: wid, author_id: ids.ben, body: "hello room" }) })).ok);
  r = await call(ADMIN, "admin_update_world", { p_id: wid, p: { pointsReaction: 50 } });
  ok("after the start, scoring is fixed", !r.ok && r.code === "AW014", r.code);
  r = await call(ADMIN, "admin_update_world", { p_id: wid, p: { startsAt: iso(-7200_000) } });
  ok("…and so is the start", !r.ok && r.code === "AW014");
  r = await call(ADMIN, "admin_update_world", { p_id: wid, p: { endsAt: iso(-60_000) } });
  ok("the end can't move into the past", !r.ok && r.code === "AW015");
  r = await call(ADMIN, "admin_update_world", { p_id: wid, p: { endsAt: iso(4 * 3600_000), tagline: "Extended" } });
  ok("the end can be extended while live", r.ok);

  // ------------------------------------------------ picks and leaderboard
  await call(BEN, "set_post_like", { p_post_id: entry, p_liked: true });
  r = await call(ANN, "admin_set_host_pick", { p_world: wid, p_post: entry, p_picked: true });
  ok("only admins make Amigo picks", !r.ok && r.code === "42501");
  r = await call(ADMIN, "admin_set_host_pick", { p_world: wid, p_post: entry, p_picked: true });
  ok("an admin picks an entry", r.ok);
  const board = await call(BEN, "world_leaderboard", { p_world_id: wid });
  ok("the leaderboard adds the like (×3) and the pick bonus (10)", board.ok && board.body[0]?.user_id === ids.ann && board.body[0]?.points === 13, JSON.stringify(board.body));

  // ------------------------------------------------ chat moderation
  const msg = (await db.query("select id from public.world_chat_messages where world_id = $1 limit 1", [wid])).rows[0].id;
  r = await call(ANN, "admin_remove_world_chat", { p_message: msg });
  ok("non-admins can't remove chat messages", !r.ok);
  r = await call(ADMIN, "admin_remove_world_chat", { p_message: msg });
  ok("an admin removes a chat message", r.ok && (await db.query("select 1 from public.world_chat_messages where id = $1", [msg])).rowCount === 0);

  // ------------------------------------------------ cancel
  r = await call(ADMIN, "admin_cancel_world", { p_id: wid, p_reason: "Venue problem" });
  ok("an admin cancels the World", r.ok);
  const cancelled = await db.query("select count(*)::int as n from public.world_notices where world_id = $1 and kind = 'cancelled'", [wid]);
  ok("members are told it was cancelled", cancelled.rows[0].n === 2);
  r = await tick(BEN);
  ok("…by push too", (await r.json()).pushed === 1 && received.length === 2);
  ok("no joining a cancelled World", !(await rest(CY, "world_members", { method: "POST", body: JSON.stringify({ world_id: wid, user_id: ids.cy }) })).ok);
  r = await call(BEN, "create_world_post", { p_world_id: wid, p_body: "still here?" });
  ok("no posting in a cancelled World", !r.ok && r.code === "AW006", r.code);
  ok("no chat in a cancelled World", !(await rest(BEN, "world_chat_messages", { method: "POST", body: JSON.stringify({ world_id: wid, author_id: ids.ben, body: "hi" }) })).ok);
  r = await call(ADMIN, "admin_update_world", { p_id: wid, p: { title: "again" } });
  ok("cancelled Worlds can't be edited", !r.ok && r.code === "AW013");
  r = await call(ADMIN, "admin_cancel_world", { p_id: wid, p_reason: "" });
  ok("…or cancelled twice", !r.ok && r.code === "AW013");
  const row = await rest(CY, `worlds?select=cancelled_at,cancel_reason&id=eq.${wid}`).then((x) => x.json());
  ok("everyone sees that it was cancelled and why", !!row[0]?.cancelled_at && row[0].cancel_reason === "Venue problem");
} catch (e) {
  failures++;
  console.error("error:", e);
} finally {
  await db.query("delete from public.worlds where slug = $1", [slug]).catch(() => undefined);
  await db.query("delete from app_auth.users where id = any($1)", [Object.values(ids)]).catch(() => undefined);
  await db.query("delete from public.push_server").catch(() => undefined);
  await db.end();
  await vite.close();
}
console.log(failures ? `${failures} FAILED` : "ALL WORLDS TESTS PASSED");
process.exit(failures ? 1 : 0);
