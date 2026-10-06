/**
 * End-to-end encryption test for direct messages, through a real PostgREST
 * with the migrations applied (local shim is fine), as real users.
 *
 * Runs real crypto devices (the app's src/data/supabase/e2e.ts on top of
 * @matrix-org/matrix-sdk-crypto-wasm): Ama on a phone, a laptop and later a
 * tablet, Leo on one device, Zoë as an outsider, plus an attacker who signs
 * in to Ama's account. Proves: messages decrypt for the right devices only,
 * new devices must be approved (emoji verification) before they get keys,
 * people can verify each other, key backup restores history with the
 * recovery key only, identity changes are detected, removed devices are
 * locked out, and the database never holds message plaintext or private keys.
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
const ids = { ama: randomUUID(), leo: randomUUID(), zoe: randomUUID(), carl: randomUUID(), dana: randomUUID() };
const SECRET = `meet me at the old bridge at nine 🌉 ${tag}`;
const REPLY = `see you there ${tag}`;
const LATER = `after the reset ${tag}`;
const ATTACK = `only real devices should read this ${tag}`;

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
const errCode = async (fn) => { try { await fn(); return null; } catch (e) { return e.code ?? e.message; } };

/** Emoji verification between two devices: a starts, b accepts; returns both emoji lists. */
async function verify(a, b, target, { confirm = true } = {}) {
  await a.startVerification(target);
  let incoming;
  for (let i = 0; i < 10 && !incoming; i++) {
    await b.refresh();
    incoming = (await b.verifications()).find((v) => v.state === "incoming");
  }
  if (!incoming) return { ok: false, why: "no incoming request" };
  await b.acceptVerification(incoming.flowId);
  let va, vb;
  for (let i = 0; i < 15 && !(va && vb); i++) {
    await a.refresh(); await b.refresh();
    va = (await a.verifications()).find((v) => v.state === "compare");
    vb = (await b.verifications()).find((v) => v.state === "compare");
  }
  if (!va || !vb) return { ok: false, why: "never reached emoji" };
  const ea = va.emoji.map((e) => e.symbol).join(""), eb = vb.emoji.map((e) => e.symbol).join("");
  if (!confirm) return { ok: true, ea, eb, va, vb };
  await a.confirmVerification(va.flowId);
  await b.confirmVerification(vb.flowId);
  for (let i = 0; i < 6; i++) { await a.refresh(); await b.refresh(); }
  const done = (await a.verifications()).some((v) => v.flowId === va.flowId && v.state === "done")
    && (await b.verifications()).some((v) => v.flowId === vb.flowId && v.state === "done");
  return { ok: done, ea, eb, emojiCount: va.emoji.length };
}

