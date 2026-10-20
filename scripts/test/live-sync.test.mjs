/**
 * "The app feels live": two temporary accounts on iPhone-sized browsers
 * (Chromium or WebKit), B never reloads:
 *
 *   1. A sends B five messages in a row while B is on Home → B gets a banner
 *      within seconds; opening it shows all five, in order.
 *   2. A likes B's post → B's notification badge and a banner update by themselves.
 *   3. A follows B → B's own profile shows the new follower count by itself.
 *   4. B's connection drops, A sends a message, the connection returns → it arrives.
 *   5. B switches away from the app, A sends a message, B comes back → it arrives at once.
 *   6. B is scrolled down Home and A posts → a "new posts" pill, the feed doesn't move.
 *   7. A new app version goes live while B is writing a post → an update notice,
 *      nothing reloads, the draft stays.
 *
 *   BASE=https://<domain> VERCEL_BYPASS=… [ENGINE=webkit] node scripts/test/live-sync.test.mjs
 *
 * Both accounts are deleted at the end (with their posts and messages). Prints no secrets.
 */
import { randomBytes } from "node:crypto";
import { chromium, webkit, devices } from "playwright";

const { BASE, VERCEL_BYPASS, ENGINE = "chromium" } = process.env;
if (!BASE || !VERCEL_BYPASS) throw new Error("Set BASE and VERCEL_BYPASS");
const BYPASS = { "x-vercel-protection-bypass": VERCEL_BYPASS };

let failures = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};
const info = (label, extra) => console.log(`info ${label}${extra ? ` — ${extra}` : ""}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function account(tag, who) {
  const email = `amigo-e2e-${tag}-${who}@example.com`;
  const password = randomBytes(18).toString("base64url");
  const res = await fetch(`${BASE}/neon/auth/sign-up/email`, {
    method: "POST",
    headers: { ...BYPASS, origin: BASE, "content-type": "application/json" },
    body: JSON.stringify({ email, password, name: `Sync Test ${who.toUpperCase()} ${tag}` }),
  });
  if (!res.ok) throw new Error(`sign-up ${who}: ${res.status}`);
  const body = await res.json();
  const cookies = res.headers.getSetCookie();
  const cookie = cookies.map((c) => c.split(";")[0]).join("; ");
  const { token } = await (await fetch(`${BASE}/neon/auth/token`, { headers: { ...BYPASS, origin: BASE, cookie } })).json();
  await sleep(800);
  return { id: body.user.id, token, cookies, email, password };
}
async function signInAgain(p) {
  const res = await fetch(`${BASE}/neon/auth/sign-in/email`, {
    method: "POST",
    headers: { ...BYPASS, origin: BASE, "content-type": "application/json" },
    body: JSON.stringify({ email: p.email, password: p.password }),
  });
  if (!res.ok) return;
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const t = await (await fetch(`${BASE}/neon/auth/token`, { headers: { ...BYPASS, origin: BASE, cookie } })).json().catch(() => ({}));
  if (t.token) p.token = t.token;
  await sleep(800);
}
const api = async (who, path, init = {}) => {
  for (let i = 0; i < 2; i++) {
    const res = await fetch(`${BASE}/neon/rest/v1/${path}`, {
      ...init,
      headers: { ...BYPASS, authorization: `Bearer ${who.token}`, "content-type": "application/json", ...(init.headers ?? {}) },
    });
    const text = await res.text();
    // Test setup only: a brand-new token is occasionally refused once.
    if (res.status === 403 && i === 0) {
      await sleep(1500);
      continue;
    }
    try {
      return { status: res.status, data: JSON.parse(text) };
    } catch {
      return { status: res.status, data: text.slice(0, 200) };
    }
  }
};
const rpc = (who, fn, args = {}) => api(who, `rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
const idOf = (d) => (typeof d === "string" ? d : (d?.id ?? d?.[0]?.id ?? null));

const tag = randomBytes(3).toString("hex");
const people = [];
const browser = await (ENGINE === "webkit" ? webkit : chromium).launch();
console.log(`info browser engine: ${ENGINE}`);
const deadline = setTimeout(() => {
  console.log("FAIL took over 12 minutes; stopping");
  failures++;
  void browser.close();
}, 12 * 60_000);

const host = new URL(BASE).hostname;
async function phone(p, name) {
  const ctx = await browser.newContext({ ...devices["iPhone 13"] });
  await ctx.request.get(BASE, { headers: { ...BYPASS, "x-vercel-set-bypass-cookie": "true" }, maxRedirects: 0 });
  await ctx.addCookies(
    p.cookies.map((raw) => {
      const [pair] = raw.split(";");
      const i = pair.indexOf("=");
      return { name: pair.slice(0, i), value: pair.slice(i + 1), domain: host, path: "/", secure: true, httpOnly: /httponly/i.test(raw), sameSite: "Lax" };
    }),
  );
  await ctx.addInitScript(() => {
    const hide = () => {
      const st = document.createElement("style");
      st.textContent = "vercel-live-feedback{display:none!important}";
      document.documentElement.appendChild(st);
    };
    if (document.documentElement) hide();
    else document.addEventListener("DOMContentLoaded", hide);
    // Every in-app banner shown, with when (the banner itself disappears after a few seconds).
    window.__banners = [];
    new MutationObserver(() => {
      for (const b of document.querySelectorAll(".inapp-banner")) {
        const text = b.textContent.replace(/\s+/g, " ").trim();
        if (!window.__banners.some((x) => x.text === text)) window.__banners.push({ text, at: Date.now() });
      }
    }).observe(document, { childList: true, subtree: true });
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  const problems = [];
  page.on("pageerror", (e) => !/access control checks|^Load failed$/i.test(e.message) && problems.push(`${name}: ${e.message.slice(0, 160)}`));
  return { ctx, page, problems };
}
async function agreeIfAsked(page) {
  const agree = page.getByRole("button", { name: "I agree" });
  await agree.waitFor({ timeout: 6000 }).catch(() => undefined);
  if (await agree.isVisible().catch(() => false)) {
    await agree.click();
    await agree.waitFor({ state: "detached", timeout: 15000 }).catch(() => undefined);
  }
}
const banners = (page) => page.evaluate(() => window.__banners).catch(() => []);
async function waitBanner(page, match, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = (await banners(page)).find((b) => b.text.includes(match));
    if (hit) return hit;
    await sleep(250);
  }
  return null;
}
/** As if the person switched to another app and back (what iOS tells a Home Screen app). */
const setVisible = (page, visible) =>
  page.evaluate((visible) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (visible ? "visible" : "hidden") });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => !visible });
    document.dispatchEvent(new Event("visibilitychange"));
  }, visible);

