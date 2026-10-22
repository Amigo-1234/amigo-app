/**
 * Real Neon-generated codes, end to end, against the isolated test project
 * (amigo-email-test — its own Neon Auth, keys and users; no production data).
 * Neon makes every code; with the test project's webhook pointed at the Preview
 * handler, each one arrives as the branded email. The codes are read from the
 * inbox by the operator and handed back sealed to this job's own key (never in
 * plain text in a public log). Nothing here prints a code or password.
 *
 *   STEP=keys                                  the test project's signing keys aren't production's
 *   STEP=start   TEST_TO=… SESSION=…           two test accounts; verification code, a resend, a reset code
 *   STEP=verify  SESSION=… BLOB=…  {a_v1,a_v2}  stale (resent) code, wrong code, right code, reuse; asks for a reset code
 *   STEP=reset   SESSION=… BLOB=…  {a_r}        wrong code, right code, new password works, old doesn't, reuse
 *   STEP=expired SESSION=… BLOB=…  {b_r}        a reset code older than Neon's expiry is refused
 *
 * State (this job's private key, a seed for the test passwords, the addresses)
 * lives in STATE_DIR, kept between steps by the workflow's Actions cache.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const { STEP, SESSION = "", TEST_TO = "", BLOB = "" } = process.env;
const AUTH = (process.env.AUTH_URL ?? "").replace(/\/+$/, "");
const PROD_AUTH = "https://ep-dry-mode-zano9y8g.neonauth.c-2.eu-west-2.aws.neon.tech/neondb/auth";
const STATE_DIR = process.env.STATE_DIR ?? ".otp-state";
const STATE = `${STATE_DIR}/state.json`;
if (!AUTH) throw new Error("Set AUTH_URL");
if (AUTH === PROD_AUTH) throw new Error("AUTH_URL is production's — this test only runs against the test project");

let failures = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};
const info = (label, extra) => console.log(`info ${label} — ${extra}`);
const b64u = (b) => Buffer.from(b).toString("base64url");
const mask = (email) => email.replace(/^(.).*(\+[^@]+)@.*$/, "$1…$2@…");

async function auth(path, body) {
  const res = await fetch(`${AUTH}${path}`, {
    method: "POST",
    // allow_localhost is on for the test project; a browser-like origin keeps Better Auth's CSRF check happy.
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, code: json?.code ?? "", ok: res.ok, json };
}
const show = (r) => `${r.status}${r.code ? ` ${r.code}` : ""}`;

async function password(seed, label) {
  const key = await crypto.subtle.importKey("raw", Buffer.from(seed, "base64url"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `Aw-${b64u(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(label))).slice(0, 24)}!9`;
}

async function open(blob, privJwk) {
  const raw = Buffer.from(blob, "base64url");
  const eph = await crypto.subtle.importKey("raw", raw.subarray(0, 65), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const priv = await crypto.subtle.importKey("jwk", privJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "ECDH", public: eph }, priv, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.subarray(65, 77) }, key, raw.subarray(77));
  return JSON.parse(new TextDecoder().decode(plain));
}

const load = () => JSON.parse(readFileSync(STATE, "utf8"));
const codes = async () => {
  if (!BLOB) throw new Error("Set BLOB");
  const c = await open(BLOB, load().priv);
  for (const v of Object.values(c)) if (!/^\d{4,10}$/.test(String(v))) throw new Error("sealed value isn't a code");
  return c;
};
const wrongFor = (code) => (code === "000000" ? "111111" : "000000");

if (STEP === "keys") {
  const get = async (u) => (await (await fetch(`${u}/.well-known/jwks.json`)).json()).keys ?? [];
  const [test, prod] = await Promise.all([get(AUTH), get(PROD_AUTH)]);
  info("test project keys", test.map((k) => `${k.kid?.slice(0, 8)}… ${k.crv}`).join(", ") || "none");
  info("production keys", prod.map((k) => `${k.kid?.slice(0, 8)}… ${k.crv}`).join(", ") || "none");
  ok("the test project publishes its own Ed25519 key", test.some((k) => k.crv === "Ed25519"));
  ok("no key id is shared with production", !test.some((t) => prod.some((p) => p.kid === t.kid)));
  ok("no public key is shared with production", !test.some((t) => prod.some((p) => p.x && p.x === t.x)));
} else if (STEP === "start") {
  if (!/^[^@\s+]+@[^@\s]+$/.test(TEST_TO) || !/^[a-z0-9]{3,16}$/.test(SESSION)) throw new Error("Set TEST_TO (plain address) and SESSION (a-z0-9)");
  const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
  const [local, domain] = TEST_TO.split("@");
  const state = {
    priv: await crypto.subtle.exportKey("jwk", privateKey),
    seed: b64u(crypto.getRandomValues(new Uint8Array(32))),
    a: `${local}+amigo-${SESSION}-a@${domain}`,
    b: `${local}+amigo-${SESSION}-b@${domain}`,
    startedAt: Date.now(),
  };
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE, JSON.stringify(state));
  console.log(`PUBKEY=${b64u(await crypto.subtle.exportKey("raw", publicKey))}`);
  info("test accounts", `${mask(state.a)}, ${mask(state.b)}`);

  const upA = await auth("/sign-up/email", { email: state.a, password: await password(state.seed, "A1"), name: "Email Test A" });
  ok("test account A created", upA.ok, show(upA));
  const upB = await auth("/sign-up/email", { email: state.b, password: await password(state.seed, "B1"), name: "Email Test B" });
  ok("test account B created", upB.ok, show(upB));

  const v1 = await auth("/email-otp/send-verification-otp", { email: state.a, type: "email-verification" });
  ok("A: verification code requested (email 1)", v1.ok, show(v1));
  await new Promise((r) => setTimeout(r, 5000));
  const v2 = await auth("/email-otp/send-verification-otp", { email: state.a, type: "email-verification" });
  ok("A: resend requested (email 2)", v2.ok, show(v2));
  const rb = await auth("/email-otp/send-verification-otp", { email: state.b, type: "forget-password" });
  ok("B: password-reset code requested (for the expiry check)", rb.ok, show(rb));
  // Same answer for an address with no account: the reset form doesn't reveal who has one.
  const ghost = await auth("/email-otp/send-verification-otp", { email: `${local}+amigo-${SESSION}-nobody@${domain}`, type: "forget-password" });
  ok("reset for an address with no account answers the same as for a real one", ghost.status === rb.status && JSON.stringify(ghost.json) === JSON.stringify(rb.json), `${show(ghost)} vs ${show(rb)}`);
  info("started", new Date(state.startedAt).toISOString());
} else if (STEP === "verify") {
  const s = load();
  const c = await codes();
  const stale = await auth("/email-otp/verify-email", { email: s.a, otp: c.a_v1 });
  ok("the first code no longer works after a resend", !stale.ok, show(stale));
  const wrong = await auth("/email-otp/verify-email", { email: s.a, otp: wrongFor(c.a_v2) });
  ok("a wrong code is refused", !wrong.ok, show(wrong));
  const right = await auth("/email-otp/verify-email", { email: s.a, otp: c.a_v2 });
  ok("the resent code verifies the address", right.ok, show(right));
  const again = await auth("/email-otp/verify-email", { email: s.a, otp: c.a_v2 });
  ok("the same code can't be used twice", !again.ok, show(again));
  const signIn = await auth("/sign-in/email", { email: s.a, password: await password(s.seed, "A1") });
  ok("A signs in and is marked verified", signIn.ok && signIn.json?.user?.emailVerified === true, `${show(signIn)} emailVerified=${signIn.json?.user?.emailVerified}`);
  const ra = await auth("/email-otp/send-verification-otp", { email: s.a, type: "forget-password" });
  ok("A: password-reset code requested (email 3)", ra.ok, show(ra));
} else if (STEP === "reset") {
  const s = load();
  const c = await codes();
  const wrong = await auth("/email-otp/reset-password", { email: s.a, otp: wrongFor(c.a_r), password: await password(s.seed, "A-wrong") });
  ok("a wrong reset code is refused", !wrong.ok, show(wrong));
  const right = await auth("/email-otp/reset-password", { email: s.a, otp: c.a_r, password: await password(s.seed, "A2") });
  ok("the emailed reset code sets a new password", right.ok, show(right));
  const newPw = await auth("/sign-in/email", { email: s.a, password: await password(s.seed, "A2") });
  ok("the new password signs in", newPw.ok, show(newPw));
  const oldPw = await auth("/sign-in/email", { email: s.a, password: await password(s.seed, "A1") });
  ok("the old password no longer does", !oldPw.ok, show(oldPw));
  const reuse = await auth("/email-otp/reset-password", { email: s.a, otp: c.a_r, password: await password(s.seed, "A3") });
  ok("the reset code can't be used twice", !reuse.ok, show(reuse));
} else if (STEP === "expired") {
  const s = load();
  const c = await codes();
  const mins = (Date.now() - s.startedAt) / 60_000;
  ok("more than 15 minutes since B's code was sent", mins > 15, `${mins.toFixed(1)} min`);
  const late = await auth("/email-otp/reset-password", { email: s.b, otp: c.b_r, password: await password(s.seed, "B2") });
  ok("an expired reset code is refused", !late.ok, show(late));
  const oldPw = await auth("/sign-in/email", { email: s.b, password: await password(s.seed, "B1") });
  ok("…and B's password is unchanged", oldPw.ok, show(oldPw));
} else {
  throw new Error("STEP: keys | start | verify | reset | expired");
}
console.log(failures ? `${failures} FAILED` : "STEP PASSED");
process.exit(failures ? 1 : 0);
