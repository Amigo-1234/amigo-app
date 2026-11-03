/**
 * Backup proof-of-possession and identity resets, offline:
 *
 *   1. With the real crypto library (matrix-sdk-crypto-wasm, as in the app): keys and
 *      signatures it makes pass src/lib/e2eProof.ts, and every forgery fails — made-up
 *      signatures, another account's keys, a device approved under an old identity, an
 *      unapproved device, a changed request, a changed device record.
 *   2. The two API routes (api/e2e-backup.ts, api/e2e-identity.ts) against a stand-in
 *      network: they write only after the checks pass, pass the server the challenge and
 *      key hash, and refuse a stale sign-in, bad keys, missing credentials.
 *
 * Throwaway keys made here; no network, no database.
 *
 *   node scripts/test/e2e-proof.test.mjs
 */
import * as sdk from "@matrix-org/matrix-sdk-crypto-wasm";
import { createServer } from "vite";

let failures = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};

process.env.NEON_REST_URL_OVERRIDE = "https://rest.test/rest/v1";
process.env.NEON_AUTH_URL_OVERRIDE = "https://auth.test/neondb/auth";
const vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
const P = await vite.ssrLoadModule("/src/lib/e2eProof.ts");
const backup = (await vite.ssrLoadModule("/api/e2e-backup.ts")).default;
const identity = (await vite.ssrLoadModule("/api/e2e-identity.ts")).default;

await sdk.initAsync();
const UID = "00000000-0000-0000-0000-00000000000a";
const OTHER = "00000000-0000-0000-0000-00000000000b";
const mx = (u) => `@${u}:amigo.world`;

/** A device with an identity, as the server stores it after setup. */
async function account(user, device) {
  const m = await sdk.OlmMachine.initialize(new sdk.UserId(mx(user)), new sdk.DeviceId(device));
  const upload = (await m.outgoingRequests()).find((r) => r.type === sdk.RequestType.KeysUpload);
  const deviceKeys = JSON.parse(upload.body).device_keys;
  const b = await m.bootstrapCrossSigning(true);
  const keys = JSON.parse(b.uploadSigningKeysRequest.body);
  const sigs = JSON.parse(b.uploadSignaturesRequest.body)[mx(user)];
  // e2e_upload_signatures merges the self-signing key's signature into the stored device record.
  deviceKeys.signatures[mx(user)] = { ...deviceKeys.signatures[mx(user)], ...sigs[device].signatures[mx(user)] };
  return { m, user: mx(user), device, device_keys: deviceKeys, master: keys.master_key, self_signing: keys.self_signing_key, user_signing: keys.user_signing_key };
}
const material = (a, over = {}) => ({ user: a.user, device: a.device, device_keys: a.device_keys, master: a.master, self_signing: a.self_signing, ...over });
const clone = (o) => JSON.parse(JSON.stringify(o));
const sign = async (a, message) => JSON.parse((await a.m.sign(message)).asJSON())[a.user][`ed25519:${a.device}`];

// ------------------------------------------------------------ 1. protocol

const A = await account(UID, "DEVA");
const B = await account(OTHER, "DEVB");

const trust = await P.verifyDeviceTrust(material(A));
ok("a device set up by the library is trusted (device ← self-signing ← master)", trust.ok && trust.deviceKey === A.device_keys.keys["ed25519:DEVA"], JSON.stringify(trust));

const payload = JSON.stringify({ version: "7", rooms: {} });
const nonce = "a".repeat(64);
const msg = P.proofMessage("put", A.user, "DEVA", nonce, await P.sha256b64(payload));
const sig = await sign(A, msg);
ok("the device's own signature over the request verifies", await P.verifyEd25519(trust.deviceKey, msg, sig));
ok("…not over another payload", !(await P.verifyEd25519(trust.deviceKey, P.proofMessage("put", A.user, "DEVA", nonce, await P.sha256b64(payload + " ")), sig)));
ok("…not with another challenge", !(await P.verifyEd25519(trust.deviceKey, P.proofMessage("put", A.user, "DEVA", "b".repeat(64), await P.sha256b64(payload)), sig)));
ok("…not as another operation", !(await P.verifyEd25519(trust.deviceKey, P.proofMessage("create", A.user, "DEVA", nonce, await P.sha256b64(payload)), sig)));
ok("…not by another device's key", !(await P.verifyEd25519(B.device_keys.keys["ed25519:DEVB"], msg, sig)));
ok("a made-up signature string never verifies", !(await P.verifyEd25519(trust.deviceKey, msg, "A".repeat(86))) && !(await P.verifyEd25519(trust.deviceKey, msg, "not-a-signature")));