try {
  const A = await account(tag, "a");
  people.push(A);
  const B = await account(tag, "b");
  people.push(B);
  const handle = async (p) => (await api(p, `profiles?select=username&id=eq.${p.id}`)).data?.[0]?.username;
  A.handle = await handle(A);
  B.handle = await handle(B);
  const bPost = idOf((await rpc(B, "create_post", { p_body: `B's post ${tag}`, p_media: [] })).data);
  info("setup", `B's post ${bPost ? "created" : "NOT created"}`);

  const a = await phone(A, "A");
  const b = await phone(B, "B");
  // Both open Messages once (each gets its encryption device).
  await b.page.goto(`${BASE}/messages`, { waitUntil: "networkidle" });
  await agreeIfAsked(b.page);
  await a.page.goto(`${BASE}/messages`, { waitUntil: "networkidle" });
  await agreeIfAsked(a.page);
  await sleep(3000);
  await b.page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await sleep(6000); // B's live inbox starts a moment after the first screen

  // ------------------------------------------------------------ 1. five messages
  await a.page.goto(`${BASE}/u/${B.handle}`, { waitUntil: "networkidle" });
  await a.page.getByRole("button", { name: /^Message / }).click();
  await a.page.waitForURL(/\/messages\/[0-9a-f-]{36}/, { timeout: 30000 });
  const conversation = new URL(a.page.url()).pathname;
  const input = a.page.locator("#msg-input");
  await input.waitFor();
  const sent = [];
  const t0 = Date.now();
  for (let i = 1; i <= 5; i++) {
    const text = `msg ${i} of 5 ${tag}`;
    await input.fill(text);
    await a.page.getByRole("button", { name: "Send", exact: true }).click();
    sent.push(text);
  }
  await a.page.locator(".msg--mine:not(.is-pending)", { hasText: sent[4] }).waitFor({ timeout: 30000 }).catch(() => undefined);
  const first = await waitBanner(b.page, "msg ", 20000);
  ok("1. B (on Home, no reload) gets a message banner within seconds", !!first, first ? `${((first.at - t0) / 1000).toFixed(1)} s after the first send` : JSON.stringify(await banners(b.page)));
  const last = await waitBanner(b.page, sent[4], 15000);
  ok("…the banners keep up with all five (the last one shows)", !!last, (await banners(b.page)).map((x) => x.text).join(" | ").slice(0, 300));
  const msgBanners = (await banners(b.page)).filter((x) => x.text.includes(tag) && x.text.includes("msg "));
  ok("…no duplicate banners", new Set(msgBanners.map((x) => x.text)).size === msgBanners.length);
  await b.page.goto(`${BASE}${conversation}`, { waitUntil: "networkidle" });
  const order = await b.page
    .waitForFunction((tag) => [...document.querySelectorAll(".msg--theirs")].filter((m) => m.textContent.includes(tag)).length >= 5, tag, { timeout: 30000 })
    .then(() => b.page.evaluate((tag) => [...document.querySelectorAll(".msg--theirs .msg__text")].map((m) => m.textContent).filter((t) => t.includes(tag)), tag))
    .catch(() => []);
  ok("…opening the conversation shows all five, in order", JSON.stringify(order.map((t) => t.match(/msg \d/)?.[0])) === JSON.stringify(sent.map((t) => t.match(/msg \d/)[0])), JSON.stringify(order));

  // ------------------------------------------------------------ 2. a like
  await b.page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await sleep(5000);
  const badge = b.page.locator('.bottom-nav a[href="/notifications"] .nav-badge');
  const badgeBefore = (await badge.textContent().catch(() => null)) ?? "";
  const tl = Date.now();
  const liked = await rpc(A, "set_post_like", { p_post_id: bPost, p_liked: true });
  ok("A likes B's post (setup)", liked.status === 200 || liked.status === 204, String(liked.status));
  const badgeAfter = await b.page
    .waitForFunction((before) => {
      const t = document.querySelector('.bottom-nav a[href="/notifications"] .nav-badge')?.textContent ?? "";
      return t && t !== before ? t : null;
    }, badgeBefore, { timeout: 20000 })
    .then((h) => h.jsonValue(), () => null);
  ok("2. B's notification badge updates by itself", !!badgeAfter, `${badgeBefore || "none"} → ${badgeAfter ?? "unchanged"} in ${((Date.now() - tl) / 1000).toFixed(1)} s`);
  const likeBanner = await waitBanner(b.page, "liked", 10000);
  ok("…with a banner", !!likeBanner, likeBanner?.text.slice(0, 80) ?? "");

  // ------------------------------------------------------------ 3. a follow
  await b.page.goto(`${BASE}/u/${B.handle}`, { waitUntil: "networkidle" });
  const followers = b.page.locator(`a[href="/u/${B.handle}/followers"] strong`);
  await followers.waitFor();
  const fBefore = Number(await followers.textContent());
  await sleep(5000);
  const tf = Date.now();
  const fr = await api(A, "follows", { method: "POST", body: JSON.stringify({ follower_id: A.id, followee_id: B.id }) });
  ok("A follows B (setup)", [200, 201, 204].includes(fr.status), String(fr.status));
  const fAfter = await b.page
    .waitForFunction((args) => Number(document.querySelector(`a[href="/u/${args.h}/followers"] strong`)?.textContent) === args.want, { h: B.handle, want: fBefore + 1 }, { timeout: 25000 })
    .then(() => true, () => false);
  ok("3. B's own profile shows the new follower by itself", fAfter, `${fBefore} → ${await followers.textContent()} in ${((Date.now() - tf) / 1000).toFixed(1)} s`);

  // ------------------------------------------------------------ 4. offline and back
  await b.page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await sleep(4000);
  await b.ctx.setOffline(true);
  const offlineText = `while offline ${tag}`;
  await input.fill(offlineText);
  await a.page.getByRole("button", { name: "Send", exact: true }).click();
  await a.page.locator(".msg--mine:not(.is-pending)", { hasText: offlineText }).waitFor({ timeout: 30000 }).catch(() => undefined);
  await sleep(4000);
  const to = Date.now();
  await b.ctx.setOffline(false);
  const back = await waitBanner(b.page, offlineText, 25000);
  ok("4. after the connection returns, the missed message arrives (no reload)", !!back, back ? `${((back.at - to) / 1000).toFixed(1)} s after reconnecting` : "");

  // ------------------------------------------------------------ 5. away and back
  await setVisible(b.page, false);
  const awayText = `while away ${tag}`;
  await input.fill(awayText);
  await a.page.getByRole("button", { name: "Send", exact: true }).click();
  await a.page.locator(".msg--mine:not(.is-pending)", { hasText: awayText }).waitFor({ timeout: 30000 }).catch(() => undefined);
  await sleep(6000);
  const tv = Date.now();
  await setVisible(b.page, true);
  const msgBadge = await b.page
    .waitForFunction(() => document.querySelector('.bottom-nav a[href="/messages"] .nav-badge')?.textContent ?? null, null, { timeout: 15000 })
    .then((h) => h.jsonValue(), () => null);
  const awayBanner = await waitBanner(b.page, awayText, 15000);
  ok("5. coming back to the app, the missed message shows at once", !!awayBanner || !!msgBadge, `${awayBanner ? "banner" : "no banner"}, messages badge ${msgBadge ?? "none"}, ${((Date.now() - tv) / 1000).toFixed(1)} s`);

  // ------------------------------------------------------------ 6. new posts while reading
  await b.page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await sleep(3000);
  await b.page.evaluate(() => window.scrollTo(0, 1600));
  await sleep(1500);
  const y0 = await b.page.evaluate(() => Math.round(window.scrollY));
  if (y0 < 500) info("6. the feed is too short to scroll down; skipped", `scrollY ${y0}`);
  else {
    const np = await rpc(A, "create_post", { p_body: `A's new post ${tag}`, p_media: [] });
    ok("A posts (setup)", np.status === 200, String(np.status));
    const pill = await b.page.locator(".new-posts__pill").waitFor({ timeout: 25000 }).then(() => true, () => false);
    const y1 = await b.page.evaluate(() => Math.round(window.scrollY));
    ok("6. a “new posts” pill appears", pill);
    ok("…and the feed doesn't move", Math.abs(y1 - y0) <= 4, `${y0} → ${y1}`);
  }

  // ------------------------------------------------------------ 7. a new version while writing
  await b.page.route(/\/version\.json/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ version: "9.9.9+new" }) }));
  await b.page.evaluate(() => window.scrollTo(0, 0));
  await b.page.locator(".bottom-create").click();
  const composer = b.page.locator('dialog[open][aria-label="New post"] textarea').first();
  await composer.waitFor();
  const draft = `half-written post ${tag}`;
  await composer.fill(draft);
  const urlBefore = b.page.url();
  await setVisible(b.page, false);
  await setVisible(b.page, true);
  const notice = await b.page.getByText("A new version of Amigo World is ready.").waitFor({ state: "attached", timeout: 15000 }).then(() => true, () => false);
  ok("7. a new version shows an update notice", notice);
  await sleep(2000);
  ok("…nothing reloads by itself and the draft stays", b.page.url() === urlBefore && (await composer.inputValue().catch(() => "")) === draft);

  const problems = [...a.problems, ...b.problems];
  ok("no uncaught errors", !problems.length, problems.slice(0, 3).join(" | "));
} catch (e) {
  failures++;
  console.log(`FAIL stopped: ${String(e?.message ?? e).slice(0, 300)}`);
} finally {
  clearTimeout(deadline);
  await browser.close().catch(() => undefined);
  for (const p of people) {
    await signInAgain(p);
    const d = await rpc(p, "delete_my_account", { p_confirm: "DELETE" }).catch(() => ({ status: 0 }));
    const done = d?.status === 200 || d?.status === 204;
    if (!done) failures++;
    console.log(`cleanup: temporary account ${done ? "deleted" : `NOT deleted (${d?.status}) id=${p.id}`}`);
  }
}
console.log(failures ? `${failures} FAILED` : "ALL SYNC TESTS PASSED");
process.exit(failures ? 1 : 0);
