/**
 * "Continue with Google", offline: the app in Neon mode (VITE_DATA_SOURCE=neon) in Chromium,
 * with Neon Auth answered by this test at the app's own /neon/auth/... and every other
 * request refused. No Google, no Neon, no accounts, no credentials.
 *
 *   - the button asks Neon Auth to start Google sign-in with the app's own return addresses
 *     (callbackURL, newUserCallbackURL, errorCallbackURL = /?auth_error=google) and the
 *     browser follows the URL Neon Auth answers with;
 *   - a refused start (e.g. an address Neon Auth doesn't trust) stays on the sign-in screen
 *     with a message;
 *   - back from Google cancelled (/?auth_error=google&error=access_denied): "cancelled", once,
 *     and the address bar is cleaned;
 *   - back from Google failed (any other error): "didn't finish";
 *   - back with a session verifier that can't be exchanged: the verifier goes to get-session
 *     through /neon/auth, the app ends on the sign-in screen saying "didn't finish", and the
 *     used verifier is dropped from the address bar;
 *   - email and password sign-in still goes to /neon/auth/sign-in/email and shows its own error.
 *
 * Not covered (needs a real Google account and the real Neon Auth): a completed Google sign-in,
 * which Google client is used, and what Neon's own callback does on Cancel
 * (scripts/test/google-oauth-probe.mjs checks those on a deployed site).
 *
 *   node scripts/test/google-signin-return.test.mjs
 */
import { createServer } from "vite";
import { createRequire } from "node:module";

// The project's Playwright if installed (CI: npm i --no-save playwright), else a global one (NODE_PATH).
const { chromium } = await import("playwright").catch(() => createRequire(import.meta.url)("playwright"));

let failures = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};

// Vite gives process.env the last word over .env files, so this build is Neon mode whatever is on disk.
process.env.VITE_DATA_SOURCE = "neon";
const server = await createServer({ logLevel: "error", server: { host: "127.0.0.1", port: 0, strictPort: false } });
await server.listen();
const BASE = `http://127.0.0.1:${server.httpServer.address().port}`;
const GOOGLE = "https://accounts.google.com/o/oauth2/v2/auth";

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 664 } });

// Nothing leaves this machine. The one "Google" page is answered here, never fetched.
const outside = [];
await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => {
  const url = route.request().url();
  if (url.startsWith(GOOGLE)) return route.fulfill({ status: 200, contentType: "text/html", body: "<title>Google (test stand-in)</title><p>Google sign-in</p>" });
  outside.push(url);
  return route.abort();
});