{
  const dk = clone(A.device_keys);
  const ssk = Object.values(A.self_signing.keys)[0];
  dk.signatures[A.user][`ed25519:${ssk}`] = "A".repeat(86);
  ok("forgery: a made-up self-signing signature on the device", !(await P.verifyDeviceTrust(material(A, { device_keys: dk }))).ok);
}
{
  const dk = clone(A.device_keys);
  dk.algorithms = [...dk.algorithms, "m.something.else"];
  ok("forgery: device record changed after it was signed", !(await P.verifyDeviceTrust(material(A, { device_keys: dk }))).ok);
}
{
  const dk = clone(A.device_keys);
  dk.keys["ed25519:DEVA"] = B.device_keys.keys["ed25519:DEVB"];
  ok("forgery: device key swapped for another", !(await P.verifyDeviceTrust(material(A, { device_keys: dk }))).ok);
}
ok("forgery: another account's self-signing key", !(await P.verifyDeviceTrust(material(A, { self_signing: B.self_signing }))).ok);
ok("forgery: another account's master key", !(await P.verifyDeviceTrust(material(A, { master: B.master }))).ok);
ok("forgery: self-signing key not signed by this master", !(await P.verifyDeviceTrust(material(A, { self_signing: { ...clone(A.self_signing), signatures: {} } }))).ok);
ok("forgery: the record claims another user", !(await P.verifyDeviceTrust({ ...material(A), user: B.user })).ok);
ok("forgery: the record claims another device id", !(await P.verifyDeviceTrust({ ...material(A), device: "DEVX" })).ok);
{
  // A second device of A's that was never approved: signed only by itself.
  const m2 = await sdk.OlmMachine.initialize(new sdk.UserId(A.user), new sdk.DeviceId("DEVA2"));
  const dk2 = JSON.parse((await m2.outgoingRequests()).find((r) => r.type === sdk.RequestType.KeysUpload).body).device_keys;
  ok("an unapproved device of the same account is not trusted", !(await P.verifyDeviceTrust({ ...material(A), device: "DEVA2", device_keys: dk2 })).ok);
}
{
  // After a reset, the device's signature is from the old self-signing key.
  const b2 = await A.m.bootstrapCrossSigning(true);
  const k2 = JSON.parse(b2.uploadSigningKeysRequest.body);
  ok("a device approved under the old identity isn't trusted by the new one", !(await P.verifyDeviceTrust(material(A, { master: k2.master_key, self_signing: k2.self_signing_key }))).ok);
  ok("a genuine new identity hangs together", await P.verifyNewIdentity(A.user, { master: k2.master_key, self_signing: k2.self_signing_key, user_signing: k2.user_signing_key }));
  ok("a new identity with someone else's self-signing key doesn't", !(await P.verifyNewIdentity(A.user, { master: k2.master_key, self_signing: B.self_signing })));
  ok("…nor with someone else's user-signing key", !(await P.verifyNewIdentity(A.user, { master: k2.master_key, self_signing: k2.self_signing_key, user_signing: B.user_signing })));
  ok("…nor keys made out for another user", !(await P.verifyNewIdentity(B.user, { master: k2.master_key, self_signing: k2.self_signing_key })));
  A.next = k2;
}

// ------------------------------------------------------------ 2. routes

