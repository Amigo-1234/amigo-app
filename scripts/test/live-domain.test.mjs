/**
 * The official address (BASE, e.g. https://amigoworld.com.ng) next to the old
 * one (OLD, the Vercel address), checked from outside and in an iPhone-sized
 * browser (Chromium or WebKit):
 *
 *   address: HTTPS answers; www and http:// redirect to https://<apex>, path
 *   kept; the old address still serves the app (no redirect); security headers;
 *   what the manifest, social tags, canonical, robots.txt and sitemap say;
 *   response times.
 *   auth service: only trusted sites may sign up / start Google sign-in; the
 *   Google sign-in address is issued for the new address.
 *   in the browser: create an account (email code sent, a wrong code refused);
 *   sign in to an existing account; the session survives a reload and a new
 *   tab and stays on this address only; sign out (and stay out after a
 *   reload); "Forgot password?" sends a code and refuses a wrong one; signing
 *   in on the old address still works.
 *
 * Temporary accounts only, deleted at the end. Prints no secrets.
 *
 *   BASE=https://amigoworld.com.ng OLD=https://amigo-app-one.vercel.app VERCEL_BYPASS=… \
 *     [ENGINE=webkit] node scripts/test/live-domain.test.mjs
 */
import { randomBytes } from "node:crypto";
import { chromium, webkit, devices } from "playwright";

const { BASE, OLD, VERCEL_BYPASS, ENGINE = "chromium" } = process.env;
if (!BASE || !OLD || !VERCEL_BYPASS) throw new Error("Set BASE, OLD and VERCEL_BYPASS");
const BYPASS = { "x-vercel-protection-bypass": VERCEL_BYPASS };
const host = new URL(BASE).hostname;

