/**
 * The deployed /api/auth-email (Preview): unsigned, wrongly signed and GET
 * requests are refused and nothing is sent. Only Neon (with its private key)
 * can make a request this endpoint accepts, so a full delivery can't be faked
 * from here — that is tested offline (auth-email.test.mjs) and, once enabled,
 * by real sign-ups.
 *
 * Also reads GET ?check (yes/no readiness: sender exactly as expected, provider key set,
 * which Neon Auth endpoint is trusted). With EXPECT_ENDPOINT set, readiness is required.
 *
 *   BASE=https://<deployment> [VERCEL_BYPASS=…] [EXPECT_ENDPOINT=ep-…] node scripts/test/email-handler-probe.mjs
 */
const { BASE, VERCEL_BYPASS, EXPECT_ENDPOINT } = process.env;
if (!BASE) throw new Error("Set BASE");
const H = VERCEL_BYPASS ? { "x-vercel-protection-bypass": VERCEL_BYPASS } : {};
let failures = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};
const url = `${BASE}/api/auth-email`;
const body = JSON.stringify({ event_id: crypto.randomUUID(), event_type: "send.otp", timestamp: new Date().toISOString(), user: { email: "probe@example.com" }, event_data: { otp_code: "000000", otp_type: "email-verification" } });
const get = await fetch(url, { headers: H });
ok("GET is refused (405)", get.status === 405, String(get.status));
const unsigned = await fetch(url, { method: "POST", headers: { ...H, "content-type": "application/json" }, body });
ok("an unsigned send.otp is refused (401)", unsigned.status === 401, String(unsigned.status));
const forged = await fetch(url, {
  method: "POST",
  headers: { ...H, "content-type": "application/json", "x-neon-signature": "eyJhbGciOiJFZERTQSJ9..AAAA", "x-neon-signature-kid": "not-a-neon-key", "x-neon-timestamp": String(Date.now()) },
  body,
});
ok("a forged signature is refused (401)", forged.status === 401, String(forged.status));
const check = await fetch(`${url}?check`, { headers: H });
const status = await check.json().catch(() => ({}));
console.log(`info readiness — ${JSON.stringify(status)}`);
if (EXPECT_ENDPOINT) {
  ok("sender is exactly “Amigo World <no-reply@amigoworld.com.ng>”", status.sender === "matches", status.sender);
  ok("provider key is set", status.provider_key === "present", status.provider_key);
  ok(`trusts the production Neon Auth endpoint (${EXPECT_ENDPOINT})`, status.auth_endpoint === EXPECT_ENDPOINT, status.auth_endpoint);
}
console.log(failures ? `${failures} FAILED` : "HANDLER PROBE PASSED");
process.exit(failures ? 1 : 0);