const SECRET = "route-test-secret";
let calls = [];
let session = null;
const mats = new Map();
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ u, body, auth: new Headers(init.headers).get("authorization") });
  if (u === "https://auth.test/neondb/auth/get-session") return Response.json(session);
  if (u === "https://api.resend.com/emails") return Response.json({ id: "x" });
  const fn = u.replace("https://rest.test/rest/v1/rpc/", "");
  if (fn === "e2e_proof_material") return body.p_key === SECRET && mats.has(body.p_device) ? Response.json(mats.get(body.p_device)) : Response.json({ code: "DM012", message: "x" }, { status: 400 });
  if (fn === "e2e_backup_create_verified") return Response.json("12");
  if (fn === "e2e_backup_put_verified") return Response.json({ count: 1, etag: "1" });
  if (fn === "e2e_replace_identity") return Response.json(null);
  return Response.json({ message: `unexpected ${fn}` }, { status: 500 });
};
const post = (handler, body, headers = {}) =>
  handler(new Request("https://app.test/api/x", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
const writes = () => calls.filter((c) => /_verified$|replace_identity$/.test(c.u));

// The verified device as the database would hand it out (before the reset above, A's stored keys were these).
mats.set("DEVA", { user: A.user, device_keys: A.device_keys, master: A.master, self_signing: A.self_signing, hash: "HASH1" });
const requestFor = async (op, p, n = nonce, signer = A) => {
  const text = JSON.stringify(p);
  return { op, device: "DEVA", nonce: n, payload: text, signature: await sign(signer, P.proofMessage(op, A.user, "DEVA", n, await P.sha256b64(text))) };
};

process.env.PUSH_SERVER_SECRET = SECRET;
calls = [];
let res = await post(backup, await requestFor("put", { version: "7", rooms: { "!r:amigo.world": { sessions: {} } } }), { authorization: "Bearer T" });
let w = writes();
ok("backup route: a proven write goes through", res.status === 200 && w.length === 1 && w[0].u.endsWith("e2e_backup_put_verified"), String(res.status));
ok("…with the server secret, the challenge, the checked keys' hash and the caller's own token",
  w[0]?.body.p_key === SECRET && w[0]?.body.p_nonce === nonce && w[0]?.body.p_hash === "HASH1" && w[0]?.body.p_version === "7" && w[0]?.auth === "Bearer T");
calls = [];
res = await post(backup, await requestFor("create", { algorithm: "m.megolm_backup.v1.curve25519-aes-sha2", auth_data: { public_key: "P" } }), { authorization: "Bearer T" });
ok("backup route: starting a backup works the same way", res.status === 200 && (await res.json()).data === "12" && writes()[0]?.body.p_auth_data.public_key === "P");

calls = [];
const tampered = await requestFor("put", { version: "7", rooms: {} });
tampered.payload = JSON.stringify({ version: "7", rooms: { evil: {} } });
res = await post(backup, tampered, { authorization: "Bearer T" });
ok("backup route: a payload changed after signing is refused, nothing written", res.status === 403 && writes().length === 0, String(res.status));
calls = [];
res = await post(backup, await requestFor("put", { version: "7", rooms: {} }, nonce, B), { authorization: "Bearer T" });
ok("backup route: signed by another device's key: refused", res.status === 403 && writes().length === 0);
calls = [];
res = await post(backup, { ...(await requestFor("put", { version: "7", rooms: {} })), signature: "A".repeat(86) }, { authorization: "Bearer T" });
ok("backup route: a made-up signature: refused", res.status === 403 && writes().length === 0);
calls = [];
mats.set("DEVA", { user: A.user, device_keys: A.device_keys, master: A.next.master_key, self_signing: A.next.self_signing_key, hash: "HASH2" });
res = await post(backup, await requestFor("put", { version: "7", rooms: {} }), { authorization: "Bearer T" });
ok("backup route: a device not vouched for by the current identity: refused", res.status === 403 && (await res.json()).code === "DM012" && writes().length === 0);
mats.set("DEVA", { user: A.user, device_keys: A.device_keys, master: A.master, self_signing: A.self_signing, hash: "HASH1" });
calls = [];
res = await post(backup, await requestFor("put", { version: "7", rooms: {} }));
ok("backup route: no token: refused before anything", res.status === 401 && calls.length === 0);
res = await post(backup, { ...(await requestFor("put", { version: "7", rooms: {} })), nonce: "short" }, { authorization: "Bearer T" });
ok("backup route: malformed challenge: refused", res.status === 400);
delete process.env.PUSH_SERVER_SECRET;
calls = [];
res = await post(backup, await requestFor("put", { version: "7", rooms: {} }), { authorization: "Bearer T" });
ok("backup route: without the server secret configured it does nothing", res.status === 503 && calls.length === 0);
process.env.PUSH_SERVER_SECRET = SECRET;

const fresh = { session: { userId: UID, createdAt: new Date(Date.now() - 60_000).toISOString() }, user: { email: "owner@example.test" } };
const stale = { session: { userId: UID, createdAt: new Date(Date.now() - 20 * 60_000).toISOString() }, user: { email: "owner@example.test" } };
const newKeys = { device: "DEVA", master: A.next.master_key, self_signing: A.next.self_signing_key, user_signing: A.next.user_signing_key };
const both = { authorization: "Bearer T", cookie: "__Secure-neon-auth.session_token=abc" };

session = stale;
calls = [];
res = await post(identity, newKeys, both);
ok("identity route: a sign-in older than 10 minutes can't reset (DM014), nothing written", res.status === 401 && (await res.json()).code === "DM014" && writes().length === 0);
res = await post(identity, { device: "DEVA", check: true }, both);
ok("identity route: the pre-check says so too", res.status === 401);
session = fresh;
calls = [];
res = await post(identity, { device: "DEVA", check: true }, both);
ok("identity route: the pre-check passes for a fresh sign-in, writes nothing", res.status === 200 && writes().length === 0);
calls = [];
res = await post(identity, { ...newKeys, self_signing: B.self_signing }, both);
ok("identity route: keys that don't hang together are refused", res.status === 400 && writes().length === 0);
calls = [];
session = { ...fresh, session: { ...fresh.session, userId: OTHER } };
res = await post(identity, newKeys, both);
ok("identity route: keys made out for another user than the session's are refused", res.status === 400 && writes().length === 0);
session = fresh;
calls = [];
res = await post(identity, newKeys, { authorization: "Bearer T" });
ok("identity route: without the session cookie it can't check the sign-in: refused", res.status === 401 && calls.length === 0);
process.env.RESEND_API_KEY = "re_test_not_a_real_key";
process.env.EMAIL_FROM = "Amigo World <no-reply@amigoworld.com.ng>";
calls = [];
res = await post(identity, newKeys, both);
w = writes();
const mail = calls.find((c) => c.u === "https://api.resend.com/emails");
ok("identity route: a fresh, valid reset goes through with the session's user", res.status === 200 && w.length === 1 && w[0].body.p_session_user === UID && w[0].body.p_key === SECRET);
ok("…and the account's email address is told", mail?.body.to?.[0] === "owner@example.test" && /security key was reset/i.test(mail?.body.subject ?? ""));

await vite.close();
console.log(failures ? `${failures} FAILURE(S)` : "ALL BACKUP PROOF TESTS PASSED");
process.exit(failures ? 1 : 0);
