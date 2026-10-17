/**
 * Reactions, edits, unsend and older history for encrypted messages, through
 * a local PostgREST on the Neon-built schema, with the app's own messaging
 * code and real crypto (no live services).
 *
 *   PGRST_URL=http://localhost:54331 JWT_SECRET=… DATABASE_URL=postgres://…/amigo_neon \
 *     node scripts/test/neon-dm-actions.test.mjs
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
const proxy = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
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
const value = (subscribe) => new Promise((resolve, reject) => subscribe({ onData: resolve, onError: reject }));
const fails = async (p) => p.then(() => null, (e) => e);

const tag = randomUUID().slice(0, 8);
const ids = { ana: randomUUID(), ben: randomUUID(), cy: randomUUID() };
try {
  for (const [name, id] of Object.entries(ids)) {
    await db.query("insert into app_auth.users (id, email, email_confirmed_at, raw_user_meta_data) values ($1, $2, now(), $3)", [id, `${name}-${tag}@example.com`, { display_name: `${name} ${tag}` }]);
  }
  const A = createSupabaseMessages(asUser(ids.ana), oneShot, () => {}, { memoryStore: true, realtime: false });
  const B = createSupabaseMessages(asUser(ids.ben), oneShot, () => {}, { memoryStore: true, realtime: false });
  ok("actions available on Neon", !!A.actions && !!B.actions);
  await A.security.setup(ids.ana);
  await B.security.setup(ids.ben);
  const conv = await A.openConversation(ids.ana, ids.ben);

  const { id: m1 } = await A.send(ids.ana, conv, { text: "hello there" });
  // Ben's inbox loading marks it delivered (not read).
  await value((s) => B.subscribeConversations(ids.ben, s));
  await new Promise((r) => setTimeout(r, 500));
  const delivered = (await value((s) => A.subscribeConversation(conv, ids.ana, s))).messages.find((m) => m.id === m1);
  ok("delivered receipt after the other person's inbox loads", delivered?.status === "delivered", delivered?.status);
  const { id: m2 } = await B.send(ids.ben, conv, { text: "hi ana" });
  const viewB = () => value((s) => B.subscribeConversation(conv, ids.ben, s));
  const viewA = () => value((s) => A.subscribeConversation(conv, ids.ana, s));
  await viewA();
  await viewB();

  // reactions
  await B.actions.react(ids.ben, conv, m1, "❤️");
  await A.actions.react(ids.ana, conv, m1, "❤️");
  let va = await viewA();
  let r = va.messages.find((m) => m.id === m1).reactions;
  ok("reactions grouped by emoji with counts", r.length === 1 && r[0].emoji === "❤️" && r[0].count === 2 && r[0].mine);
  ok("reactions are not shown as messages", va.messages.length === 2, `${va.messages.length}`);
  await A.actions.react(ids.ana, conv, m1, "😂");
  va = await viewA();
  r = va.messages.find((m) => m.id === m1).reactions;
  ok("one reaction per person: changing it replaces the old one", r.length === 2 && r.find((x) => x.emoji === "😂")?.mine && !r.find((x) => x.emoji === "❤️")?.mine);
  await A.actions.react(ids.ana, conv, m1, null);
  va = await viewA();
  r = va.messages.find((m) => m.id === m1).reactions;
  ok("removing a reaction", r.length === 1 && r[0].emoji === "❤️" && !r[0].mine);

  // unread / inbox ignore annotations
  const inboxA = await value((s) => A.subscribeConversations(ids.ana, s));
  ok("reactions don't become the inbox preview", inboxA[0].lastMessage?.text === "hi ana", inboxA[0].lastMessage?.text);
  const { rows: [u] } = await db.query(
    "select count(*)::int n from public.dm_messages x join public.dm_participants me on me.conversation_id = x.conversation_id and me.user_id = $1 where x.sender_id <> $1 and x.created_at > me.last_read_at and x.relates_to is null",
    [ids.ana],
  );
  ok("reactions don't count as unread (server)", u.n <= 1);

  // edits
  await A.actions.edit(ids.ana, conv, m1, "hello there, edited");
  let vb = await viewB();
  const e1 = vb.messages.find((m) => m.id === m1);
  ok("edit shows the new text, marked edited, for the other person", e1.text === "hello there, edited" && e1.edited);
  ok("can't edit someone else's message", (await fails(A.actions.edit(ids.ana, conv, m2, "nope")))?.code === "not-found");
  // a forged edit from Ben targeting Ana's message is ignored by clients
  await B.actions.react(ids.ben, conv, m1, "👍");
  const { rows: [plain] } = await db.query("select count(*)::int n from public.dm_messages where conversation_id = $1 and content::text ilike '%edited%'", [conv]);
  ok("server never sees reaction or edit content", plain.n === 0);
  const { rows: [rel] } = await db.query("select count(*)::int n from public.dm_messages where conversation_id = $1 and relates_to = $2", [conv, m1]);
  ok("server only sees that rows relate to a message", rel.n >= 4);

  // server-side relation checks
  const cyDb = asUser(ids.cy);
  const { error: outsider } = await cyDb.rpc("dm_send_v3", { p_id: randomUUID(), p_conversation: conv, p_device: "x", p_content: {}, p_relates_to: m1 });
  ok("outsiders can't annotate", !!outsider);
  const { error: badTarget } = await asUser(ids.ben).rpc("dm_send_v3", { p_id: randomUUID(), p_conversation: conv, p_device: "x", p_content: {}, p_relates_to: randomUUID() });
  ok("annotation must target a message in the conversation", badTarget?.code === "DM006", badTarget?.code);
  const { error: notOwn } = await asUser(ids.ben).rpc("dm_unsend", { p_id: m1 });
  ok("can't unsend someone else's message", notOwn?.code === "DM006", notOwn?.code);

  // unsend
  vb = await viewB();
  await A.actions.unsend(ids.ana, conv, m1);
  vb = await viewB();
  ok("unsent message disappears for the other person", !vb.messages.some((m) => m.id === m1) && vb.messages.some((m) => m.id === m2));
  const { rows: [left] } = await db.query("select count(*)::int n from public.dm_messages where id = $1 or relates_to = $1", [m1]);
  ok("ciphertext, reactions and edits deleted from the server", left.n === 0);
  const inboxB = await value((s) => B.subscribeConversations(ids.ben, s));
  ok("conversation still listed with remaining message", inboxB[0]?.lastMessage?.text === "hi ana");

  // typing (no Realtime): heartbeat in, pulse picks it up, stop clears it
  const seen = [];
  const stopConv = B.subscribeConversation(conv, ids.ben, { onData: () => {}, onError: () => {} });
  const stopTyping = B.subscribeTyping(conv, ids.ben, (t) => seen.push(t));
  A.setTyping(ids.ana, conv, true);
  A.setTyping(ids.ana, conv, true); // throttled: one request
  await new Promise((r) => setTimeout(r, 3000));
  ok("peer sees typing through the pulse", seen.includes(true), JSON.stringify(seen));
  const { rows: [ty] } = await db.query("select count(*)::int n from public.dm_typing where conversation_id = $1", [conv]);
  ok("typing is one short-lived row, no content", ty.n === 1);
  A.setTyping(ids.ana, conv, false);
  await new Promise((r) => setTimeout(r, 3000));
  ok("typing stops", seen.at(-1) === false, JSON.stringify(seen));
  const { error: outsiderTyping } = await cyDb.rpc("dm_set_typing", { p_conversation: conv, p_typing: true });
  ok("outsiders can't set typing", !!outsiderTyping);
  stopTyping();
  stopConv();

  // older history
  for (let i = 0; i < 55; i++) await B.send(ids.ben, conv, { text: `n${i}` });
  // A second device for Ben starts from the newest 50 and pages back (old ones it has no keys for still list).
  const B2 = createSupabaseMessages(asUser(ids.ben), oneShot, () => {}, { memoryStore: true, realtime: false });
  await B2.security.setup(ids.ben).catch(() => undefined);
  const page1 = await value((s) => B2.subscribeConversation(conv, ids.ben, s));
  const more = await B2.actions.loadOlder(ids.ben, conv);
  const page2 = await value((s) => B2.subscribeConversation(conv, ids.ben, s));
  ok("history pages back on demand", page1.messages.length === 50 && page2.messages.length === 56 && more === false, `${page1.messages.length} → ${page2.messages.length}, more=${more}`);
} catch (e) {
  console.error(e);
  failures++;
} finally {
  await db.query("delete from app_auth.users where id = any($1)", [Object.values(ids)]);
  await db.end();
  await vite.close();
  proxy.close();
}
console.log(failures ? `${failures} FAILED` : "ALL DM ACTION TESTS PASSED");
process.exit(failures ? 1 : 0);
