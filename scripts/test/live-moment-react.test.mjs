/**
 * Moment reactions on a deployed environment, timed from the tap: how long until
 * the tapped emoji shows as selected, and whether the stored reaction matches
 * the last tap after quick repeated taps (and how many requests they made).
 *
 * Chromium runs with a 4G-like profile (150 ms latency, CPU ×4); WebKit cannot
 * be throttled and runs on the runner's network.
 *
 *   BASE=https://<domain> VERCEL_BYPASS=… [ENGINE=webkit] node scripts/test/live-moment-react.test.mjs
 *
 * Two temporary accounts; the Moment is followers-only (B follows A) so no real
 * user sees it. Both accounts are deleted at the end. Prints no secrets.
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
    body: JSON.stringify({ email, password, name: `React Test ${who.toUpperCase()}` }),
  });
  if (!res.ok) throw new Error(`sign-up ${who}: ${res.status}`);
  const body = await res.json();
  const cookies = res.headers.getSetCookie();
  const cookie = cookies.map((c) => c.split(";")[0]).join("; ");
  const { token } = await (await fetch(`${BASE}/neon/auth/token`, { headers: { ...BYPASS, origin: BASE, cookie } })).json();
  await sleep(600); // a brand-new token is honoured after ~250 ms
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
  await sleep(600);
}
const api = async (who, path, init = {}) => {
  const res = await fetch(`${BASE}/neon/rest/v1/${path}`, {
    ...init,
    headers: { ...BYPASS, authorization: `Bearer ${who.token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch {
    return { status: res.status, data: text.slice(0, 200) };
  }
};
const rpc = (who, fn, args = {}) => api(who, `rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
const storedReaction = async (who, momentId) => (await rpc(who, "moments_feed")).data?.find?.((m) => m.id === momentId)?.my_reaction ?? null;

const tag = randomBytes(4).toString("hex");
const people = [];
const browser = await (ENGINE === "webkit" ? webkit : chromium).launch();
console.log(`info browser engine: ${ENGINE}`);
const deadline = setTimeout(() => {
  console.log("FAIL took over 6 minutes; stopping");
  failures++;
  void browser.close();
}, 6 * 60_000);

try {
  const A = await account(tag, "a"); // posts the Moment
  people.push(A);
  const B = await account(tag, "b"); // reacts
  people.push(B);
  let r = await api(B, "follows", { method: "POST", body: JSON.stringify({ follower_id: B.id, followee_id: A.id }) });
  ok("B follows A", r.status === 201 || r.status === 204, String(r.status));
  r = await rpc(A, "create_moment", { p_body: `Reaction test ${tag}`, p_background: "coral", p_media_path: null, p_media_width: null, p_media_height: null, p_audience: "followers" });
  const momentId = typeof r.data === "string" ? r.data : r.data?.id;
  ok("A posts a followers-only Moment", !!momentId, `${r.status}`);
  if (!momentId) throw new Error("no Moment");

  const host = new URL(BASE).hostname;
  const ctx = await browser.newContext({ ...devices["iPhone 13"] });
  await ctx.request.get(BASE, { headers: { ...BYPASS, "x-vercel-set-bypass-cookie": "true" }, maxRedirects: 0 });
  await ctx.addCookies(
    B.cookies.map((raw) => {
      const [pair] = raw.split(";");
      const i = pair.indexOf("=");
      return { name: pair.slice(0, i), value: pair.slice(i + 1), domain: host, path: "/", secure: true, httpOnly: /httponly/i.test(raw), sameSite: "Lax" };
    }),
  );
  // Vercel's preview feedback toolbar (never on production) can cover controls at phone size.
  await ctx.addInitScript(() => {
    const hide = () => {
      const st = document.createElement("style");
      st.textContent = "vercel-live-feedback{display:none!important}";
      document.documentElement.appendChild(st);
    };
    if (document.documentElement) hide();
    else document.addEventListener("DOMContentLoaded", hide);
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  if (ENGINE === "chromium") {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: (4_000_000 / 8) | 0, uploadThroughput: (1_000_000 / 8) | 0 });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    info("network", "4G-like: 150 ms latency, 4 Mbit/s down, CPU ×4");
  }
  const problems = [];
  page.on("pageerror", (e) => problems.push(`page error: ${e.message.slice(0, 160)}`));
  let reactRequests = 0;
  page.on("request", (rq) => rq.url().includes("/rpc/react_to_moment") && reactRequests++);

  const feed = (await rpc(B, "moments_feed")).data;
  ok("B's Moments feed (API) includes A's Moment", Array.isArray(feed) && feed.some((m) => m.id === momentId), Array.isArray(feed) ? `${feed.length} Moments` : JSON.stringify(feed).slice(0, 160));
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  // A new account first accepts the legal documents, as in the app.
  const agree = page.getByRole("button", { name: "I agree" });
  await agree.waitFor({ timeout: 8000 }).catch(() => undefined);
  if (await agree.isVisible().catch(() => false)) await agree.click();
  const bubble = page.locator(".moments-row button.moment-bubble").filter({ hasText: "React" });
  try {
    await bubble.first().waitFor({ timeout: 20000 });
  } catch (e) {
    const labels = await page.locator(".moments-row button").evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-label")));
    info("Moments row buttons", JSON.stringify(labels));
    info("page", `${page.url().replace(BASE, "")} · ${(await page.locator("h1, h2").allInnerTexts()).slice(0, 4).join(" | ")}`);
    throw e;
  }
  await bubble.first().click();
  await page.locator(".moment-react").first().waitFor();
  await sleep(1500); // let the viewer settle (seen mark, live data)

  // Tap → selected, in the page's own clock (pointer event to the attribute change).
  const timeTap = (emoji, want) =>
    page.evaluate(
      ([emoji, want]) =>
        new Promise((resolve) => {
          const btn = [...document.querySelectorAll(".moment-react")].find((b) => b.getAttribute("aria-label") === `React ${emoji}`);
          if (!btn) return resolve(-1);
          const t0 = performance.now();
          const done = () => btn.getAttribute("aria-pressed") === want;
          const obs = new MutationObserver(() => done() && (obs.disconnect(), resolve(Math.round(performance.now() - t0))));
          obs.observe(document.body, { attributes: true, subtree: true, attributeFilter: ["aria-pressed"] });
          setTimeout(() => (obs.disconnect(), resolve(done() ? 0 : 99999)), 15000);
          btn.click();
        }),
      [emoji, want],
    );

  const times = [];
  for (const [emoji, want] of [["🔥", "true"], ["❤️", "true"], ["❤️", "false"], ["😂", "true"]]) {
    const ms = await timeTap(emoji, want);
    times.push(ms);
    info(`tap ${emoji} → ${want === "true" ? "selected" : "cleared"}`, `${ms} ms`);
    await sleep(2500); // let it save before the next one
  }
  const worst = Math.max(...times);
  ok("each tap shows its result within 150 ms", worst <= 150, `${times.join(" / ")} ms`);
  await sleep(2000);
  ok("the stored reaction is the last one tapped", (await storedReaction(B, momentId)) === "😂", String(await storedReaction(B, momentId)));

  // Quick repeated taps on the same emoji (5 = odd → ends selected).
  reactRequests = 0;
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".moment-react")].find((b) => b.getAttribute("aria-label") === "React 🔥");
    for (let i = 0; i < 5; i++) btn.click();
  });
  await sleep(5000);
  const shown = await page.locator('.moment-react[aria-label="React 🔥"]').getAttribute("aria-pressed");
  const stored = await storedReaction(B, momentId);
  ok("after 5 quick taps on 🔥 it shows as selected", shown === "true", String(shown));
  ok("…and that is what was saved", stored === "🔥", String(stored));
  info("requests made by the 5 quick taps", String(reactRequests));
  ok("…without one request per tap", reactRequests <= 3, String(reactRequests));

  // A then sees B's reaction.
  const viewers = (await rpc(A, "moment_viewers", { p_moment: momentId })).data;
  ok("A sees B's reaction in the viewers list", Array.isArray(viewers) && viewers.some((v) => v.viewer_id === B.id && v.reaction === "🔥"), JSON.stringify(viewers?.map?.((v) => v.reaction)));
  if (problems.length) info("errors seen in the app", problems.slice(-6).join(" | "));
} catch (e) {
  failures++;
  console.log(`FAIL stopped: ${String(e?.message ?? e).slice(0, 300)}`);
} finally {
  clearTimeout(deadline);
  await browser.close().catch(() => undefined);
  for (const p of people) {
    await signInAgain(p);
    const d = await rpc(p, "delete_my_account", { p_confirm: "DELETE" }).catch(() => ({ status: 0 }));
    const done = d.status === 200 || d.status === 204;
    if (!done) failures++;
    console.log(`cleanup: temporary account ${done ? "deleted" : `NOT deleted (${d.status}) id=${p.id}`}`);
  }
}
console.log(failures ? `${failures} FAILED` : "ALL MOMENT REACTION TESTS PASSED");
process.exit(failures ? 1 : 0);
