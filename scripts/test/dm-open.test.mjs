/**
 * Opening a conversation stays fast when many messages can't be decrypted on
 * this device (a phone added after they were sent): the missing keys are looked
 * for once per open, not once per message, and a refresh doesn't look again
 * unless new keys may have arrived. Local PostgREST on the Neon-built schema,
 * with the app's own messaging code and real crypto.
 *
 *   PGRST_URL=http://localhost:54331 JWT_SECRET=… DATABASE_URL=postgres://…/amigo_neon node scripts/test/dm-open.test.mjs
 */
import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { createServer } from "vite";

const { PGRST_URL, JWT_SECRET, DATABASE_URL } = process.env;
if (!PGRST_URL || !JWT_SECRET || !DATABASE_URL) throw new Error("Set PGRST_URL, JWT_SECRET and DATABASE_URL");
const N = 25;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims) => {
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims });
  return `${head}.${body}.${createHmac("sha256", JWT_SECRET).update(`${head}.${body}`).digest("base64url")}`;
};
// Counts calls per RPC (names only) on their way to PostgREST.
const calls = new Map();
const proxy = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const fn = req.url.match(/\/rpc\/([a-z0-9_]+)/)?.[1];
  if (fn) calls.set(fn, (calls.get(fn) ?? 0) + 1);
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !["host", "connection", "content-length"].includes(k)));
  const r = await fetch(PGRST_URL + req.url.replace(/^\/rest\/v1/, ""), { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
  res.writeHead(r.status, Object.fromEntries([...r.headers].filter(([k]) => k !== "content-encoding" && k !== "content-length")));
  res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise((ok) => proxy.listen(0, ok));
const baseUrl = `http://127.0.0.1:${proxy.address().port}`;
const asUser = (id) =>
  createClient(baseUrl, jwt({ role: "anonymous" }), { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${jwt({ sub: id, role: "authenticated" })}` } } });

const vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
const { createSupabaseMessages } = await vite.ssrLoadModule("/src/data/supabase/messages.ts");
const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();

let failures = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};
const oneShot = (_n, fetcher, sub) => {
  fetcher().then(sub.onData, sub.onError);
  return () => {};
};
const value = (subscribe) =>
  new Promise((resolve, reject) => {
    const stop = subscribe({ onData: (v, info) => !info?.cached && (resolve(v), stop?.()), onError: reject });
  });
const syncs = () => (calls.get("e2e_sync_state") ?? 0) + (calls.get("e2e_backup_current") ?? 0) + (calls.get("e2e_backup_get") ?? 0);

const tag = randomUUID().slice(0, 8);
const ids = { ana: randomUUID(), ben: randomUUID() };
try {
  for (const [name, id] of Object.entries(ids)) {
    await db.query("insert into app_auth.users (id, email, email_confirmed_at, raw_user_meta_data) values ($1, $2, now(), $3)", [id, `${name}-${tag}@example.com`, { display_name: `${name} ${tag}` }]);
  }
  const opts = { memoryStore: true, realtime: false };
  const A1 = createSupabaseMessages(asUser(ids.ana), oneShot, () => {}, opts);
  const B = createSupabaseMessages(asUser(ids.ben), oneShot, () => {}, opts);
  await A1.security.setup(ids.ana);
  await B.security.setup(ids.ben);
  const conv = await B.openConversation(ids.ben, ids.ana);
  for (let i = 0; i < N; i++) await B.send(ids.ben, conv, { text: `m${i}` });

  let t0 = performance.now();
  const v1 = await value((s) => A1.subscribeConversation(conv, ids.ana, s));
  ok("the device the messages were sent to reads them all", v1.messages.length === N && v1.messages.every((m) => !m.undecryptable), `${v1.messages.length}`);
  console.log(`info open on that device: ${Math.round(performance.now() - t0)} ms`);

  // A phone added afterwards: none of these keys were shared with it.
  const A2 = createSupabaseMessages(asUser(ids.ana), oneShot, () => {}, opts);
  await A2.security.setup(ids.ana);
  calls.clear();
  t0 = performance.now();
  const v2 = await value((s) => A2.subscribeConversation(conv, ids.ana, s));
  const coldMs = Math.round(performance.now() - t0);
  ok("a new device's conversation still opens (messages shown as can't-decrypt)", v2.messages.length === N && v2.messages.every((m) => m.undecryptable), `${v2.messages.length}`);
  ok(`missing keys looked for once for the whole conversation, not per message (${N} messages)`, syncs() <= 3, `${syncs()} key lookups, ${coldMs} ms`);
  calls.clear();
  t0 = performance.now();
  await value((s) => A2.subscribeConversation(conv, ids.ana, s));
  ok("refreshing doesn't look for the same missing keys again", syncs() === 0, `${syncs()} key lookups, ${Math.round(performance.now() - t0)} ms`);

  // By design, a device its owner hasn't approved gets no keys, even for new messages
  // (the app shows "Confirm it's you" on such a device before Messages).
  await B.security.setup(ids.ben);
  await B.send(ids.ben, conv, { text: "after" });
  const v3 = await value((s) => A2.subscribeConversation(conv, ids.ana, s));
  ok("an unapproved device still receives no keys (security rule unchanged)", v3.messages.at(-1)?.undecryptable === true);
} catch (e) {
  failures++;
  console.error("error:", e);
} finally {
  await db.query("delete from app_auth.users where id = any($1)", [Object.values(ids)]).catch(() => undefined);
  await db.end();
  await vite.close();
  proxy.close();
}
console.log(failures ? `${failures} FAILED` : "ALL CONVERSATION-OPEN TESTS PASSED");
process.exit(failures ? 1 : 0);
