/**
 * Web Push (api/push-notify.ts, migration 20261019110000) against a local
 * PostgREST on the Neon-built schema. Push services are simulated by
 * intercepting requests to their hosts; each captured push is decrypted the
 * way a browser does (RFC 8291) and its VAPID signature verified (RFC 8292).
 *
 *   PGRST_URL=http://localhost:54331 JWT_SECRET=… DATABASE_URL=…/amigo_neon node scripts/test/push.test.mjs
 */
import { createHash, createHmac, randomUUID, webcrypto as wc } from "node:crypto";
import pg from "pg";
import { createServer } from "vite";

const { PGRST_URL, JWT_SECRET, DATABASE_URL } = process.env;
if (!PGRST_URL || !JWT_SECRET || !DATABASE_URL) throw new Error("Set PGRST_URL, JWT_SECRET, DATABASE_URL");
const subtle = wc.subtle;
const b64u = (b) => Buffer.from(b).toString("base64url");

// Our server's VAPID key and secret (test values only).
const vapidPair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const vapidPublic = new Uint8Array(await subtle.exportKey("raw", vapidPair.publicKey));
const vapidJwk = await subtle.exportKey("jwk", vapidPair.privateKey);
const SECRET = `test-${randomUUID()}`;
Object.assign(process.env, {
  NEON_REST_URL_OVERRIDE: PGRST_URL,
  VAPID_PUBLIC_KEY: b64u(vapidPublic),
  VAPID_PRIVATE_KEY: vapidJwk.d,
  VAPID_SUBJECT: "https://amigo.test",
  PUSH_SERVER_SECRET: SECRET,
});

// Simulated push services: record what they receive.
const received = [];
const goneEndpoints = new Set();
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  if (/^https:\/\/(fcm\.googleapis\.com|web\.push\.apple\.com|updates\.push\.services\.mozilla\.com)\//.test(url)) {
    received.push({ url, headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])), body: new Uint8Array(init.body) });
    return new Response(null, { status: goneEndpoints.has(url) ? 410 : 201 });
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
const configFn = (await vite.ssrLoadModule("/api/push-config.ts")).default;
const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();

let failures = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};
const rest = (token, fn, args) =>
  realFetch(`${PGRST_URL}/rpc/${fn}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(args) });
const push = (token, conversationId) =>
  notify(new Request("http://app.test/api/push-notify", { method: "POST", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, body: JSON.stringify({ conversationId }) }));

/** A browser-side subscription: its ECDH key pair and auth secret. */
async function browser(host) {
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  const auth = wc.getRandomValues(new Uint8Array(16));
  const endpoint = `https://${host}/${host.startsWith("fcm") ? "fcm/send/" : ""}${randomUUID()}`;
  return { pair, pub, auth, endpoint, p256dh: b64u(pub), authB64: b64u(auth) };
}

/** RFC 8291 decryption, as the browser does it. */
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
  if (plain[plain.length - 1] !== 2) throw new Error("bad padding delimiter");
  return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
}

async function verifyVapid(header, endpoint) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(header ?? "");
  if (!m) return false;
  const [h, c, s] = m[1].split(".");
  const claims = JSON.parse(Buffer.from(c, "base64url"));
  const key = await subtle.importKey("raw", Buffer.from(m[2], "base64url"), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const valid = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, Buffer.from(s, "base64url"), new TextEncoder().encode(`${h}.${c}`));
  return valid && m[2] === b64u(vapidPublic) && claims.aud === new URL(endpoint).origin && claims.exp > Date.now() / 1000 && claims.sub === "https://amigo.test";
}

