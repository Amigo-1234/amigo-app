/**
 * A new account's first messaging device whose setup is cut short (the app is
 * closed or navigates away after the account's cross-signing keys were
 * uploaded but before this device's own signature was) must finish setting up
 * the next time it starts — not get stuck as "a new device, confirm it's you"
 * with messages to it undecryptable. And it must never re-upload its old
 * identity over one that was reset on another device since.
 *
 * Real crypto (src/data/supabase/e2e.ts on @matrix-org/matrix-sdk-crypto-wasm)
 * against a real PostgREST with the migrations applied:
 *
 *   PGRST_URL=http://localhost:54330 JWT_SECRET=… DATABASE_URL=… \
 *     node scripts/test/e2e-interrupted-setup.test.mjs
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

/** Backend for one person; `cut` makes the named RPC fail once (the app closing mid-setup). */
const backendFor = (client, cut) => ({
  async rpc(fn, args) {
    if (cut.fn === fn && !cut.done) {
      cut.done = true;
      throw Object.assign(new Error("Load failed"), { code: "network" });
    }
    const { data, error } = await client.rpc(fn, args);
    if (error) throw Object.assign(new Error(error.message), { code: error.code });
    return data;
  },
  async fetchToDevice(deviceId) {
    const { data, error } = await client.from("e2e_to_device").select("id, sender_id, event_type, content").eq("recipient_device", deviceId).order("id");
    if (error) throw new Error(error.message);
    return data;
  },
});

/**
 * Starts a device the way E2EDevice.start does, but keeps the instance even if
 * setup fails, so the "next start" can run on the same key store (in the
 * browser that store survives in IndexedDB).
 */
async function begin(userId, client, cut) {
  await sdk.initAsync();
  const deviceId = newDeviceId();
  const machine = await sdk.OlmMachine.initialize(new sdk.UserId(`@${userId}:amigo.world`), new sdk.DeviceId(deviceId));
  const d = new E2EDevice(sdk, machine, backendFor(client, cut), userId, deviceId, "Safari on iPhone");
  const setup = () => d.serial(async () => {
    await d.machine.updateTrackedUsers([d.me()]);
    await d.sync();
    await d.ensureIdentity();
  });
  return { d, setup };
}

const ids = { ama: randomUUID(), leo: randomUUID(), kim: randomUUID(), noa: randomUUID() };
const tag = randomUUID().slice(0, 8);
try {
  for (const [name, id] of Object.entries(ids)) {
    await db.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)", [id, `${name}-${tag}@example.com`, { display_name: `${name} ${tag}` }]);
  }

  // 1. Cut after the cross-signing keys are uploaded, before this device's signature.
  const ama = await begin(ids.ama, asUser(ids.ama), { fn: "e2e_upload_signatures" });
  const first = await ama.setup().then(() => "ok", (e) => e.message);
  ok("setup interrupted mid-way (simulated)", first === "Load failed", first);
  const { rows: xs } = await db.query("select count(*)::int n from public.e2e_cross_signing_keys where user_id = $1", [ids.ama]);
  ok("…the account's cross-signing keys did reach the server", xs[0].n === 3, String(xs[0].n));
  const { rows: keys1 } = await db.query("select key->'keys' k from public.e2e_cross_signing_keys where user_id = $1 order by key_type", [ids.ama]);
  ok("…this device isn't signed yet", !(await ama.d.ownSecurity()).deviceVerified);

  // 2. Next start, same key store.
  await ama.setup();
  const sec = await ama.d.ownSecurity();
  ok("next start finishes setup: the device is approved (no “Confirm it's you”)", sec.deviceVerified);
  const { rows: keys2 } = await db.query("select key->'keys' k from public.e2e_cross_signing_keys where user_id = $1 order by key_type", [ids.ama]);
  ok("…with the same identity (nothing reset)", JSON.stringify(keys1) === JSON.stringify(keys2));

  // 3. Messages to it decrypt.
  const leo = await begin(ids.leo, asUser(ids.leo), {});
  await leo.setup();
  const leoDb = asUser(ids.leo);
  const { data: conv } = await leoDb.rpc("dm_open", { p_peer: ids.ama });
  const content = await leo.d.encrypt(conv, ids.ama, { msgtype: "m.text", body: `hello ${tag}` });
  const { data: sent, error: sendErr } = await leoDb.rpc("dm_send", { p_conversation: conv, p_device: leo.d.deviceId, p_content: content });
  ok("Leo sends to Ama", !sendErr, sendErr?.message);
  const { data: rows } = await asUser(ids.ama).from("dm_messages").select("id, conversation_id, sender_id, content, created_at").eq("conversation_id", conv);
  const res = await ama.d.decrypt(rows[0]);
  ok("Ama's recovered device decrypts it", res.ok && res.payload.body === `hello ${tag}`, JSON.stringify(res).slice(0, 120));
  void sent;

  // 3b. Cut earlier: before the identity reached the server at all.
  const noa = await begin(ids.noa, asUser(ids.noa), { fn: "e2e_upload_signing_keys" });
  await noa.setup().catch(() => undefined);
  const { rows: nx } = await db.query("select count(*)::int n from public.e2e_cross_signing_keys where user_id = $1", [ids.noa]);
  ok("cut before the identity was uploaded: nothing on the server yet", nx[0].n === 0, String(nx[0].n));
  await noa.setup();
  const { rows: nx2 } = await db.query("select count(*)::int n from public.e2e_cross_signing_keys where user_id = $1", [ids.noa]);
  ok("…next start uploads it and approves the device", nx2[0].n === 3 && (await noa.d.ownSecurity()).deviceVerified, String(nx2[0].n));

  // 4. Safety: a device holding an old identity must not upload it over a newer one.
  const kimDb = asUser(ids.kim);
  const kimOld = await begin(ids.kim, kimDb, { fn: "e2e_upload_signatures" });
  await kimOld.setup().catch(() => undefined);
  const kimNew = await begin(ids.kim, kimDb, {});
  await kimNew.setup();
  await kimNew.d.resetIdentity(); // reset on another device ("I can't use another device")
  const { rows: before } = await db.query("select key from public.e2e_cross_signing_keys where user_id = $1 order by key_type", [ids.kim]);
  await kimOld.setup();
  const { rows: after } = await db.query("select key from public.e2e_cross_signing_keys where user_id = $1 order by key_type", [ids.kim]);
  ok("a stale device never re-uploads its old identity over a reset", JSON.stringify(before) === JSON.stringify(after));
  ok("…and stays unapproved", !(await kimOld.d.ownSecurity()).deviceVerified);
  ok("…while the device that reset is approved", (await kimNew.d.ownSecurity()).deviceVerified);
} catch (e) {
  failures++;
  console.log(`FAIL stopped: ${e?.stack ?? e}`);
} finally {
  for (const id of Object.values(ids)) await db.query("delete from auth.users where id = $1", [id]).catch(() => undefined);
  await db.end();
  await vite.close();
  proxy.close();
}
console.log(failures ? `${failures} FAILED` : "ALL INTERRUPTED-SETUP TESTS PASSED");
process.exit(failures ? 1 : 0);
