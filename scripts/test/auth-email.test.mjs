/**
 * The Neon Auth email webhook (api/auth-email.ts) and its templates, offline:
 * a local Ed25519 key signs requests exactly as Neon documents (detached JWS
 * over base64url(timestamp + "." + base64url(body))), its JWKS and the Resend
 * API are stand-ins. Checks: genuine requests send one email with Neon's code;
 * bad / tampered / unsigned / stale / unknown-key requests are refused and send
 * nothing; duplicates are dropped; provider failures ask Neon to retry; codes
 * never reach the logs; the email has no images, scripts or tracking and has a
 * plain-text twin. Writes the rendered emails to OUT (default: ./email-previews).
 *
 *   node scripts/test/auth-email.test.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "vite";

let failures = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};

const AUTH = "https://ep-test.neonauth.example.test/neondb/auth";
process.env.RESEND_API_KEY = "re_test_not_a_real_key";
process.env.EMAIL_FROM = "Amigo World <no-reply@amigoworld.com.ng>";
process.env.NEON_AUTH_URL = AUTH;

// ------------------------------------------------------------ keys (a stand-in for Neon's)
const kid = "kid-test-1";
const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid, alg: "EdDSA", use: "sig" };
const other = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const b64url = (b) => Buffer.from(b).toString("base64url");
async function sign(body, { ts = Date.now(), key = privateKey, keyId = kid } = {}) {
  const header = b64url(JSON.stringify({ alg: "EdDSA", kid: keyId, b64: true }));
  const input = `${header}.${b64url(`${ts}.${b64url(body)}`)}`;
  const sig = b64url(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(input))));
  return { "x-neon-signature": `${header}..${sig}`, "x-neon-signature-kid": keyId, "x-neon-timestamp": String(ts) };
}

// ------------------------------------------------------------ fetch stand-in
let sent = [];
let resendStatus = 200;
let jwksFetches = 0;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url === `${AUTH}/.well-known/jwks.json`) {
    jwksFetches++;
    return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  }
  if (url === "https://api.resend.com/emails") {
    sent.push({ headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(resendStatus === 200 ? { id: "email_1" } : { message: "nope" }), { status: resendStatus });
  }
  throw new Error(`unexpected fetch ${url}`);
};
const logs = [];
const realLog = console.log;
const capture = (...a) => logs.push(a.join(" "));

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "silent" });
const { default: handler } = await vite.ssrLoadModule("/api/auth-email.ts");
const { codeEmail, linkEmail } = await vite.ssrLoadModule("/api/_authEmail.ts");

const CODE = "482913";
const event = (over = {}) => ({
  event_id: crypto.randomUUID(),
  event_type: "send.otp",
  timestamp: new Date().toISOString(),
  context: { endpoint_id: "ep-test", project_name: "amigo-world" },
  user: { email: "new.member@example.com", name: "New Member" },
  event_data: { otp_code: CODE, otp_type: "email-verification", expires_at: new Date(Date.now() + 5 * 60_000).toISOString(), ip_address: "192.0.2.1", user_agent: "test" },
  ...over,
});
async function call(body, headers) {
  console.log = capture;
  try {
    const res = await handler(new Request("https://amigoworld.com.ng/api/auth-email", { method: "POST", headers: { "content-type": "application/json", ...headers }, body }));
    return res.status;
  } finally {
    console.log = realLog;
  }
}

try {
  // 1. A genuine verification code
  const e1 = event();
  const raw1 = JSON.stringify(e1);
  ok("a genuine send.otp is accepted", (await call(raw1, await sign(raw1))) === 200);
  ok("…one email is sent", sent.length === 1, String(sent.length));
  const m = sent[0]?.body ?? {};
  ok("…from Amigo World <no-reply@amigoworld.com.ng>", m.from === "Amigo World <no-reply@amigoworld.com.ng>", m.from);
  ok("…to the person's address", JSON.stringify(m.to) === JSON.stringify(["new.member@example.com"]));
  ok("…subject “Verify your email • Amigo World”", m.subject === "Verify your email • Amigo World", m.subject);
  ok("…the HTML shows Neon's code", m.html?.includes(`>${CODE}<`));
  ok("…the plain-text part shows Neon's code", m.text?.includes(`Your verification code: ${CODE}`));
  ok("…and says when it expires (5 minutes, Neon's lifetime)", m.text?.includes("expires in 5 minutes") && m.html?.includes("expires in 5 minutes"));
  ok("…idempotency key is the Neon event id", sent[0]?.headers["idempotency-key"] === `neon-${e1.event_id}`);
  ok("…API key only in the Authorization header", sent[0]?.headers.authorization === "Bearer re_test_not_a_real_key" && !JSON.stringify(m).includes("re_test"));
  ok("no images, scripts, iframes, forms or tracking pixels", !/<img|<script|<iframe|<form|<link\s/i.test(m.html ?? ""));
  ok("no remote resources (only a link to the official site)", [...(m.html ?? "").matchAll(/https?:\/\/[^"'\s<)]+/g)].every((x) => x[0] === "https://amigoworld.com.ng"));
  ok("the code is one unbroken string (copies in one go)", new RegExp(`>${CODE}<`).test(m.html ?? ""));
  const preheader = (m.html ?? "").match(/<div style="display:none[^>]*>([^<]*)</)?.[1] ?? "";
  ok("the code is not in the subject", !m.subject?.includes(CODE), m.subject);
  ok("the code is not in the inbox preview line", !!preheader && !preheader.includes(CODE), preheader.slice(0, 60));
  ok("the code appears only in the body (once in HTML, once in text)", (m.html.match(new RegExp(CODE, "g")) ?? []).length === 1 && (m.text.match(new RegExp(CODE, "g")) ?? []).length === 1);
  ok("the code never reaches the logs", !logs.join("\n").includes(CODE), logs.join(" | "));

  // 1b. Expiry comes from Neon's own times in the event (issue → expiry), not from a fixed number.
  for (const [mins, label] of [[5, "5 minutes"], [10, "10 minutes"], [15, "15 minutes"], [60, "60 minutes"]]) {
    const issued = new Date(Date.now() - 90_000); // Neon issued it a moment ago
    const e = event({ timestamp: issued.toISOString(), event_data: { ...event().event_data, expires_at: new Date(issued.getTime() + mins * 60_000).toISOString() } });
    const raw = JSON.stringify(e);
    await call(raw, await sign(raw));
    ok(`Neon expiry of ${mins} min → “expires in ${label}”`, sent.at(-1).body.text.includes(`expires in ${label}.`), sent.at(-1).body.text.match(/expires[^.]*\./)?.[0]);
  }
  {
    const e = event({ event_data: { otp_code: CODE, otp_type: "email-verification" } });
    const raw = JSON.stringify(e);
    await call(raw, await sign(raw));
    ok("no expiry from Neon → “expires soon” (never a guessed time)", sent.at(-1).body.text.includes("This code expires soon."));
  }
  sent = sent.slice(0, 1);

  // 2. Duplicate delivery (Neon retry with the same event id)
  ok("a repeated delivery of the same event is accepted…", (await call(raw1, await sign(raw1))) === 200);
  ok("…but no second email is sent", sent.length === 1, String(sent.length));

  // 3. Refusals
  const e2 = event();
  const raw2 = JSON.stringify(e2);
  const before = sent.length;
  ok("no signature → refused", (await call(raw2, {})) === 401);
  ok("signed by another key → refused", (await call(raw2, await sign(raw2, { key: other.privateKey }))) === 401);
  ok("body changed after signing → refused", (await call(raw2.replace(CODE, "000000"), await sign(raw2))) === 401);
  ok("timestamp changed after signing → refused", (await call(raw2, { ...(await sign(raw2)), "x-neon-timestamp": String(Date.now() - 1000) })) === 401);
  ok("signed 6 minutes ago → refused (replay)", (await call(raw2, await sign(raw2, { ts: Date.now() - 6 * 60_000 }))) === 401);
  ok("unknown key id → refused", (await call(raw2, await sign(raw2, { keyId: "kid-unknown" }))) === 401);
  ok("…and refused requests sent nothing", sent.length === before, String(sent.length - before));
  ok("the key list is fetched once and reused (an unknown key can refetch it at most every 30 s)", jwksFetches === 1, String(jwksFetches));
  const eW = event({ context: { endpoint_id: "ep-another-branch", project_name: "amigo-world" } });
  const rawW = JSON.stringify(eW);
  ok("validly signed but from another Neon Auth endpoint (e.g. a branch that copied the keys) → refused", (await call(rawW, await sign(rawW))) === 403 && sent.length === before);
  ok("GET → 405", (await handler(new Request("https://amigoworld.com.ng/api/auth-email"))).status === 405);

  // 4. Other kinds
  for (const [type, subject, label] of [
    ["forget-password", "Reset your password • Amigo World", "Your password reset code"],
    ["sign-in", "Your sign-in code • Amigo World", "Your sign-in code"],
  ]) {
    const e = event({ event_data: { ...event().event_data, otp_type: type } });
    const raw = JSON.stringify(e);
    ok(`${type}: accepted and sent`, (await call(raw, await sign(raw))) === 200 && sent.at(-1).body.subject === subject && sent.at(-1).body.text.includes(`${label}: ${CODE}`));
  }
  const link = event({ event_type: "send.magic_link", event_data: { link_type: "email-verification", link_url: "https://auth.example.test/verify?token=abc", token: "abc", expires_at: new Date(Date.now() + 60 * 60_000).toISOString() } });
  const rawL = JSON.stringify(link);
  ok("send.magic_link (email change / verification link): sent with the button", (await call(rawL, await sign(rawL))) === 200 && sent.at(-1).body.html.includes('href="https://auth.example.test/verify?token=abc"'));
  ok("…and the link never reaches the logs", !logs.join("\n").includes("token=abc"));
  const badLink = event({ event_type: "send.magic_link", event_data: { link_type: "sign-in", link_url: "javascript:alert(1)" } });
  const rawB = JSON.stringify(badLink);
  ok("a link that isn't https is refused", (await call(rawB, await sign(rawB))) === 400);
  const other1 = event({ event_type: "user.created", event_data: {} });
  const rawO = JSON.stringify(other1);
  const n = sent.length;
  ok("other events are acknowledged and ignored", (await call(rawO, await sign(rawO))) === 200 && sent.length === n);

  // 5. Provider trouble: Neon should retry, and a later retry may send.
  resendStatus = 500;
  const e3 = event();
  const raw3 = JSON.stringify(e3);
  ok("provider error → 502 (Neon retries)", (await call(raw3, await sign(raw3))) === 502);
  resendStatus = 200;
  ok("…the retry of the same event then sends", (await call(raw3, await sign(raw3))) === 200 && sent.at(-1).headers["idempotency-key"] === `neon-${e3.event_id}`);

  // 6. Not configured: refuse rather than silently drop (Neon shows an error).
  delete process.env.RESEND_API_KEY;
  const e4 = event();
  const raw4 = JSON.stringify(e4);
  ok("without a provider key → 503 (never a silent drop)", (await call(raw4, await sign(raw4))) === 503);
  ok("nothing in any log line contains a code or link", !logs.join("\n").match(/482913|token=|https:\/\/(ep-test|auth)\.[a-z.]*example/), logs.slice(0, 3).join(" | "));

  // 7. Previews
  const OUT = process.env.OUT ?? "email-previews";
  mkdirSync(OUT, { recursive: true });
  const exp = 15;
  for (const [name, email] of [
    ["verify-email", codeEmail("email-verification", CODE, exp)],
    ["reset-password", codeEmail("forget-password", CODE, exp)],
    ["sign-in-code", codeEmail("sign-in", CODE, exp)],
    ["verify-link", linkEmail("email-verification", "https://amigoworld.com.ng/example-link", 60)],
  ]) {
    writeFileSync(`${OUT}/${name}.html`, email.html);
    writeFileSync(`${OUT}/${name}.txt`, `Subject: ${email.subject}\n\n${email.text}\n`);
  }
  ok("previews written", true, OUT);
} catch (e) {
  failures++;
  console.log = realLog;
  console.log(`FAIL stopped: ${e?.stack ?? e}`);
} finally {
  await vite.close();
}
console.log(failures ? `${failures} FAILED` : "ALL AUTH EMAIL TESTS PASSED");
process.exit(failures ? 1 : 0);
