/**
 * Live encrypted-messaging check against the real Neon project (Neon Auth +
 * Data API), as two freshly registered accounts. Runs the app's own messaging
 * code (src/data/supabase/messages.ts in Neon mode, real Olm/Megolm crypto).
 *
 *   NEON_AUTH_URL=… NEON_DATA_API_URL=… APP_ORIGIN=… node scripts/test/neon-live-dm.test.mjs
 *
 * Creates two test accounts (amigo-e2e-*@example.com); nothing else is touched.
 * Proves: real 1:1 delivery and decryption, replies, read receipts, blocking,
 * reporting, the stored message is ciphertext only, and history survives a
 * new sign-in on a new device through the encrypted backup + recovery key.
 */
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createServer } from "vite";

const { NEON_AUTH_URL, NEON_DATA_API_URL, APP_ORIGIN } = process.env;
if (!NEON_AUTH_URL || !NEON_DATA_API_URL || !APP_ORIGIN) throw new Error("Set NEON_AUTH_URL, NEON_DATA_API_URL and APP_ORIGIN");

let failures = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};

// ------------------------------------------------------------ Neon Auth

async function auth(path, body, cookie) {
  const res = await fetch(`${NEON_AUTH_URL}${path}`, {
    method: body ? "POST" : "GET",
    headers: { origin: APP_ORIGIN, ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(json)}`);
  const setCookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return { json, cookie: setCookie || cookie };
}

/** Registers (or signs in) and returns the user id plus a Data API client carrying its Neon Auth JWT. */
async function account(email, password, name, mode) {
  const { json, cookie } = await auth(mode === "up" ? "/sign-up/email" : "/sign-in/email", mode === "up" ? { email, password, name } : { email, password });
  const { json: tok } = await auth("/token", null, cookie);
  const base = NEON_DATA_API_URL.replace(/\/rest\/v1\/?$/, "");
  const db = createClient(base, "neon", { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${tok.token}` } } });
  return { id: json.user.id, db };
}

// --------------------------------------------------------------- the app

const vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
const { createSupabaseMessages } = await vite.ssrLoadModule("/src/data/supabase/messages.ts");
const oneShot = (_name, fetcher, sub) => {
  fetcher().then(sub.onData, sub.onError);
  return () => {};
};
const value = (subscribe) => new Promise((resolve, reject) => subscribe({ onData: resolve, onError: reject }));
const app = (db) => createSupabaseMessages(db, oneShot, () => {}, { memoryStore: true, realtime: false });

const tag = randomBytes(4).toString("hex");
const pw = randomBytes(18).toString("base64url");
const emailA = `amigo-e2e-${tag}-a@example.com`;
const emailB = `amigo-e2e-${tag}-b@example.com`;

try {
  const A = await account(emailA, pw, `E2E Test A ${tag}`, "up");
  const B = await account(emailB, pw, `E2E Test B ${tag}`, "up");
  ok("two real Neon Auth accounts registered", !!A.id && !!B.id && A.id !== B.id);

  const appA = app(A.db);
  const appB = app(B.db);
  ok("encryption is end-to-end, not simulated", appA.encryption === "e2e" && appA.security.simulated === false);
  ok("text-only on Neon (photos deferred)", appA.photos === false);
  const [sa, sb] = await Promise.all([appA.security.setup(A.id), appB.security.setup(B.id)]);
  ok("each account's first device is set up and trusted", sa.deviceVerified && sb.deviceVerified);

  const conv = await appA.openConversation(A.id, B.id);
  ok("one-to-one conversation opened", typeof conv === "string");

  const SECRET1 = `hello from A ${tag} ${randomBytes(6).toString("hex")}`;
  await appA.send(A.id, conv, { text: SECRET1 });
  let viewB = await value((s) => appB.subscribeConversation(conv, B.id, s));
  const m1 = viewB.messages.at(-1);
  ok("B decrypts A's message", m1?.text === SECRET1);

  const SECRET2 = `reply from B ${tag} ${randomBytes(6).toString("hex")}`;
  await appB.markRead(B.id, conv);
  await appB.send(B.id, conv, { text: SECRET2, replyToId: m1.id });
  const viewA = await value((s) => appA.subscribeConversation(conv, A.id, s));
  const mine = viewA.messages.find((m) => m.id === m1.id);
  const reply = viewA.messages.at(-1);
  ok("A decrypts B's reply", reply?.text === SECRET2);
  ok("reply quotes the original (decrypted on device)", reply?.replyTo?.text === SECRET1);
  ok("read receipt: A's message shows read", mine?.status === "read", mine?.status);

  const inboxA = await value((s) => appA.subscribeConversations(A.id, s));
  ok("inbox preview is decrypted on device", inboxA[0]?.lastMessage?.text === SECRET2);

  // What the server stores, read back through the Data API as a participant.
  const { data: rows } = await A.db.from("dm_messages").select("content").eq("conversation_id", conv);
  const raw = JSON.stringify(rows);
  ok("server rows are Megolm ciphertext only", rows?.length === 2 && rows.every((r) => r.content.algorithm === "m.megolm.v1.aes-sha2" && r.content.ciphertext));
  ok("plaintext never appears in stored messages", !raw.includes(SECRET1) && !raw.includes(SECRET2));

  await appB.block(B.id, A.id);
  const blocked = await appA.send(A.id, conv, { text: "should not send" }).then(() => false, (e) => e.code === "blocked");
  ok("blocking stops messages", blocked);
  await appB.unblock(B.id, A.id);
  await appA.send(A.id, conv, { text: `after unblock ${tag}` });
  viewB = await value((s) => appB.subscribeConversation(conv, B.id, s));
  ok("unblocking restores messaging", viewB.messages.at(-1)?.text === `after unblock ${tag}`);

  const reported = await appB.report(B.id, conv, { reason: "spam", note: `live test ${tag}`, messageIds: [m1.id] }).then(() => true, (e) => e.message);
  ok("report with chosen evidence accepted", reported === true, reported === true ? "" : String(reported));
  const { data: reportRows, error: reportErr } = await B.db.from("dm_reports").select("id");
  ok("reports are not readable by users", !reportRows?.length && !!reportErr);

  const outsider = await A.db.from("e2e_one_time_keys").select("key_id").limit(1);
  ok("one-time keys are not readable by clients", !!outsider.error);

  // Encrypted backup, then a new sign-in on a brand-new device restores history with the recovery key.
  const recoveryKey = await appB.security.setUpBackup(B.id);
  ok("encrypted key backup created, recovery key shown once", typeof recoveryKey === "string" && recoveryKey.length > 20);
  const B2 = await account(emailB, pw, "", "in");
  const appB2 = app(B2.db);
  await appB2.security.setup(B2.id);
  const before = await value((s) => appB2.subscribeConversation(conv, B2.id, s));
  ok("new device can't read old messages without the key", before.messages.find((m) => m.id === m1.id)?.undecryptable === true);
  await appB2.security.restoreBackup(B2.id, recoveryKey);
  const after = await value((s) => appB2.subscribeConversation(conv, B2.id, s));
  ok("after restore with the recovery key, history decrypts on the new sign-in", after.messages.find((m) => m.id === m1.id)?.text === SECRET1);

  console.log(`conversation ${conv} · accounts ${emailA}, ${emailB}`);
} catch (e) {
  failures++;
  console.log("FAIL", e.stack ?? e);
} finally {
  await vite.close();
}
console.log(failures ? `${failures} FAILED` : "ALL LIVE NEON MESSAGING CHECKS PASSED");
process.exit(failures ? 1 : 0);
