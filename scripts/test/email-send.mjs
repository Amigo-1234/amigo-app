/**
 * Sends the branded sign-in emails (verification code, password reset code)
 * straight through Resend to a test inbox, so delivery, rendering and SPF /
 * DKIM / DMARC can be checked before Neon Auth is switched over. The codes are
 * clearly marked samples (never real ones). Prints only Resend's message ids.
 *
 *   RESEND_API_KEY=… TEST_TO=you@example.com [EMAIL_FROM="Amigo World <no-reply@amigoworld.com.ng>"] \
 *     node scripts/test/email-send.mjs
 */
import { createServer } from "vite";

const { RESEND_API_KEY, TEST_TO } = process.env;
const FROM = process.env.EMAIL_FROM || "Amigo World <no-reply@amigoworld.com.ng>";
if (!RESEND_API_KEY || !TEST_TO) throw new Error("Set RESEND_API_KEY and TEST_TO");
// The sender must be on the domain verified in Resend (amigoworld.com.ng).
const fromAddress = FROM.match(/<([^>]+)>/)?.[1] ?? FROM;
if (!/@amigoworld\.com\.ng$/i.test(fromAddress)) throw new Error(`EMAIL_FROM must be an @amigoworld.com.ng address (got ${fromAddress})`);
console.log(`info sender — ${FROM}`);
let failures = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "silent" });
const { codeEmail } = await vite.ssrLoadModule("/api/_authEmail.ts");
await vite.close();

const run = new Date().toISOString().slice(0, 16).replace("T", " ");
for (const [kind, sample] of [["email-verification", "135790"], ["forget-password", "246802"]]) {
  const email = codeEmail(kind, sample, 15);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [TEST_TO], subject: email.subject, html: email.html, text: email.text, tags: [{ name: "kind", value: `test_${kind.replace(/-/g, "_")}` }] }),
  });
  const body = await res.json().catch(() => ({}));
  ok(`${kind}: accepted by Resend (sample code, test run ${run})`, res.ok && !!body.id, res.ok ? `id ${body.id}` : `${res.status} ${body.name ?? ""} ${body.message ?? ""}`.trim());
}
console.log(failures ? `${failures} FAILED` : "TEST EMAILS SENT");
process.exit(failures ? 1 : 0);