let failures = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};
const info = (label, extra) => console.log(`info ${label}${extra ? ` — ${extra}` : ""}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

const tag = randomBytes(3).toString("hex");
const made = []; // { email, password }
async function deleteAccount(p) {
  const res = await fetch(`${BASE}/neon/auth/sign-in/email`, {
    method: "POST",
    headers: { ...BYPASS, origin: BASE, "content-type": "application/json" },
    body: JSON.stringify({ email: p.email, password: p.password }),
  });
  if (!res.ok) return `sign-in ${res.status}`;
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const { token } = await (await fetch(`${BASE}/neon/auth/token`, { headers: { ...BYPASS, origin: BASE, cookie } })).json();
  await sleep(800);
  const d = await fetch(`${BASE}/neon/rest/v1/rpc/delete_my_account`, {
    method: "POST",
    headers: { ...BYPASS, authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ p_confirm: "DELETE" }),
  });
  return d.status === 200 || d.status === 204 ? "deleted" : `NOT deleted (${d.status})`;
}

const browser = await (ENGINE === "webkit" ? webkit : chromium).launch();
console.log(`info browser engine: ${ENGINE} · ${host} (old: ${new URL(OLD).host})`);
const deadline = setTimeout(() => {
  console.log("FAIL took over 10 minutes; stopping");
  failures++;
  void browser.close();
}, 10 * 60_000);

try {
  // ------------------------------------------------------------ the address
  if (ENGINE === "chromium") {
    const www = await fetch(`https://www.${host}/u/someone?x=1`, { redirect: "manual" });
    ok("www redirects permanently to the apex, keeping the path", [301, 308].includes(www.status) && www.headers.get("location") === `${BASE}/u/someone?x=1`, `${www.status} → ${www.headers.get("location")}`);
    const plain = await fetch(`http://${host}/settings`, { redirect: "manual" }).catch((e) => ({ status: 0, headers: new Headers(), e }));
    ok("http:// redirects to https://", [301, 302, 307, 308].includes(plain.status) && (plain.headers.get("location") ?? "").startsWith(`https://${host}/settings`), `${plain.status} → ${plain.headers.get("location")}`);
    const home = await fetch(`${BASE}/`);
    const html = await home.text();
    ok("HTTPS serves the app", home.ok && /<title>Amigo World/i.test(html), String(home.status));
    const h = home.headers;
    ok("security headers (nosniff, frame DENY, referrer policy)", h.get("x-content-type-options") === "nosniff" && h.get("x-frame-options") === "DENY" && !!h.get("referrer-policy"));
    info("Strict-Transport-Security", h.get("strict-transport-security") ?? "none");
    const old = await fetch(`${OLD}/`, { headers: BYPASS, redirect: "manual" });
    ok("the old address still serves the app (no redirect)", old.status === 200, String(old.status));
    const deep = await fetch(`${BASE}/u/someone`);
    ok("deep links load the app on the new address", deep.ok && /<title>Amigo World/i.test(await deep.text()), String(deep.status));

    // What the page tells browsers, search engines and link previews.
    const meta = (prop) => html.match(new RegExp(`<meta[^>]+(?:property|name)="${prop}"[^>]+content="([^"]*)"`, "i"))?.[1] ?? null;
    const canonical = html.match(/<link[^>]+rel="canonical"[^>]+href="([^"]*)"/i)?.[1] ?? null;
    info("og:image / og:url / canonical", `${meta("og:image")} · ${meta("og:url")} · ${canonical}`);
    const manifestHref = html.match(/<link[^>]+rel="manifest"[^>]+href="([^"]*)"/i)?.[1];
    if (manifestHref) {
      const mf = await fetch(new URL(manifestHref, BASE));
      const m = await mf.json().catch(() => null);
      ok("the app manifest loads on the new address", mf.ok && !!m?.name, `${mf.status} ${m?.name ?? ""}`);
      if (m) info("manifest", `start_url=${m.start_url} scope=${m.scope ?? "-"} id=${m.id ?? "-"}`);
    } else info("manifest", "no <link rel=manifest>");
    for (const f of ["robots.txt", "sitemap.xml"]) {
      const r = await fetch(`${BASE}/${f}`);
      const body = await r.text();
      info(f, `${r.status} ${r.headers.get("content-type")} ${/<!doctype html/i.test(body) ? "(the app page, not a real file)" : body.slice(0, 80).replace(/\s+/g, " ")}`);
    }

    // Response times from this runner (not a phone network; for comparison between the addresses).
    const time = async (url, n = 5) => {
      const t = [];
      for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        const r = await fetch(url, { headers: url.startsWith(OLD) ? BYPASS : {} });
        await r.arrayBuffer();
        t.push(Math.round(performance.now() - t0));
      }
      return median(t);
    };
    const asset = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
    info("response time, median of 5 (page · main script · auth session)", `new ${await time(`${BASE}/`)} ms · ${asset ? await time(`${BASE}${asset}`) : "-"} ms · ${await time(`${BASE}/neon/auth/get-session`)} ms — old ${await time(`${OLD}/`)} ms`);

    // ------------------------------------------------------------ the auth service
    const evil = "https://amigo-phish.example";
    const foreign = await fetch(`${BASE}/neon/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: evil, "content-type": "application/json" },
      body: JSON.stringify({ email: `amigo-e2e-${tag}-evil@example.com`, password: randomBytes(18).toString("base64url"), name: "Evil" }),
    });
    ok("sign-up from another website is refused", foreign.status === 403 || foreign.status === 401, String(foreign.status));
    if (foreign.ok) made.push({ email: `amigo-e2e-${tag}-evil@example.com`, password: "" });
    const google = async (origin, callback) => {
      const r = await fetch(`${BASE}/neon/auth/sign-in/social`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ provider: "google", callbackURL: callback, disableRedirect: true }),
      });
      const j = await r.json().catch(() => ({}));
      return { status: r.status, url: j.url ? new URL(j.url) : null };
    };
    const g = await google(BASE, `${BASE}/`);
    // With Neon's shared Google credentials the address first goes through the auth service, which forwards to Google.
    let hop = g.url;
    for (let i = 0; i < 3 && hop && hop.host !== "accounts.google.com"; i++) {
      const r = await fetch(hop, { redirect: "manual" });
      const next = r.headers.get("location");
      hop = next ? new URL(next, hop) : null;
    }
    ok("“Continue with Google” on the new address leads to Google's sign-in", g.status === 200 && hop?.host === "accounts.google.com", `${g.status} ${g.url?.host ?? ""} → ${hop?.host ?? "?"}`);
    if (hop) info("Google returns to", hop.searchParams.get("redirect_uri") ?? "?");
    const gEvil = await google(BASE, `${evil}/`);
    ok("…but not for a callback to another website", gEvil.status >= 400 || !gEvil.url, String(gEvil.status));
  }

  // ------------------------------------------------------------ in the browser
  const phone = async (origin) => {
    const ctx = await browser.newContext({ ...devices["iPhone 13"], serviceWorkers: "block" });
    if (origin === OLD) await ctx.request.get(OLD, { headers: { ...BYPASS, "x-vercel-set-bypass-cookie": "true" }, maxRedirects: 0 }).catch(() => undefined);
    const page = await ctx.newPage();
    page.setDefaultTimeout(20000);
    return { ctx, page };
  };
  const problems = [];
  const agreeIfAsked = async (page) => {
    const agree = page.getByRole("button", { name: "I agree" });
    await agree.waitFor({ timeout: 6000 }).catch(() => undefined);
    if (await agree.isVisible().catch(() => false)) {
      await agree.click();
      await agree.waitFor({ state: "detached", timeout: 15000 }).catch(() => undefined);
    }
  };
  const signIn = async (page, origin, p) => {
    await page.goto(`${origin}/`, { waitUntil: "load" });
    await page.getByLabel("Email").fill(p.email);
    await page.getByLabel("Password", { exact: true }).fill(p.password);
    await page.locator("form.auth__form").getByRole("button", { name: "Sign in" }).click();
    await agreeIfAsked(page);
    return page.locator(".bottom-create").waitFor({ timeout: 30000 }).then(() => true, () => false);
  };

  // 1. A new account made on the new address.
  const n = { email: `amigo-e2e-${tag}-${ENGINE[0]}new@example.com`, password: randomBytes(18).toString("base64url") };
  {
    const { ctx, page } = await phone(BASE);
    page.on("pageerror", (e) => !/access control checks|^Load failed$/i.test(e.message) && problems.push(e.message.slice(0, 160)));
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    await page.getByRole("button", { name: "Create account" }).first().click();
    await page.getByLabel("Name").fill(`Domain ${tag}`);
    await page.getByLabel("Email").fill(n.email);
    await page.getByLabel("Password", { exact: true }).fill(n.password);
    for (const box of await page.locator(".auth-consent input[type=checkbox]").all()) await box.check();
    await page.locator("form.auth__form").getByRole("button", { name: "Create account" }).click();
    made.push(n);
    await agreeIfAsked(page);
    const verify = await page.getByRole("heading", { name: "Check your email" }).waitFor({ timeout: 30000 }).then(() => true, () => false);
    ok("sign-up on the new address → “Check your email” (verification code step)", verify, (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 160));
    if (verify) {
      await page.getByRole("button", { name: /Send a new code in \d+s/ }).waitFor({ timeout: 15000 }).catch(() => undefined);
      ok("…a verification code was sent", /in \d+s/.test((await page.getByRole("button", { name: /Send a new code/ }).textContent().catch(() => "")) ?? ""));
      await page.locator(".onb-code__input").fill("000000");
      ok("…a wrong code is refused", await page.locator(".onb__error").waitFor({ timeout: 15000 }).then(() => true, () => false));
    }
    await ctx.close();
  }

  // 2. An existing account signs in on the new address.
  const e = { email: `amigo-e2e-${tag}-${ENGINE[0]}old@example.com`, password: randomBytes(18).toString("base64url") };
  const su = await fetch(`${OLD}/neon/auth/sign-up/email`, {
    method: "POST",
    headers: { ...BYPASS, origin: OLD, "content-type": "application/json" },
    body: JSON.stringify({ ...e, name: `Existing ${tag}` }),
  });
  if (!su.ok) throw new Error(`existing account: ${su.status}`);
  made.push(e);
  await sleep(800);
  {
    const { ctx, page } = await phone(BASE);
    page.on("pageerror", (er) => !/access control checks|^Load failed$/i.test(er.message) && problems.push(er.message.slice(0, 160)));
    ok("an existing account (made on the old address) signs in on the new address", await signIn(page, BASE, e), (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 160));
    const cookies = await ctx.cookies();
    const session = cookies.find((c) => /session_token/i.test(c.name)) ?? cookies.find((c) => /session/i.test(c.name));
    ok("…session cookie: this address only, Secure, HttpOnly", !!session && session.domain === host && session.secure && session.httpOnly, session ? `${session.domain} ${session.sameSite}` : cookies.map((c) => c.name).join(","));
    await page.reload({ waitUntil: "load" });
    ok("…still signed in after a reload", await page.locator(".bottom-create").waitFor({ timeout: 30000 }).then(() => true, () => false));
    const tab = await ctx.newPage();
    await tab.goto(`${BASE}/settings`, { waitUntil: "load" });
    ok("…and in a new tab", await tab.locator(".bottom-create").waitFor({ timeout: 30000 }).then(() => true, () => false));
    await tab.close();

    // Sign out.
    await page.goto(`${BASE}/settings`, { waitUntil: "load" });
    await page.getByRole("button", { name: /Sign out/ }).last().click();
    const confirm = page.locator("dialog[open]").getByRole("button", { name: /Sign out/ });
    if (await confirm.waitFor({ timeout: 3000 }).then(() => true, () => false)) await confirm.click();
    ok("sign out returns to the sign-in screen", await page.getByRole("heading", { name: "Welcome back" }).waitFor({ timeout: 20000 }).then(() => true, () => false));
    await page.reload({ waitUntil: "load" });
    ok("…and stays signed out after a reload", await page.getByRole("heading", { name: "Welcome back" }).waitFor({ timeout: 20000 }).then(() => true, () => false));
    const sess = await page.evaluate(async () => (await (await fetch("/neon/auth/get-session")).text()).slice(0, 40));
    ok("…the server has no session for this browser", !/"session"\s*:\s*\{/.test(sess), sess);

    // Forgot password: a code is sent, a wrong one is refused, the password is unchanged.
    await page.getByRole("button", { name: "Forgot password?" }).click();
    await page.getByLabel("Email").fill(e.email);
    await page.locator("form.auth__form").getByRole("button", { name: /Send code|Send reset link/ }).click();
    const codeStep = await page.getByRole("heading", { name: "Check your email" }).waitFor({ timeout: 20000 }).then(() => true, () => false);
    ok("“Forgot password?” sends a reset code", codeStep, (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 160));
    if (codeStep) {
      await page.getByLabel("Code from your email").fill("000000").catch(async () => page.locator("input").first().fill("000000"));
      await page.getByLabel("New password", { exact: true }).fill(randomBytes(18).toString("base64url"));
      await page.locator("form.auth__form").getByRole("button", { name: "Set new password" }).click();
      ok("…a wrong reset code is refused", await page.locator(".auth__error").waitFor({ timeout: 15000 }).then(() => true, () => false));
    }
    await ctx.close();
    const again = await phone(BASE);
    ok("…and the password is unchanged (signing in still works)", await signIn(again.page, BASE, e));
    await again.ctx.close();
  }

  // 3. The old address is unaffected.
  {
    const { ctx, page } = await phone(OLD);
    ok("signing in on the old address still works", await signIn(page, OLD, e));
    await ctx.close();
  }
  ok("no uncaught errors", !problems.length, problems.slice(0, 3).join(" | "));
} catch (err) {
  failures++;
  console.log(`FAIL stopped: ${String(err?.message ?? err).slice(0, 300)}`);
} finally {
  clearTimeout(deadline);
  await browser.close().catch(() => undefined);
  for (const p of made) {
    if (!p.password) {
      console.log("cleanup: an account from another website was created — FAIL, remove it by hand");
      failures++;
      continue;
    }
    const r = await deleteAccount(p).catch((e) => `NOT deleted (${e.message})`);
    if (r !== "deleted") failures++;
    console.log(`cleanup: temporary account ${r}`);
  }
}
console.log(failures ? `${failures} FAILED` : "ALL DOMAIN TESTS PASSED");
process.exit(failures ? 1 : 0);