try {
  for (const [name, id] of Object.entries(ids)) {
    await db.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)", [id, `${name}-${tag}@example.com`, { display_name: `${name} ${tag}` }]);
  }
  const ama = asUser(ids.ama), leo = asUser(ids.leo), zoe = asUser(ids.zoe);
  const start = (userId, client, name) => E2EDevice.start({ crypto: sdk, backend: backendFor(client), userId, deviceId: newDeviceId(), deviceName: name });

  // ---- first devices: each account gets a cross-signing identity automatically
  const amaPhone = await start(ids.ama, ama, "Safari on iPhone");
  const leoPhone = await start(ids.leo, leo, "Chrome on Android");
  const zoeDevice = await start(ids.zoe, zoe, "Firefox on Linux");
  const { rows: xs } = await db.query("select user_id, key_type, key from public.e2e_cross_signing_keys where user_id = any($1)", [[ids.ama, ids.leo, ids.zoe]]);
  ok("first device creates the account identity (3 public cross-signing keys each)", xs.length === 9);
  ok("cross-signing keys on the server are public keys only", xs.every((k) => Object.keys(k.key).every((f) => ["user_id", "usage", "keys", "signatures"].includes(f))));
  ok("first device is verified for its account", (await amaPhone.ownSecurity()).deviceVerified);

  const { rows: devs } = await db.query("select user_id, device_keys from public.e2e_devices where user_id = any($1)", [Object.values(ids)]);
  ok("published device keys hold only public keys + signatures",
    devs.every((d) => Object.keys(d.device_keys).sort().join() === "algorithms,device_id,keys,signatures,user_id"));

  const { data: conversationId } = await ama.rpc("dm_open", { p_peer: ids.leo });

  // ---- a second device starts unverified: it can't send and gets no keys until approved
  const amaLaptop = await start(ids.ama, ama, "Chrome on macOS");
  const laptopSec = await amaLaptop.ownSecurity();
  ok("new device starts unverified, and knows another device can approve it", !laptopSec.deviceVerified && laptopSec.canVerifyWithOtherDevice);
  ok("an unverified device can't send", (await errCode(() => send(amaLaptop, ama, conversationId, ids.leo, { msgtype: "m.text", body: "x" }))) === "device-unverified");
  const firstId = await send(amaPhone, ama, conversationId, ids.leo, { msgtype: "m.text", body: SECRET, "amigo.reply_to": null });
  const stored = await rows(leo, conversationId);
  ok("stored message is a Megolm envelope", stored[0].content.algorithm === "m.megolm.v1.aes-sha2" && typeof stored[0].content.ciphertext === "string");
  ok("Leo's device decrypts it", (await leoPhone.decrypt(stored[0])).ok);
  ok("the unapproved laptop was not given the key", !(await amaLaptop.decrypt(stored[0])).ok);

  // ---- approve the laptop from the phone (emoji verification between own devices)
  const self = await verify(amaLaptop, amaPhone, "self");
  ok("own-device verification: both show the same 7 emoji", self.ea === self.eb && self.emojiCount === 7, self.ea);
  ok("own-device verification completes", self.ok, self.why);
  ok("laptop is now verified", (await amaLaptop.ownSecurity()).deviceVerified);
  const laptopDevices = await amaPhone.myDevices();
  ok("Your devices: both listed, both verified, names + last active, current marked",
    laptopDevices.length === 2 && laptopDevices.every((d) => d.verified && d.name && d.lastSeenAt) && laptopDevices.filter((d) => d.current).length === 1);
  const second = await send(amaPhone, ama, conversationId, ids.leo, { msgtype: "m.text", body: `second ${tag}` });
  ok("approved laptop receives keys for new messages", (await amaLaptop.decrypt((await rows(ama, conversationId)).find((r) => r.id === second))).ok);

  // ---- people verify each other
  ok("Ama and Leo start unverified", (await amaPhone.peerTrust(ids.leo)) === "unverified" && (await leoPhone.peerTrust(ids.ama)) === "unverified");
  const people = await verify(amaPhone, leoPhone, ids.leo);
  ok("Ama ↔ Leo emoji match and verification completes", people.ok && people.ea === people.eb, people.why ?? people.ea);
  ok("both now see each other as verified", (await amaPhone.peerTrust(ids.leo)) === "verified" && (await leoPhone.peerTrust(ids.ama)) === "verified");
  ok("Ama's approved laptop trusts Leo too (cross-signing)", (await amaLaptop.peerTrust(ids.leo)) === "verified");
  const { rows: [usig] } = await db.query("select count(*)::int as n from public.e2e_user_signatures where signer_id = $1 and target_id = $2", [ids.ama, ids.leo]);
  ok("'Ama verified Leo' is stored as a signature only Ama can fetch", usig.n === 1);
  const { data: zoeView } = await zoe.rpc("e2e_query_keys", { p_users: [`@${ids.leo}:amigo.world`] });
  ok("others don't see who verified whom", !JSON.stringify(zoeView).includes(`@${ids.ama}:amigo.world`));

  // mismatched emoji → nothing is trusted
  await zoe.rpc("dm_open", { p_peer: ids.leo });
  const mm = await verify(zoeDevice, leoPhone, ids.leo, { confirm: false });
  await leoPhone.rejectVerification(mm.vb.flowId);
  for (let i = 0; i < 4; i++) { await zoeDevice.refresh(); await leoPhone.refresh(); }
  const zv = (await zoeDevice.verifications()).find((v) => v.flowId === mm.va.flowId);
  const lv = (await leoPhone.verifications()).find((v) => v.flowId === mm.vb.flowId);
  ok("\"They don't match\" cancels it on both sides (recorded as a mismatch by the one who pressed it)",
    zv?.state === "cancelled" && lv?.state === "cancelled" && /mismatch/.test(lv.cancelReason ?? ""), `${zv?.state}/${lv?.state}/${lv?.cancelReason}`);
  ok("…and Zoë stays unverified", (await zoeDevice.peerTrust(ids.leo)) === "unverified");

  // ---- key backup: recovery key never reaches the server
  const recoveryKey = await amaPhone.setUpBackup();
  ok("recovery key is generated on the device", /^[A-Za-z0-9+/ ]{40,}$/.test(recoveryKey));
  const plainKey = recoveryKey.replace(/\s+/g, "");
  ok("recovery key never sent to the server", !wire.some((w) => w.includes(plainKey)));
  const { rows: bk } = await db.query("select k.session_data from public.e2e_backup_keys k join public.e2e_backup_versions v using (version) where v.user_id = $1", [ids.ama]);
  ok("backup holds the conversation keys, encrypted (ciphertext/ephemeral/mac only)", bk.length >= 1 && bk.every((r) => Object.keys(r.session_data).sort().join() === "ciphertext,ephemeral,mac"));
  ok("backup status: exists, this device has the key", (await amaPhone.backupState()).thisDeviceHasKey);
  await amaLaptop.refresh(); await amaLaptop.refresh();
  ok("verified laptop received the backup key from the phone (Olm-encrypted)", (await amaLaptop.backupState()).thisDeviceHasKey);

  // ---- password-reset attacker signs in as Ama on a new device
  const attacker = await start(ids.ama, ama, "Unknown browser");
  ok("attacker's device is unverified (no other device approved it)", !(await attacker.ownSecurity()).deviceVerified);
  await send(leoPhone, leo, conversationId, ids.ama, { msgtype: "m.text", body: ATTACK });
  const attackRow = (await rows(ama, conversationId)).at(-1);
  ok("attacker can't read new messages (keys only go to verified devices)", !(await attacker.decrypt(attackRow)).ok);
  ok("Ama's real devices can", (await amaPhone.decrypt(attackRow)).ok && (await amaLaptop.decrypt(attackRow)).ok);
  ok("attacker can't read history without the recovery key", !(await attacker.decrypt(stored[0])).ok);
  ok("attacker can't send as Ama", (await errCode(() => send(attacker, ama, conversationId, ids.leo, { msgtype: "m.text", body: "hi" }))) === "device-unverified");
  ok("attacker can't restore the backup with a guessed key", (await errCode(() => attacker.restoreBackup(newDeviceId()))) === "bad-recovery-key");
  const listed = (await amaPhone.myDevices()).find((d) => d.deviceId === attacker.deviceId);
  ok("Ama sees the new, unverified device in Your devices", listed && !listed.verified);
  await amaPhone.removeDevice(attacker.deviceId);
  ok("removed device is locked out", (await errCode(() => attacker.refresh())) === "device-removed");
  const { rows: [reup] } = await db.query("select count(*)::int as n from public.e2e_devices where user_id = $1 and device_id = $2", [ids.ama, attacker.deviceId]);
  ok("removed device's keys are gone from the directory", reup.n === 0);

  // ---- lost every device: new tablet with the recovery key
  const amaTablet = await start(ids.ama, ama, "Safari on iPad");
  ok("wrong recovery key is rejected", (await errCode(() => amaTablet.restoreBackup("AAAA".repeat(11)))) === "wrong-recovery-key" ||
    (await errCode(() => amaTablet.restoreBackup("AAAA".repeat(11)))) === "bad-recovery-key");
  const restored = await amaTablet.restoreBackup(recoveryKey);
  ok("recovery key restores the backed-up keys", restored.imported >= 1 && restored.imported === restored.total, JSON.stringify(restored));
  const old = await amaTablet.decrypt(stored[0]);
  ok("…so the new device reads old history", old.ok && old.payload.body === SECRET);
  // No other device at hand → reset identity on the tablet
  await amaTablet.resetIdentity();
  ok("after resetting, the tablet is verified", (await amaTablet.ownSecurity()).deviceVerified);
  ok("old devices are no longer verified after the reset", !(await amaPhone.ownSecurity()).deviceVerified);
  ok("Leo (who had verified Ama) is told her security key changed", (await leoPhone.peerTrust(ids.ama)) === "changed-verified");
  ok("Leo's sending pauses until he OKs the change", (await errCode(() => send(leoPhone, leo, conversationId, ids.ama, { msgtype: "m.text", body: "x" }))) === "identity-changed");
  await leoPhone.acceptIdentityChange(ids.ama);
  ok("after OK, Ama shows as unverified (not verified)", (await leoPhone.peerTrust(ids.ama)) === "unverified");
  await send(leoPhone, leo, conversationId, ids.ama, { msgtype: "m.text", body: LATER });
  const after = (await rows(ama, conversationId)).at(-1);
  ok("tablet reads new messages", (await amaTablet.decrypt(after)).ok);
  ok("the phone (old identity, now unverified) doesn't get new keys", !(await amaPhone.decrypt(after)).ok);
  const ampeople = await verify(amaTablet, leoPhone, ids.leo);
  ok("they can verify again after the change", ampeople.ok && (await leoPhone.peerTrust(ids.ama)) === "verified");

  // ---- server tampering
  // (Leo received this key directly from Ama's device, so it knows which device made it.)
  const forged = { ...stored[0], sender_id: ids.zoe };
  const asForged = await leoPhone.decrypt(forged);
  ok("server-forged sender is detected", !asForged.ok || asForged.senderMismatch);
  const c = stored[0].content.ciphertext;
  const tampered = { ...stored[0], content: { ...stored[0].content, ciphertext: c.slice(0, 40) + (c[40] === "A" ? "B" : "A") + c.slice(41) } };
  ok("tampered ciphertext is rejected", !(await leoPhone.decrypt(tampered)).ok);
  ok("ciphertext replayed into another conversation is rejected", !(await leoPhone.decrypt({ ...stored[0], conversation_id: randomUUID() })).ok);

  // ---- photos
  const photo = new Uint8Array(4096).map((_, i) => (i * 7) % 251);
  const enc = amaTablet.encryptAttachment(photo);
  const path = `${conversationId}/${randomUUID()}`;
  await backendFor(ama).uploadAttachment(path, enc.data);
  const photoId = await send(amaTablet, ama, conversationId, ids.leo, { msgtype: "m.image", body: "", "amigo.image": { path, info: enc.info, width: 64, height: 64, mimetype: "image/jpeg" } });
  const img = await leoPhone.decrypt((await rows(leo, conversationId)).find((r) => r.id === photoId));
  const bytes = img.ok && leoPhone.decryptAttachment(await backendFor(leo).downloadAttachment(img.payload["amigo.image"].path), img.payload["amigo.image"].info);
  ok("encrypted photo round-trips", bytes && Buffer.compare(Buffer.from(bytes), Buffer.from(photo)) === 0);
  ok("photo key never sent outside the ciphertext", !wire.some((w) => w.includes(JSON.parse(enc.info).key.k)));

  // ---- the app layer (src/data/supabase/messages.ts), fresh accounts
  const carl = asUser(ids.carl), dana = asUser(ids.dana);
  const oneShot = (name, fetcher, sub) => { fetcher().then(sub.onData, sub.onError); return () => {}; };
  const value = (subscribe) => new Promise((resolve, reject) => subscribe({ onData: resolve, onError: reject }));
  const appCarl = createSupabaseMessages(carl, oneShot, () => {}, { memoryStore: true });
  const appDana = createSupabaseMessages(dana, oneShot, () => {}, { memoryStore: true });
  ok("app layer reports real encryption and real (not simulated) security", appCarl.encryption === "e2e" && appCarl.security.simulated === false);
  ok("app: first device is set up", (await appCarl.security.setup(ids.carl)).deviceVerified && (await appDana.security.setup(ids.dana)).deviceVerified);
  const convId = await appCarl.openConversation(ids.carl, ids.dana);
  const APP = `app layer secret ${tag}`;
  await appCarl.send(ids.carl, convId, { text: APP });
  const view = await value((sub) => appDana.subscribeConversation(convId, ids.dana, sub));
  ok("app: recipient sees the decrypted text", view.messages.at(-1).text === APP);
  ok("app: peer trust starts unverified", (await appDana.security.peerTrust(ids.dana, ids.carl)) === "unverified");
  const devicesList = await value((sub) => appCarl.security.subscribeDevices(ids.carl, sub));
  ok("app: Your devices lists this device as current + verified", devicesList.length === 1 && devicesList[0].current && devicesList[0].verified);
  const key = await appCarl.security.setUpBackup(ids.carl);
  ok("app: backup set up, recovery key returned to show once", key.length > 40 && (await appCarl.security.backupStatus(ids.carl)).thisDeviceHasKey);
  await appDana.report(ids.dana, convId, { reason: "spam", note: "test", messageIds: [view.messages.at(-1).id] });
  const { rows: [rep] } = await db.query("select evidence from public.dm_reports where reporter_id = $1", [ids.dana]);
  ok("app: report evidence is exactly what the reporter selected", rep.evidence.length === 1 && rep.evidence[0].text === APP);

  // ---- nothing readable on the server
  const { rows: dump } = await db.query(`
    select (select coalesce(json_agg(m), '[]') from public.dm_messages m)::text
        || (select coalesce(json_agg(t), '[]') from public.e2e_to_device t)::text
        || (select coalesce(json_agg(d), '[]') from public.e2e_devices d)::text
        || (select coalesce(json_agg(k), '[]') from public.e2e_one_time_keys k)::text
        || (select coalesce(json_agg(x), '[]') from public.e2e_cross_signing_keys x)::text
        || (select coalesce(json_agg(b), '[]') from public.e2e_backup_keys b)::text
        || (select coalesce(json_agg(v), '[]') from public.e2e_backup_versions v)::text as all_rows`);
  for (const secret of [SECRET, REPLY, LATER, ATTACK, APP, "old bridge", plainKey]) {
    ok(`database holds no plaintext / recovery key: “${secret.slice(0, 16)}…”`, !dump[0].all_rows.includes(secret));
  }
  ok("no request to the server contained a message", ![SECRET, LATER, ATTACK, APP].some((t) => wire.some((w) => w.includes(t))));
  ok("to-device mail carrying keys was all Olm-encrypted", wire.filter((w) => w.includes('"p_event_type":"m.room.encrypted"')).every((w) => !w.includes("session_key")));

  // Keys are replenished after being claimed
  await amaTablet.refresh();
  const { rows: [left] } = await db.query("select count(*)::int as n from public.e2e_one_time_keys where user_id = $1 and device_id = $2 and not fallback", [ids.ama, amaTablet.deviceId]);
  ok("one-time keys topped up after use", left.n > 0, `${left.n}`);
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