const ids = { a: randomUUID(), b: randomUUID(), c: randomUUID() };
try {
  for (const [n, id] of Object.entries(ids)) await db.query("insert into app_auth.users (id, email, email_confirmed_at) values ($1, $2, now())", [id, `push-${n}-${id.slice(0, 6)}@example.com`]);
  const [A, B, C] = [jwt(ids.a), jwt(ids.b), jwt(ids.c)];
  await db.query("insert into public.push_server (id, key_hash) values (1, $1) on conflict (id) do update set key_hash = excluded.key_hash", [createHash("sha256").update(SECRET).digest("hex")]);

  const cfg = await configFn(new Request("http://app.test/api/push-config"));
  ok("the public key is served to browsers", cfg.status === 200 && (await cfg.json()).publicKey === b64u(vapidPublic));

  // B subscribes two devices; C one.
  const b1 = await browser("fcm.googleapis.com");
  const b2 = await browser("web.push.apple.com");
  const c1 = await browser("updates.push.services.mozilla.com");
  for (const [tok, br, label] of [[B, b1, "Android · Chrome"], [B, b2, "iPhone · Safari"], [C, c1, "Firefox"]]) {
    const r = await rest(tok, "push_subscribe", { p_endpoint: br.endpoint, p_p256dh: br.p256dh, p_auth: br.authB64, p_label: label });
    ok(`device subscribes (${label})`, r.ok, String(r.status));
  }
  let r = await rest(B, "push_subscribe", { p_endpoint: "https://evil.example.com/collect", p_p256dh: b1.p256dh, p_auth: b1.authB64 });
  ok("endpoints outside known push services are refused", !r.ok);
  r = await realFetch(`${PGRST_URL}/push_subscriptions?select=endpoint`, { headers: { authorization: `Bearer ${B}` } });
  ok("endpoints and keys can't be read back by the app", !r.ok);
  r = await realFetch(`${PGRST_URL}/push_subscriptions?select=id,label`, { headers: { authorization: `Bearer ${B}` } });
  const mine = await r.json();
  ok("you see your own devices only (labels)", r.ok && mine.length === 2 && mine.every((d) => d.label));

  // A ↔ B conversation; C is an outsider.
  const conv = randomUUID();
  await db.query("insert into public.dm_conversations (id, direct_key) values ($1, $2)", [conv, [ids.a, ids.b].sort().join(":")]);
  await db.query("insert into public.dm_participants (conversation_id, user_id) values ($1, $2), ($1, $3)", [conv, ids.a, ids.b]);
  const ciphertext = { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "AwgAEn…secret-ciphertext", session_id: "s1", sender_key: "k", device_id: "D" };
  const sendAs = (uid) => db.query("insert into public.dm_messages (conversation_id, sender_id, sender_device_id, content) values ($1, $2, 'D', $3)", [conv, uid, ciphertext]);

  r = await push(A, conv);
  ok("no push without a new message from the caller", r.status === 200 && (await r.json()).sent === 0 && received.length === 0);

  await sendAs(ids.a);
  r = await rest(A, "push_message_targets", { p_key: "guess", p_conversation: conv });
  ok("the app can't ask for push targets itself (server secret required)", !r.ok);
  r = await push(A, conv);
  const res1 = await r.json();
  ok("a new message pushes to each of the recipient's devices", r.status === 200 && res1.sent === 2 && received.length === 2, JSON.stringify(res1));
  const toB1 = received.find((x) => x.url === b1.endpoint);
  ok("push is encrypted for the device (aes128gcm)", toB1?.headers["content-encoding"] === "aes128gcm");
  const payload = await decrypt(b1, toB1.body);
  ok("decrypted payload says only 'new message' + conversation", JSON.stringify(payload) === JSON.stringify({ t: "dm", c: conv }), JSON.stringify(payload));
  ok("no ciphertext, text or names leave in the push", !Buffer.from(toB1.body).toString("latin1").includes("secret-ciphertext") && !JSON.stringify(payload).includes("push-a"));
  ok("signed with our VAPID key for that push service", await verifyVapid(toB1.headers.authorization, b1.endpoint));
  ok("collapses per conversation (Topic) and is urgent", toB1.headers.topic === conv.replace(/-/g, "") && toB1.headers.urgency === "high");
  ok("the outsider's device got nothing", !received.some((x) => x.url === c1.endpoint));

  await sendAs(ids.a);
  r = await push(A, conv);
  ok("at most one push per conversation every 15 seconds", (await r.json()).sent === 0 && received.length === 2);

  r = await push(C, conv);
  ok("an outsider can't trigger pushes into a conversation", (await r.json()).sent === 0 && received.length === 2);
  ok("signed-out calls refused", (await push(null, conv)).status === 401);

  // Preferences and blocking.
  await db.query("update public.push_rate set last_at = now() - interval '1 minute'");
  await rest(B, "set_notification_prefs", { p_messages: false });
  await sendAs(ids.a);
  r = await push(A, conv);
  ok("no push when the recipient turned message pushes off", (await r.json()).sent === 0);
  await rest(B, "set_notification_prefs", { p_messages: true });
  await db.query("insert into public.user_blocks (blocker_id, blocked_id) values ($1, $2)", [ids.b, ids.a]);
  r = await push(A, conv);
  ok("no push from someone you blocked", (await r.json()).sent === 0);
  await db.query("delete from public.user_blocks where blocker_id = $1", [ids.b]);

  // A device that no longer exists is forgotten.
  goneEndpoints.add(b2.endpoint);
  await db.query("update public.push_rate set last_at = now() - interval '1 minute'");
  await sendAs(ids.a);
  r = await push(A, conv);
  ok("delivers again after the quiet period", (await r.json()).sent === 1);
  const left = await db.query("select endpoint from public.push_subscriptions where user_id = $1", [ids.b]);
  ok("expired subscriptions are removed", left.rows.length === 1 && left.rows[0].endpoint === b1.endpoint);

  // "Send a test notification": your own devices only, rate-limited.
  const before = received.length;
  r = await notify(new Request("http://app.test/api/push-notify", { method: "POST", headers: { authorization: `Bearer ${B}`, "content-type": "application/json" }, body: JSON.stringify({ test: true }) }));
  const test1 = await r.json();
  const testPush = received.slice(before);
  ok("a test notification goes to your own devices only", test1.sent === 1 && testPush.length === 1 && testPush[0].url === b1.endpoint);
  ok("…and says only that notifications work", JSON.stringify(await decrypt(b1, testPush[0].body)) === JSON.stringify({ t: "test" }));
  r = await notify(new Request("http://app.test/api/push-notify", { method: "POST", headers: { authorization: `Bearer ${B}`, "content-type": "application/json" }, body: JSON.stringify({ test: true }) }));
  ok("test notifications are rate-limited", (await r.json()).sent === 0 && received.length === before + 1);

  // A device removed from the list isn't brought back by the app starting on it.
  r = await rest(B, "push_touch", { p_endpoint: b1.endpoint });
  ok("a registered device is recognised at startup", (await r.json()) === true);
  const ghost = await browser("fcm.googleapis.com");
  r = await rest(B, "push_touch", { p_endpoint: ghost.endpoint });
  ok("a removed (or never added) device isn't re-added at startup", (await r.json()) === false && (await db.query("select 1 from public.push_subscriptions where endpoint = $1", [ghost.endpoint])).rowCount === 0);

  // Unsubscribe; the same browser signing in as someone else moves to them.
  await rest(B, "push_unsubscribe", { p_endpoint: b1.endpoint });
  ok("unsubscribing removes the device", (await db.query("select 1 from public.push_subscriptions where endpoint = $1", [b1.endpoint])).rowCount === 0);
  await rest(B, "push_subscribe", { p_endpoint: c1.endpoint, p_p256dh: c1.p256dh, p_auth: c1.authB64 });
  const moved = await db.query("select user_id from public.push_subscriptions where endpoint = $1", [c1.endpoint]);
  ok("a browser that signs in as someone else now notifies them, not the previous account", moved.rows[0]?.user_id === ids.b);
} catch (e) {
  failures++;
  console.error("error:", e);
} finally {
  await db.query("delete from app_auth.users where id = any($1)", [Object.values(ids)]).catch(() => undefined);
  await db.query("delete from public.push_server").catch(() => undefined);
  await db.end();
  await vite.close();
}
console.log(failures ? `${failures} FAILED` : "ALL PUSH TESTS PASSED");
process.exit(failures ? 1 : 0);
