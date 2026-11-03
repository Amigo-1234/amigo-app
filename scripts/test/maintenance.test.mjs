/**
 * The access gate (middleware.ts), called directly with real Requests, offline:
 *
 *   - off (unset or not "on"): nothing is touched;
 *   - on: every page, app file, sign-in/sign-up (/neon) and api/ route is closed (503), except
 *     the two server-to-server routes and the gate page's own files; path tricks don't get past;
 *   - team access: the form, a wrong key, the right key (signed HttpOnly cookie), then the app
 *     opens; tampered, expired or old-key cookies don't; leaving clears it;
 *   - no key set (or a short one): nobody gets in.
 *
 *   node scripts/test/maintenance.test.mjs
 */
import { createServer } from "vite";

let failures = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};

const vite = await createServer({ logLevel: "error", server: { middlewareMode: true }, appType: "custom" });
const { default: gate } = await vite.ssrLoadModule("/middleware.ts");

const BASE = "https://amigoworld.com.ng";
const KEY = "test-key-" + "x".repeat(32);
const req = (path, init = {}) => new Request(BASE + path, init);
const env = (mode, key) => {
  if (mode === undefined) delete process.env.MAINTENANCE_MODE;
  else process.env.MAINTENANCE_MODE = mode;
  if (key === undefined) delete process.env.MAINTENANCE_ACCESS_KEY;
  else process.env.MAINTENANCE_ACCESS_KEY = key;
};
const closedPage = async (r) => r && r.status === 503 && (await r.clone().text()).includes("The Site Is Still Under Development");
const closedApi = async (r) => r && r.status === 503 && (await r.clone().json()).error === "unavailable";
const post = (path, body, headers = {}) =>
  req(path, { method: "POST", body: new URLSearchParams(body), headers: { "content-type": "application/x-www-form-urlencoded", ...headers } });

