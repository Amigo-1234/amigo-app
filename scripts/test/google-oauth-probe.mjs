/**
 * "Continue with Google" on a deployed site, without signing in to Google (no account
 * is created or changed):
 *
 *   1. tap the button: what the app asks Neon Auth for, the URL Google is opened with
 *      (redirect_uri, client), the cookies set on the app's own domain (names only), and
 *      what Google shows (its sign-in page, or an error such as redirect_uri_mismatch);
 *   2. cancel: Google's "back to the app" redirect as it arrives when someone presses
 *      Cancel (error=access_denied with the real state) — where does the browser end up?
 *   3. coming back: the app opened with a session verifier, as after a sign-in (a made-up
 *      one, so it must fail): the app must leave the loading screen and say what happened.
 *
 * Prints hosts, paths, statuses and parameter names; never state values, codes, cookies
 * or tokens. Leaves one short-lived OAuth state record per run in Neon Auth (it expires).
 *
 *   BASE=https://amigoworld.com.ng [ENGINE=webkit] node scripts/test/google-oauth-probe.mjs
 */
import { createRequire } from "node:module";

const pw = await import("playwright").catch(() => createRequire(import.meta.url)("playwright"));
const BASE = (process.env.BASE ?? "https://amigoworld.com.ng").replace(/\/+$/, "");
const ENGINE = process.env.ENGINE ?? "chromium";
const BYPASS = process.env.VERCEL_BYPASS ? { "x-vercel-protection-bypass": process.env.VERCEL_BYPASS } : {};
let issues = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "ISSUE"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) issues++;
};
const info = (label, extra) => console.log(`info ${label} — ${extra}`);
const SHOWN = new Set(["redirect_uri", "response_type", "scope", "client_id", "prompt", "access_type", "error", "auth_error"]);
const show = (u) => {
  try {
    const x = new URL(u);
    const qs = [...x.searchParams.keys()].map((k) => (SHOWN.has(k) ? `${k}=${x.searchParams.get(k)}` : `${k}=…`)).join("&");
    return `${x.origin}${x.pathname}${qs ? `?${qs}` : ""}`;
  } catch {
    return String(u).slice(0, 120);
  }
};

const browser = await pw[ENGINE].launch();
const context = await browser.newContext({
  ...(ENGINE === "webkit" ? pw.devices["iPhone 13"] : { viewport: { width: 1280, height: 800 } }),
  extraHTTPHeaders: BYPASS,
});
const page = await context.newPage();
const seen = [];
page.on("response", async (r) => {
  const u = r.url();
  if (!/\/neon\/auth\/|neonauth|accounts\.google\.com|\/o\/oauth2/.test(u)) return;
  const h = await r.allHeaders().catch(() => ({}));
  const cookies = (h["set-cookie"] ?? "")
    .split("\n")
    .filter(Boolean)
    .map((c) => `${c.split("=")[0]}${/;\s*domain=/i.test(c) ? "(domain)" : ""}${(/samesite=\w+/i.exec(c) ?? [""])[0] ? ` ${/samesite=\w+/i.exec(c)[0]}` : ""}`);
  const line = `${r.request().method()} ${r.status()} ${show(u)}${h.location ? ` → ${show(h.location)}` : ""}${cookies.length ? ` · sets ${cookies.join(", ")}` : ""}`;
  seen.push({ url: u, status: r.status(), location: h.location ?? "", line });
  console.log(`     ${line}`);
});

