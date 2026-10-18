/**
 * Activity pushes (migration 20261019140000, api/_activity.ts) against a local
 * PostgREST on the Neon-built schema, with simulated push services: likes
 * (on posts and on replies), replies, mentions, follows and Support Hub
 * support reach the right person's devices once, grouped, without post text;
 * blocking, the "likes, replies and follows" switch and undone likes are
 * respected; Support Hub support also shows in the app.
 *
 *   PGRST_URL=http://localhost:54331 JWT_SECRET=… DATABASE_URL=…/amigo_neon node scripts/test/activity-push.test.mjs
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
  if (url.startsWith("https://fcm.googleapis.com/") || url.startsWith("https://web.push.apple.com/")) {
    received.push({ url, body: new Uint8Array(init.body) });
    return new Response(null, { status: 201 });
  }
  return realFetch(input, init);
};

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (sub) => {
  const h = b64({ alg: "HS256", typ: "JWT" }), b = b64({ exp: Math.floor(Date.now() / 1000) + 3600, sub, role: "authenticated" });
  return `${h}.${b}.${createHmac("sha256", JWT_SECRET).update(`${h}.${b}`).digest("base64url")}`;
};
const vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
const notify = (await vite.ssrLoadModule("/api/push-notify.ts")).default;
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
  return { ok: r.ok, body: await r.json().catch(() => null) };
};
const flush = async (token) => (await notify(new Request("http://app.test/api/push-notify", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ activity: true }) }))).json();

async function browser(host) {
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  const auth = wc.getRandomValues(new Uint8Array(16));
  return { pair, pub, auth, endpoint: `https://${host}/${host.startsWith("fcm") ? "fcm/send/" : ""}${randomUUID()}`, p256dh: b64u(pub), authB64: b64u(auth) };
}
async function decrypt(b, body) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);
  const asKey = await subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: asKey }, b.pair.privateKey, 256));
  const hk = async (s, ikm, info, n) => new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: s, info }, await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), n * 8));
  const te = new TextEncoder();
  const ikm = await hk(b.auth, shared, Buffer.concat([te.encode("WebPush: info\0"), b.pub, asPublic]), 32);
  const cek = await hk(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hk(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const plain = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: nonce }, await subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]), ciphertext));
  return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
}
/** Pushes received by one device since the last call, decrypted. */
async function take(dev) {
  const mine = received.filter((r) => r.url === dev.endpoint);
  for (const m of mine) received.splice(received.indexOf(m), 1);
  return Promise.all(mine.map((m) => decrypt(dev, m.body)));
}
const age = (minutes) => db.query("update public.notifications set created_at = now() - make_interval(mins => $1) where pushed_at is null", [minutes]);
const clearRate = () => db.query("delete from public.push_rate");

