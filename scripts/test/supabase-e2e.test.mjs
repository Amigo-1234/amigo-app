/**
 * End-to-end encryption test for direct messages, through a real PostgREST
 * with the migrations applied (local shim is fine), as real users.
 *
 * Runs real crypto devices (the app's src/data/supabase/e2e.ts on top of
 * @matrix-org/matrix-sdk-crypto-wasm): Ama on a phone and a laptop, Leo on
 * one device, Zoë as an outsider. Proves messages decrypt for the right
 * devices only and that the database never holds message plaintext.
 *
 *   PGRST_URL=http://localhost:54330 JWT_SECRET=… DATABASE_URL=… \
 *     node scripts/test/supabase-e2e.test.mjs
 *
 * Storage isn't available locally, so attachments use an in-memory bucket.
 */
import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import * as sdk from "@matrix-org/matrix-sdk-crypto-wasm";
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
const { E2EDevice, newDeviceId } = await vite.ssrLoadModule("/src/data/supabase/e2e.ts");
const { createSupabaseMessages } = await vite.ssrLoadModule("/src/data/supabase/messages.ts");

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

// Everything that ever crossed to the server, to scan for plaintext afterwards.
const wire = [];
const bucket = new Map();
const backendFor = (client) => ({
  async rpc(fn, args) {
    wire.push(JSON.stringify(args));
    const { data, error } = await client.rpc(fn, args);
    if (error) throw Object.assign(new Error(error.message), { code: error.code });
    return data;
  },
  async fetchToDevice(deviceId) {
    const { data, error } = await client.from("e2e_to_device").select("id, sender_id, event_type, content").eq("recipient_device", deviceId).order("id");
    if (error) throw new Error(error.message);
    return data;
  },
  async uploadAttachment(path, bytes) {
    wire.push(Buffer.from(bytes).toString("latin1"));
    bucket.set(path, bytes);
  },
  async downloadAttachment(path) {
    return bucket.get(path);
  },
});

const tag = randomUUID().slice(0, 8);
const ids = { ama: randomUUID(), leo: randomUUID(), zoe: randomUUID() };
const SECRET = `meet me at the old bridge at nine 🌉 ${tag}`;
const REPLY = `see you there ${tag}`;
const LATER = `new device test ${tag}`;

async function send(device, client, conversationId, peerId, payload) {
  const content = await device.encrypt(conversationId, peerId, payload);
  const { data, error } = await client.rpc("dm_send", { p_conversation: conversationId, p_device: device.deviceId, p_content: content });
  if (error) throw new Error(error.message);
  return data[0].id;
}
async function rows(client, conversationId) {
  const { data, error } = await client.from("dm_messages").select("id, conversation_id, sender_id, content, created_at").eq("conversation_id", conversationId).order("created_at");
  if (error) throw new Error(error.message);
  return data;
}