try {
  // ---- 1. The button
  console.log(`\n== ${ENGINE}: ${BASE}`);
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  const button = page.getByRole("button", { name: /Continue with Google/i });
  ok("the sign-in screen shows Continue with Google", await button.waitFor({ timeout: 30000 }).then(() => true, () => false));
  await button.click();
  const reached = await page.waitForURL(/accounts\.google\.com/, { timeout: 30000 }).then(() => true, () => false);
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await page.waitForTimeout(2000);
  const social = seen.find((s) => /\/sign-in\/social/.test(s.url));
  ok("the app asked Neon Auth to start Google sign-in (same-origin /neon/auth)", !!social && social.url.startsWith(`${BASE}/neon/auth/`) && social.status < 400, social?.line ?? "no request");
  ok("the browser went to Google", reached, show(page.url()));
  const authorize = seen.find((s) => /accounts\.google\.com\/(o\/oauth2|signin\/oauth)/.test(s.url))?.url ?? (reached ? page.url() : "");
  let redirectUri = "";
  let state = "";
  try {
    const a = new URL(authorize);
    redirectUri = a.searchParams.get("redirect_uri") ?? "";
    state = a.searchParams.get("state") ?? "";
    info("Google client", a.searchParams.get("client_id") ?? "?");
  } catch {}
  info("redirect_uri sent to Google", redirectUri || "(none)");
  // Own Google credentials: the branch's {NEON_AUTH_BASE_URL}/callback/google. Neon's shared development
  // credentials: one Neon-wide callback (and Google names neon.tech, not the app).
  const own = /^https:\/\/[^/]+\.neonauth\.[^/]+\/neondb\/auth\/callback\/google$/.test(redirectUri);
  const shared = /^https:\/\/neonauth\.[^/]+\/auth\/oauth\/callback\/google$/.test(redirectUri);
  ok("redirect_uri is a Neon Auth Google callback", own || shared, redirectUri);
  info("Google credentials", own ? "the project's own" : shared ? "Neon's SHARED development app (Google shows neon.tech; Neon says not for production)" : "unknown");
  const text = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
  info("Google page", `${await page.title().catch(() => "")} | ${text.slice(0, 300)}`);
  ok("Google shows its sign-in page (no error)", reached && !/error 400|redirect_uri_mismatch|access blocked|invalid_request|not allowed/i.test(text), "");
  info("names shown on Google's page", (text.match(/(continue to|to continue to)\s+[^\s]+/i) ?? ["(none)"])[0]);
  const appCookies = (await context.cookies(BASE)).map((c) => `${c.name}${c.httpOnly ? " httpOnly" : ""} ${c.sameSite}`);
  info("cookies on the app's domain after starting", appCookies.join(", ") || "(none)");

  // ---- 2. Cancel on Google: Google redirects back with error=access_denied and the same state.
  if (redirectUri && state) {
    const cancel = new URL(redirectUri);
    cancel.searchParams.set("error", "access_denied");
    cancel.searchParams.set("state", state);
    await page.goto(cancel.toString(), { waitUntil: "load" }).catch(() => undefined);
    await page.waitForTimeout(3000);
    const landed = page.url();
    info("after Cancel the browser is at", show(landed));
    ok("Cancel returns to the app (not a Neon Auth error page)", landed.startsWith(`${BASE}/`), show(landed));
    const body = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
    info("it shows", body.slice(0, 200));
    ok("…and says sign-in was cancelled or failed", /cancel|didn.t finish|couldn.t sign|try again/i.test(body), "");
  } else ok("cancel probe ran", false, "no redirect_uri/state captured");

  // ---- 3. Coming back with a session verifier (a made-up one: must fail cleanly)
  await page.goto(`${BASE}/?neon_auth_session_verifier=probe-not-a-real-verifier`, { waitUntil: "load" });
  await page.waitForTimeout(6000);
  const gs = seen.filter((s) => /\/get-session/.test(s.url) && /neon_auth_session_verifier/.test(s.url));
  ok("the app exchanges the verifier through its own domain", gs.some((s) => s.url.startsWith(`${BASE}/neon/auth/`)), gs.map((s) => s.line).join(" | ") || "no get-session with the verifier");
  const after = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
  ok("a failed return ends on the sign-in screen, not a spinner", /Continue with Google|Sign in|Log in/i.test(after), after.slice(0, 120));
  ok("…saying Google sign-in didn't finish", /didn.t finish/i.test(after), "");
  ok("…with the used verifier gone from the address bar", !page.url().includes("neon_auth_session_verifier"), show(page.url()));
} catch (e) {
  issues++;
  console.log(`ISSUE ${e?.message ?? e}`);
} finally {
  await browser.close();
}
console.log(issues ? `${issues} ISSUE(S)` : "NO ISSUES");
process.exit(0);