try {
  // ------------------------------------------------------------------ off
  for (const mode of [undefined, "off", "ON", ""]) {
    env(mode, KEY);
    const results = await Promise.all(["/", "/admin", "/neon/auth/sign-up/email", "/api/push-notify", "/_team"].map((p) => gate(req(p))));
    ok(`off (MAINTENANCE_MODE=${JSON.stringify(mode)}): every request passes untouched`, results.every((r) => r === undefined));
  }

  // ------------------------------------------------------------------ on, no access
  env("on", KEY);
  const pages = ["/", "/index.html", "/u/amigoisaboy", "/market", "/b/kofis_kitchen", "/l/123", "/post/abc", "/settings", "/admin", "/admin/reservations", "/explore", "/messages", "/business", "/legal/privacy", "/assets/index-abc123.js", "/sw.js", "/manifest.webmanifest", "/version.json", "/offline.html"];
  for (const p of pages) ok(`on: ${p} → the under-development page (503)`, await closedPage(await gate(req(p))));
  const r0 = await gate(req("/"));
  ok("on: the page isn't cached or indexed", r0.headers.get("cache-control") === "no-store" && r0.headers.get("x-robots-tag") === "noindex" && r0.headers.get("retry-after") === "3600");
  ok("on: HEAD gets the 503 without a body", (await gate(req("/", { method: "HEAD" }))).status === 503);

  const apis = [
    ["/neon/auth/sign-up/email", "POST"], ["/neon/auth/sign-in/email", "POST"], ["/neon/auth/get-session", "GET"], ["/neon/rest/v1/posts", "GET"],
    ["/neon", "GET"], ["/api/neon", "GET"], ["/api/push-notify", "POST"], ["/api/worlds-tick", "POST"], ["/api/media-upload", "POST"], ["/api/media/abc", "GET"],
    ["/api/e2e-backup", "POST"], ["/api/push-config", "GET"], ["/api", "GET"],
  ];
  for (const [p, method] of apis) ok(`on: ${method} ${p} → 503 JSON`, await closedApi(await gate(req(p, { method }))));

  for (const p of ["/api/auth-email", "/api/media-cleanup", "/_maintenance/fonts/geist-latin-wght-normal.woff2", "/favicon.svg", "/favicon.ico"]) {
    ok(`on: ${p} stays open`, (await gate(req(p, { method: p.startsWith("/api/auth") ? "POST" : "GET" }))) === undefined);
  }
  for (const p of ["/_maintenance/../index.html", "/_maintenance/%2e%2e/admin", "/api/auth-email/../neon/auth/sign-up/email", "/api/auth-email/x", "/API/AUTH-EMAIL", "/api/auth-email%2f..%2fneon"]) {
    const r = await gate(req(p));
    ok(`on: path trick ${p} doesn't get through`, r !== undefined && r.status === 503, String(r?.status));
  }

  // ------------------------------------------------------------------ team access
  let r = await gate(req("/_team"));
  let body = await r.text();
  ok("team: the form shows (200, not indexed)", r.status === 200 && body.includes("Access key") && r.headers.get("x-robots-tag") === "noindex");
  ok("team: the public page never links to it", !(await (await gate(req("/"))).text()).includes("/_team"));

  r = await gate(post("/_team", { key: "wrong" }));
  ok("team: a wrong key is refused (403, no cookie)", r.status === 403 && !r.headers.get("set-cookie") && (await r.text()).includes("That key isn"));
  r = await gate(post("/_team", {}));
  ok("team: an empty form is refused", r.status === 403 && !r.headers.get("set-cookie"));

  r = await gate(post("/_team", { key: KEY }));
  const setCookie = r.headers.get("set-cookie") ?? "";
  ok("team: the right key → back to the app with a cookie", r.status === 303 && r.headers.get("location") === "/");
  ok("team: the cookie is HttpOnly, Secure, SameSite=Lax, 30 days", /HttpOnly/.test(setCookie) && /Secure/.test(setCookie) && /SameSite=Lax/.test(setCookie) && /Max-Age=2592000/.test(setCookie));
  ok("team: the cookie doesn't contain the key", !setCookie.includes(KEY));
  const token = /amigo_team_access=([^;]+)/.exec(setCookie)?.[1] ?? "";
  const withCookie = (path, value = token, init = {}) => req(path, { ...init, headers: { cookie: `other=1; amigo_team_access=${value}` } });

  for (const p of ["/", "/admin/reservations", "/assets/index-abc123.js", "/neon/auth/sign-in/email", "/neon/rest/v1/posts", "/api/push-notify"]) {
    ok(`team: ${p} opens with the cookie`, (await gate(withCookie(p))) === undefined);
  }
  r = await gate(withCookie("/_team"));
  ok("team: /_team says access is on, with a way to turn it off", r.status === 200 && (await r.text()).includes("Team access is on"));

  const [v, exp, sig] = token.split(".");
  const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
  ok("team: a tampered signature doesn't open it", await closedPage(await gate(withCookie("/", `${v}.${exp}.${flipped}`))));
  ok("team: a longer expiry with the old signature doesn't open it", await closedPage(await gate(withCookie("/", `${v}.${Number(exp) + 86400 * 365}.${sig}`))));
  ok("team: junk cookies don't open it", await closedPage(await gate(withCookie("/", "v1.1.x"))) && await closedPage(await gate(withCookie("/", ""))));
  const realNow = Date.now;
  Date.now = () => realNow() + 31 * 86400 * 1000;
  ok("team: the cookie stops working after 30 days", await closedPage(await gate(withCookie("/"))));
  Date.now = realNow;

  r = await gate(req("/_team/leave", { method: "POST", headers: { cookie: `amigo_team_access=${token}` } }));
  ok("team: leaving clears the cookie", r.status === 303 && /amigo_team_access=;/.test(r.headers.get("set-cookie") ?? "") && /Max-Age=0/.test(r.headers.get("set-cookie") ?? ""));

  env("on", KEY + "-rotated");
  ok("team: changing the key signs every browser out", await closedPage(await gate(withCookie("/"))));

  // ------------------------------------------------------------------ no usable key
  env("on", undefined);
  ok("no key: the site stays closed", await closedPage(await gate(req("/"))));
  ok("no key: nothing gets team access", (await gate(post("/_team", { key: "" }))).status === 403 && (await gate(post("/_team", { key: "anything" }))).status === 403);
  env("on", "short-key");
  ok("short key (< 24 characters): not accepted", (await gate(post("/_team", { key: "short-key" }))).status === 403);
  ok("short key: old cookies don't open it either", await closedPage(await gate(withCookie("/"))));
} finally {
  await vite.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL ACCESS GATE TESTS PASSED");
process.exit(failures ? 1 : 0);