try {
  for (const [name, id] of Object.entries(ids)) {
    await db.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)", [id, `${name}-${tag}@example.com`, { display_name: `${name} ${tag}` }]);
  }
  const ama = asUser(ids.ama), leo = asUser(ids.leo), zoe = asUser(ids.zoe);

  const start = (userId, client) => E2EDevice.start({ crypto: sdk, backend: backendFor(client), userId, deviceId: newDeviceId() });
  const amaPhone = await start(ids.ama, ama);
  const amaLaptop = await start(ids.ama, ama);
  const leoPhone = await start(ids.leo, leo);
  const zoeDevice = await start(ids.zoe, zoe);

  const { rows: devs } = await db.query("select user_id, device_keys from public.e2e_devices where user_id = any($1)", [Object.values(ids)]);
  ok("each device published its public keys", devs.length === 4);
  ok("published device keys hold only public keys + signatures",
    devs.every((d) => Object.keys(d.device_keys).sort().join() === "algorithms,device_id,keys,signatures,user_id"));
  const { rows: [otk] } = await db.query("select count(*)::int as n from public.e2e_one_time_keys where user_id = $1", [ids.ama]);
  ok("one-time keys published", otk.n > 0, `${otk.n}`);

  const { data: conversationId } = await ama.rpc("dm_open", { p_peer: ids.leo });

  // Ama (phone) → Leo
  const firstId = await send(amaPhone, ama, conversationId, ids.leo, { msgtype: "m.text", body: SECRET, "amigo.reply_to": null });
  const stored = await rows(leo, conversationId);
  ok("stored message is a Megolm envelope", stored[0].content.algorithm === "m.megolm.v1.aes-sha2" && typeof stored[0].content.ciphertext === "string");
  const atLeo = await leoPhone.decrypt(stored[0]);
  ok("Leo's device decrypts it", atLeo.ok && atLeo.payload.body === SECRET && !atLeo.senderMismatch);
  const atLaptop = await amaLaptop.decrypt(stored[0]);
  ok("Ama's other device decrypts it too (multi-device)", atLaptop.ok && atLaptop.payload.body === SECRET);

  // Leo replies; the reply relation stays inside the ciphertext
  await send(leoPhone, leo, conversationId, ids.ama, { msgtype: "m.text", body: REPLY, "amigo.reply_to": firstId });
  const both = await rows(ama, conversationId);
  const reply = await amaPhone.decrypt(both[1]);
  ok("Ama decrypts Leo's reply, with the reply relation inside", reply.ok && reply.payload.body === REPLY && reply.payload["amigo.reply_to"] === firstId);
  ok("reply relation isn't visible to the server", !JSON.stringify(both[1]).includes(firstId));

  // Outsiders
  const { data: zoeRows } = await zoe.from("dm_messages").select("id").eq("conversation_id", conversationId);
  ok("outsider can't even read the ciphertext rows", (zoeRows ?? []).length === 0);
  const zoeTry = await zoeDevice.decrypt(stored[0]);
  ok("a device that wasn't given the key can't decrypt a leaked ciphertext", !zoeTry.ok);

  // A server that lies
  const forged = { ...stored[0], sender_id: ids.leo };
  const asForged = await amaLaptop.decrypt(forged);
  ok("server-forged sender is detected", !asForged.ok || asForged.senderMismatch, JSON.stringify({ ok: asForged.ok, mismatch: asForged.senderMismatch }));
  const c = stored[0].content.ciphertext;
  const tampered = { ...stored[0], content: { ...stored[0].content, ciphertext: c.slice(0, 40) + (c[40] === "A" ? "B" : "A") + c.slice(41) } };
  ok("tampered ciphertext is rejected", !(await leoPhone.decrypt(tampered)).ok);
  const moved = { ...stored[0], conversation_id: randomUUID() };
  ok("ciphertext replayed into another conversation is rejected", !(await leoPhone.decrypt(moved)).ok);

  // Photos: encrypted bytes in the bucket, key inside the message
  const photo = new Uint8Array(4096).map((_, i) => (i * 7) % 251);
  const enc = amaPhone.encryptAttachment(photo);
  const path = `${conversationId}/${randomUUID()}`;
  await backendFor(ama).uploadAttachment(path, enc.data);
  await send(amaPhone, ama, conversationId, ids.leo, { msgtype: "m.image", body: "", "amigo.image": { path, info: enc.info, width: 64, height: 64, mimetype: "image/jpeg" } });
  const third = (await rows(leo, conversationId))[2];
  const img = await leoPhone.decrypt(third);
  const bytes = img.ok && leoPhone.decryptAttachment(await backendFor(leo).downloadAttachment(img.payload["amigo.image"].path), img.payload["amigo.image"].info);
  ok("encrypted photo round-trips", bytes && Buffer.compare(Buffer.from(bytes), Buffer.from(photo)) === 0);
  ok("uploaded photo bytes are not the original", Buffer.compare(Buffer.from(enc.data), Buffer.from(photo)) !== 0);
  ok("photo key never sent outside the ciphertext", !wire.some((w) => w.includes(JSON.parse(enc.info).key.k)));

  // A brand-new device: no history (no key backup yet), but new messages work
  const amaTablet = await start(ids.ama, ama);
  const oldOnTablet = await amaTablet.decrypt(stored[0]);
  ok("a new device can't read messages sent before it existed (documented: no key backup yet)", !oldOnTablet.ok && oldOnTablet.reason === "missing-key");
  await send(leoPhone, leo, conversationId, ids.ama, { msgtype: "m.text", body: LATER });
  const latest = (await rows(ama, conversationId)).at(-1);
  const onTablet = await amaTablet.decrypt(latest);
  ok("…but it reads messages sent after it was added", onTablet.ok && onTablet.payload.body === LATER);

  // Plaintext never reached the database or the wire
  const { rows: dump } = await db.query(`
    select (select coalesce(json_agg(m), '[]') from public.dm_messages m)::text
        || (select coalesce(json_agg(t), '[]') from public.e2e_to_device t)::text
        || (select coalesce(json_agg(d), '[]') from public.e2e_devices d)::text
        || (select coalesce(json_agg(k), '[]') from public.e2e_one_time_keys k)::text
        || (select coalesce(json_agg(p), '[]') from public.dm_participants p)::text as all_rows`);
  for (const secret of [SECRET, REPLY, LATER, "old bridge"]) {
    ok(`database holds no plaintext: “${secret.slice(0, 18)}…”`, !dump[0].all_rows.includes(secret));
    ok(`nothing sent to the server contained it`, !wire.some((w) => w.includes(secret)));
  }
  ok("to-device mail was all Olm-encrypted", wire.filter((w) => w.includes('"p_event_type":"m.room.encrypted"')).every((w) => !w.includes("session_key")));

  // Keys are replenished after being claimed
  await amaPhone.refresh();
  const { rows: [left] } = await db.query("select count(*)::int as n from public.e2e_one_time_keys where user_id = $1 and not fallback", [ids.ama]);
  ok("one-time keys topped up after use", left.n > 0, `${left.n}`);

  // The app's MessagesApi (src/data/supabase/messages.ts) end to end, as the UI uses it
  const oneShot = (name, fetcher, sub) => { fetcher().then(sub.onData, sub.onError); return () => {}; };
  const value = (subscribe) => new Promise((resolve, reject) => subscribe({ onData: resolve, onError: reject }));
  const appAma = createSupabaseMessages(ama, oneShot, () => {}, { memoryStore: true });
  const appLeo = createSupabaseMessages(leo, oneShot, () => {}, { memoryStore: true });
  ok("app layer reports real encryption", appAma.encryption === "e2e");
  const { data: zoeConv } = await zoe.rpc("dm_open", { p_peer: ids.leo });
  // Both apps register their device in the background via the unread badge (as after sign-in).
  await value((sub) => appAma.subscribeUnreadCount(ids.ama, sub));
  await value((sub) => appLeo.subscribeUnreadCount(ids.leo, sub));
  await new Promise((r) => setTimeout(r, 1500));
  const nobody = randomUUID();
  await db.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, '{}')", [nobody, `nodevice-${tag}@example.com`]);
  ids.nobody = nobody;
  const noDevConv = await appAma.openConversation(ids.ama, nobody);
  let noDevErr = null;
  try { await appAma.send(ids.ama, noDevConv, { text: "anyone?" }); } catch (e) { noDevErr = e; }
  ok("sending to someone with no messaging device is refused (not silently unreadable)", noDevErr?.code === "peer-unavailable");
  const convId = await appAma.openConversation(ids.ama, ids.leo);
  ok("openConversation reuses the pair's conversation", convId === conversationId);
  const APP = `app layer secret ${tag}`;
  await appAma.send(ids.ama, convId, { text: APP });
  const leoView = await value((sub) => appLeo.subscribeConversation(convId, ids.leo, sub));
  const lastAtLeo = leoView.messages.at(-1);
  ok("recipient's app shows the decrypted text", lastAtLeo.text === APP && !lastAtLeo.fromViewer);
  const leoInbox = await value((sub) => appLeo.subscribeConversations(ids.leo, sub));
  const row = leoInbox.find((c) => c.id === convId);
  ok("inbox preview is decrypted on the device; unread counted", row.lastMessage.text === APP && row.unreadCount >= 1 && row.peer.id === ids.ama);
  ok("unread badge counts conversations", (await value((sub) => appLeo.subscribeUnreadCount(ids.leo, sub))) >= 1);
  await appLeo.markRead(ids.leo, convId);
  const amaView = await value((sub) => appAma.subscribeConversation(convId, ids.ama, sub));
  ok("sender sees Read after the recipient opens it", amaView.messages.at(-1).status === "read");
  await appLeo.send(ids.leo, convId, { text: `re ${tag}`, replyToId: lastAtLeo.id });
  const amaView2 = await value((sub) => appAma.subscribeConversation(convId, ids.ama, sub));
  ok("reply quote resolved on the device", amaView2.messages.at(-1).replyTo?.id === lastAtLeo.id && amaView2.messages.at(-1).replyTo.text === APP);
  ok("history from before this app device existed shows as undecryptable, not as text", amaView2.messages[0].undecryptable === true && amaView2.messages[0].text === "");
  await appLeo.block(ids.leo, ids.ama);
  let blockedErr = null;
  try { await appAma.send(ids.ama, convId, { text: "hello?" }); } catch (e) { blockedErr = e; }
  ok("blocked: send refused with MessageError(blocked)", blockedErr?.code === "blocked");
  await appLeo.unblock(ids.leo, ids.ama);
  await appLeo.report(ids.leo, convId, { reason: "spam", note: "test", messageIds: [lastAtLeo.id] });
  const { rows: [rep] } = await db.query("select evidence from public.dm_reports where reporter_id = $1 order by created_at desc limit 1", [ids.leo]);
  ok("report evidence is the text the reporter's device decrypted", rep.evidence[0]?.text === APP);
  const { rows: [scan] } = await db.query("select count(*)::int as n from public.dm_messages where content::text like $1", [`%${APP}%`]);
  ok("app-layer messages stored as ciphertext only", scan.n === 0);
  ok("outsider's empty conversation is separate", zoeConv !== convId);

  // Signing out a device removes its keys
  await amaTablet.forget();
  const { rows: [gone] } = await db.query("select count(*)::int as n from public.e2e_devices where user_id = $1", [ids.ama]);
  ok("signed-out device removed from the key directory", gone.n === 3);
} catch (e) {
  failures++;
  console.error("FAIL (exception)", e);
} finally {
  await db.query("delete from auth.users where id = any($1)", [Object.values(ids)]);
  await db.end();
  await vite.close();
  proxy.close();
}
console.log(failures ? `${failures} FAILED` : "ALL E2E TESTS PASSED");
process.exit(failures ? 1 : 0);