// Neon Auth and the Data API, as this test says. Each case sets what sign-in/social answers.
let socialAnswer = { status: 200, body: { url: `${GOOGLE}?client_id=test&state=test`, redirect: true } };
const calls = [];
await context.route(`${BASE}/neon/**`, async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  const path = url.pathname.replace(/^\/neon/, "");
  calls.push({ method: req.method(), path, search: url.search, body: req.postData() ?? "" });
  const json = (status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  if (path === "/auth/get-session") return json(200, null); // signed out (and any verifier refused)
  if (path === "/auth/sign-in/social") return json(socialAnswer.status, socialAnswer.body);
  if (path === "/auth/sign-in/email") return json(401, { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" });
  if (path.startsWith("/rest/")) return json(200, []);
  return json(404, { message: "not mocked" });
});

const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

const googleButton = () => page.getByRole("button", { name: /Continue with Google/i });
const alertText = async () => ((await page.getByRole("alert").first().textContent({ timeout: 5000 }).catch(() => "")) ?? "").trim();
const query = () => new URL(page.url()).search;

try {
  // ---- 1. Starting Google sign-in
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  ok("the sign-in screen shows Continue with Google (Neon mode)", await googleButton().waitFor({ timeout: 30000 }).then(() => true, () => false));
  await googleButton().click();
  const reached = await page.waitForURL((u) => u.href.startsWith(GOOGLE), { timeout: 10000 }).then(() => true, () => false);
  const start = calls.find((c) => c.path === "/auth/sign-in/social");
  let args = {};
  try {
    args = JSON.parse(start?.body ?? "{}");
  } catch {}
  ok("the app asks Neon Auth to start Google sign-in through its own /neon/auth", start?.method === "POST", start ? `${start.method} ${start.path}` : "no request");
  ok("…for Google", args.provider === "google", String(args.provider));
  ok("…coming back to the app after sign-in", args.callbackURL === `${BASE}/`, String(args.callbackURL));
  ok("…and after creating an account", args.newUserCallbackURL === `${BASE}/`, String(args.newUserCallbackURL));
  ok("…and to the sign-in screen on cancel or failure", args.errorCallbackURL === `${BASE}/?auth_error=google`, String(args.errorCallbackURL));
  ok("the browser goes to the address Neon Auth answers with", reached, page.url());

  // ---- 2. Neon Auth refuses to start (e.g. this address isn't a trusted origin)
  socialAnswer = { status: 403, body: { code: "INVALID_ORIGIN", message: "Invalid origin" } };
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await googleButton().waitFor({ timeout: 30000 });
  await googleButton().click();
  const refused = await alertText();
  ok("a refused start stays on the sign-in screen with a message", refused.length > 0 && page.url().startsWith(BASE), refused);
  ok("…and the button can be pressed again", await googleButton().isEnabled());
  socialAnswer = { status: 200, body: { url: `${GOOGLE}?client_id=test&state=test`, redirect: true } };

  // ---- 3. Back from Google: cancelled
  await page.goto(`${BASE}/?auth_error=google&error=access_denied`, { waitUntil: "load" });
  await googleButton().waitFor({ timeout: 30000 });
  const cancelled = await alertText();
  ok("Cancel on Google: the sign-in screen says it was cancelled", /cancelled/i.test(cancelled), cancelled);
  ok("…and the address bar is cleaned", query() === "", query());
  await page.reload({ waitUntil: "load" });
  await googleButton().waitFor({ timeout: 30000 });
  ok("…said once: a reload shows no message", (await page.getByRole("alert").count()) === 0);

  // ---- 4. Back from Google: failed for another reason
  await page.goto(`${BASE}/?auth_error=google&error=server_error&error_description=x`, { waitUntil: "load" });
  await googleButton().waitFor({ timeout: 30000 });
  const failed = await alertText();
  ok("A failed Google sign-in: the sign-in screen says it didn't finish", /didn.t finish/i.test(failed), failed);
  ok("…and the address bar is cleaned", query() === "", query());

  // ---- 5. Back with a session verifier that can't be exchanged
  const before = calls.length;
  await page.goto(`${BASE}/?neon_auth_session_verifier=test-not-a-real-verifier`, { waitUntil: "load" });
  const landed = await googleButton().waitFor({ timeout: 30000 }).then(() => true, () => false);
  const exchange = calls.slice(before).find((c) => c.path === "/auth/get-session" && c.search.includes("neon_auth_session_verifier"));
  ok("the verifier is exchanged through the app's own /neon/auth", !!exchange, exchange ? `${exchange.method} ${exchange.path}` : "no get-session with the verifier");
  ok("a failed exchange ends on the sign-in screen, not a spinner", landed);
  const notFinished = await alertText();
  ok("…saying Google sign-in didn't finish", /didn.t finish/i.test(notFinished), notFinished);
  ok("…with the used verifier gone from the address bar", !page.url().includes("neon_auth_session_verifier"), query());

  // ---- 6. Email and password sign-in is unaffected
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await googleButton().waitFor({ timeout: 30000 });
  await page.getByLabel(/email/i).first().fill("someone@example.test");
  await page.getByLabel(/password/i).first().fill("not-the-password");
  const beforeEmail = calls.length;
  await page.locator("form").getByRole("button", { name: /^(sign in|log in)$/i }).first().click();
  const wrong = await alertText();
  ok("email sign-in still goes to Neon Auth's email route", calls.slice(beforeEmail).some((c) => c.path === "/auth/sign-in/email" && c.method === "POST"));
  ok("…and a wrong password says so", /don.t match/i.test(wrong), wrong);

  ok("nothing was sent outside this machine", outside.length === 0, outside.slice(0, 3).join(", "));
  ok("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (e) {
  failures++;
  console.log(`FAIL ${e?.message ?? e}`);
} finally {
  await browser.close();
  await server.close();
}
console.log(failures ? `${failures} FAILURE(S)` : "ALL GOOGLE SIGN-IN RETURN TESTS PASSED");
process.exit(failures ? 1 : 0);