const tag = randomUUID().slice(0, 6);
const ids = { ann: randomUUID(), ben: randomUUID(), cy: randomUUID(), dee: randomUUID() };
try {
  for (const [n, id] of Object.entries(ids)) {
    await db.query("insert into app_auth.users (id, email, email_confirmed_at) values ($1, $2, now())", [id, `act-${n}-${tag}@example.com`]);
    await db.query("update public.profiles set username = $2, display_name = $3 where id = $1", [id, `${n}_${tag}`, `${n[0].toUpperCase()}${n.slice(1)} Test`]);
  }
  await db.query("insert into public.push_server (id, key_hash) values (1, $1) on conflict (id) do update set key_hash = excluded.key_hash", [createHash("sha256").update(SECRET).digest("hex")]);
  // Notifications from earlier tests must not be pushed into this run.
  await db.query("update public.notifications set pushed_at = coalesce(pushed_at, now())");
  const [ANN, BEN, CY, DEE] = [ids.ann, ids.ben, ids.cy, ids.dee].map(jwt);
  const phone = await browser("fcm.googleapis.com");
  const ipad = await browser("web.push.apple.com");
  for (const d of [phone, ipad]) ok("Ann's device subscribes", (await call(ANN, "push_subscribe", { p_endpoint: d.endpoint, p_p256dh: d.p256dh, p_auth: d.authB64, p_label: "test" })).ok);
  const benPhone = await browser("fcm.googleapis.com");
  await call(BEN, "push_subscribe", { p_endpoint: benPhone.endpoint, p_p256dh: benPhone.p256dh, p_auth: benPhone.authB64, p_label: "test" });

  const secretText = `private words ${tag}`;
  const post = (await call(ANN, "create_post", { p_body: secretText })).body.id;

  // Like → one push to each of Ann's devices.
  await call(BEN, "set_post_like", { p_post_id: post, p_liked: true });
  let res = await flush(BEN);
  let got = await take(phone);
  ok("a like is pushed to the post's author", got.length === 1 && got[0].t === "act" && got[0].k === "like" && got[0].p === post && got[0].n === 1, JSON.stringify(got));
  ok("…on every device they turned notifications on", (await take(ipad)).length === 1, String(res.sent));
  ok("the push names who did it, never the post's text", got[0]?.a === "Ben Test" && !JSON.stringify(got).includes(secretText));
  ok("the actor gets nothing", (await take(benPhone)).length === 0);
  await flush(CY);
  ok("each notification is pushed once (a second flush sends nothing)", (await take(phone)).length === 0);

  // A burst on another post → one grouped push.
  const post2 = (await call(ANN, "create_post", { p_body: "second" })).body.id;
  for (const t of [BEN, CY, DEE]) await call(t, "set_post_like", { p_post_id: post2, p_liked: true });
  await flush(DEE);
  got = await take(phone);
  ok("several likes at once become one push ('… and 2 others')", got.length === 1 && got[0].n === 3 && got[0].a === "Dee Test", JSON.stringify(got));

  // Reply, then a like on Ann's own reply.
  await call(BEN, "create_post", { p_body: "nice one", p_parent_id: post });
  await flush(BEN);
  got = await take(phone);
  ok("a reply is pushed", got.length === 1 && got[0].k === "reply", JSON.stringify(got));
  const annReply = (await call(ANN, "create_post", { p_body: "thanks", p_parent_id: post })).body.id;
  await call(CY, "set_post_like", { p_post_id: annReply, p_liked: true });
  await flush(CY);
  got = await take(phone);
  ok("a like on your reply says so ('liked your reply')", got.length === 1 && got[0].k === "like" && got[0].x === true && got[0].p === annReply, JSON.stringify(got));

  // Mention and follow.
  await call(DEE, "create_post", { p_body: `hey @ann_${tag}` });
  await realFetch(`${PGRST_URL}/follows`, { method: "POST", headers: { authorization: `Bearer ${CY}`, "content-type": "application/json" }, body: JSON.stringify({ follower_id: ids.cy, followee_id: ids.ann }) });
  await flush(DEE);
  got = await take(phone);
  ok("a mention and a follow are pushed", got.some((g) => g.k === "mention") && got.some((g) => g.k === "follow"), JSON.stringify(got.map((g) => g.k)));

  // Undone before the push went out: nothing.
  const post3 = (await call(ANN, "create_post", { p_body: "third" })).body.id;
  await call(BEN, "set_post_like", { p_post_id: post3, p_liked: true });
  await call(BEN, "set_post_like", { p_post_id: post3, p_liked: false });
  await flush(BEN);
  ok("a like undone before the push goes out isn't pushed", (await take(phone)).length === 0);

  // Blocked after acting: nothing.
  await call(DEE, "set_post_like", { p_post_id: post3, p_liked: true });
  await call(ANN, "dm_block", { p_user: ids.dee });
  await flush(BEN);
  ok("no push between people who've blocked each other", (await take(phone)).length === 0);
  await call(ANN, "dm_unblock", { p_user: ids.dee });

  // The switch in Settings.
  await call(ANN, "set_notification_prefs", { p_social: false });
  await call(CY, "set_post_like", { p_post_id: post3, p_liked: true });
  await flush(CY);
  ok("turning off 'Likes, replies and follows' stops these pushes", (await take(phone)).length === 0);
  await call(ANN, "set_notification_prefs", { p_social: true });

  // Rate limit: a second like on the same post within a minute stays in the app.
  await clearRate();
  const post4 = (await call(ANN, "create_post", { p_body: "fourth" })).body.id;
  await call(BEN, "set_post_like", { p_post_id: post4, p_liked: true });
  await flush(BEN);
  await call(CY, "set_post_like", { p_post_id: post4, p_liked: true });
  await flush(CY);
  got = await take(phone);
  ok("at most one push per post a minute (the rest are in the app)", got.length === 1, String(got.length));

  // Old notifications are never pushed late.
  const post5 = (await call(ANN, "create_post", { p_body: "fifth" })).body.id;
  await call(DEE, "set_post_like", { p_post_id: post5, p_liked: true });
  await age(45);
  await flush(DEE);
  ok("notifications older than 30 minutes aren't pushed late", (await take(phone)).length === 0);

  // Support Hub: confirmed support → in-app notification + push.
  const { rows: [req] } = await db.query(
    "insert into public.support_requests (creator_id, title, description, url, category, ask, target, status) values ($1, 'My new song', 'Please give it a listen', 'https://example.com/song', 'music', 'listen', 10, 'active') returning id",
    [ids.ann],
  );
  await db.query("insert into public.support_visits (request_id, user_id, opened_at) values ($1, $2, now() - interval '5 minutes')", [req.id, ids.ben]);
  await clearRate();
  const confirmed = await call(BEN, "confirm_support", { p_request: req.id });
  ok("someone supports Ann's request", confirmed.ok, JSON.stringify(confirmed.body).slice(0, 120));
  const inApp = await realFetch(`${PGRST_URL}/notifications?select=kind,request_id&kind=eq.support`, { headers: { authorization: `Bearer ${ANN}` } }).then((r) => r.json());
  ok("Support Hub support shows in Ann's notifications", inApp.length === 1 && inApp[0].request_id === req.id, JSON.stringify(inApp));
  // The 5-minute check any signed-in app makes also sends what's pending.
  const tick = await (await tickFn(new Request("http://app.test/api/worlds-tick", { method: "POST", headers: { authorization: `Bearer ${CY}` } }))).json();
  got = await take(phone);
  ok("…and is pushed (here by another app's periodic check)", got.length === 1 && got[0].k === "support" && got[0].r === req.id, JSON.stringify({ tick, got }));
  ok("the app can't read push targets itself", !(await call(ANN, "push_activity_targets", { p_key: "guess" })).ok);
} catch (e) {
  failures++;
  console.error("error:", e);
} finally {
  await db.query("delete from public.posts where author_id = any($1)", [Object.values(ids)]).catch(() => undefined);
  await db.query("delete from app_auth.users where id = any($1)", [Object.values(ids)]).catch(() => undefined);
  await db.query("delete from public.push_server").catch(() => undefined);
  await db.query("delete from public.push_rate").catch(() => undefined);
  await db.end();
  await vite.close();
}
console.log(failures ? `${failures} FAILED` : "ALL ACTIVITY PUSH TESTS PASSED");
process.exit(failures ? 1 : 0);
