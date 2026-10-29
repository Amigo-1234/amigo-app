/**
 * Follow / Follow Back / Following on a deployed environment, through the app's
 * UI on an iPhone-sized browser, with two temporary accounts A and B:
 *
 *   A follows B → B sees "Follow Back" on A's profile, in B's followers list and
 *   in search → B taps it → "Following" (saved, counts right, survives a reload)
 *   → B unfollows → "Follow Back" again → A unfollows B → B sees "Follow".
 *   Plus: a quick double tap makes one follow, never two; your own profile has
 *   no follow button.
 *
 *   BASE=https://<domain> VERCEL_BYPASS=… [ENGINE=webkit] node scripts/test/live-follow.test.mjs
 *
 * Both accounts are deleted at the end (their follows go with them). Prints no secrets.
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
    body: JSON.stringify({ email, password, name: `Follow Test ${who.toUpperCase()} ${tag}` }),
  });
  if (!res.ok) throw new Error(`sign-up ${who}: ${res.status}`);
  const body = await res.json();
  const cookies = res.headers.getSetCookie();
  const cookie = cookies.map((c) => c.split(";")[0]).join("; ");
  const { token } = await (await fetch(`${BASE}/neon/auth/token`, { headers: { ...BYPASS, origin: BASE, cookie } })).json();
  await sleep(800); // a brand-new token is honoured after ~250 ms
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
const follow = async (from, to) => {
  let r = await api(from, "follows", { method: "POST", body: JSON.stringify({ follower_id: from.id, followee_id: to.id }) });
  if (r.status === 403) {
    await sleep(2000); // test setup only: a brand-new token is occasionally refused once
    r = await api(from, "follows", { method: "POST", body: JSON.stringify({ follower_id: from.id, followee_id: to.id }) });
  }
  return r.status;
};
const unfollow = async (from, to) => (await api(from, `follows?follower_id=eq.${from.id}&followee_id=eq.${to.id}`, { method: "DELETE" })).status;
const edges = async (who, from, to) => (await api(who, `follows?select=follower_id&follower_id=eq.${from.id}&followee_id=eq.${to.id}`)).data?.length ?? -1;
const counts = async (who, p) => (await api(who, `profiles?select=follower_count,following_count&id=eq.${p.id}`)).data?.[0] ?? {};

const tag = randomBytes(3).toString("hex");
const people = [];
const browser = await (ENGINE === "webkit" ? webkit : chromium).launch();
console.log(`info browser engine: ${ENGINE}`);
const deadline = setTimeout(() => {
  console.log("FAIL took over 8 minutes; stopping");
  failures++;
  void browser.close();
}, 8 * 60_000);

try {
  const A = await account(tag, "a");
  people.push(A);
  const B = await account(tag, "b");
  people.push(B);
  const handle = async (p) => (await api(p, `profiles?select=username&id=eq.${p.id}`)).data?.[0]?.username;
  A.handle = await handle(A);
  B.handle = await handle(B);

  // B's phone.
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
  const problems = [];
  page.on("pageerror", (e) => problems.push(`page error: ${e.message.slice(0, 160)}`));
  let followWrites = 0;
  page.on("request", (rq) => {
    const u = new URL(rq.url());
    if (u.pathname.endsWith("/follows") && ["POST", "DELETE"].includes(rq.method())) followWrites++;
  });

  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  const agree = page.getByRole("button", { name: "I agree" });
  await agree.waitFor({ timeout: 8000 }).catch(() => undefined);
  if (await agree.isVisible().catch(() => false)) {
    await agree.click();
    await agree.waitFor({ state: "detached", timeout: 15000 }).catch(() => undefined);
  }
  await page.locator(".bottom-create").waitFor().catch(() => undefined);

  const profileButton = () => page.locator(".profile__action .follow-btn");
  const openProfile = async (h) => {
    await page.goto(`${BASE}/u/${h}`, { waitUntil: "networkidle" });
    try {
      await page.locator(".profile__action").waitFor();
    } catch (e) {
      const text = ((await page.locator("main").innerText().catch(() => "")) || "").replace(/\s+/g, " ").slice(0, 200);
      info("profile didn't show", `${page.url().replace(BASE, "")} · ${text} · ${problems.slice(-3).join(" | ")}`);
      throw e;
    }
  };
  const label = async (loc) => ((await loc.textContent().catch(() => null)) ?? "").trim();
  const waitLabel = async (loc, want, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if ((await label(loc)) === want) return true;
      await sleep(100);
    }
    return false;
  };

  // 0. Neither follows the other.
  await openProfile(A.handle);
  ok("no relationship: A's profile shows “Follow”", (await label(profileButton())) === "Follow", await label(profileButton()));

  // 1. A follows B.
  ok("A follows B (setup)", [201, 204].includes(await follow(A, B)));

  // 2. B visits A's profile.
  await openProfile(A.handle);
  ok("A follows B: B sees “Follow Back” on A's profile", (await label(profileButton())) === "Follow Back", await label(profileButton()));
  ok("…with an accessible name", (await profileButton().getAttribute("aria-label")) === `Follow back Follow Test A ${tag}`, await profileButton().getAttribute("aria-label"));

  // Followers list and search show the same state.
  await page.goto(`${BASE}/u/${B.handle}/followers`, { waitUntil: "networkidle" });
  const rowBtn = page.locator(".person-row .follow-btn").first();
  await rowBtn.waitFor().catch(() => undefined);
  ok("B's followers list: A's row shows “Follow Back”", (await label(rowBtn)) === "Follow Back", await label(rowBtn));
  await page.goto(`${BASE}/explore`, { waitUntil: "networkidle" });
  await page.getByRole("searchbox", { name: "Search Amigo" }).or(page.getByLabel("Search Amigo")).first().fill(A.handle);
  const searchBtn = page.locator(".explore-people .person-row", { hasText: A.handle }).locator(".follow-btn");
  await searchBtn.first().waitFor().catch(() => undefined);
  ok("search results: A shows “Follow Back”", (await label(searchBtn.first())) === "Follow Back", await label(searchBtn.first()));

  // 3. B taps Follow Back.
  await openProfile(A.handle);
  const before = await counts(B, A);
  followWrites = 0;
  const t0 = Date.now();
  await profileButton().tap();
  ok("tapping “Follow Back” shows “Following”", await waitLabel(profileButton(), "Following", 3000), `${Date.now() - t0} ms`);
  await sleep(1500);
  ok("…the follow is saved", (await edges(B, B, A)) === 1);
  const after = await counts(B, A);
  ok("…A's follower count went up by exactly one", after.follower_count === (before.follower_count ?? 0) + 1, `${before.follower_count} → ${after.follower_count}`);
  ok("…one request was sent", followWrites === 1, String(followWrites));

  // 4. Reload.
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".profile__action").waitFor();
  ok("after a reload B still sees “Following”", (await label(profileButton())) === "Following", await label(profileButton()));

  // 5. B unfollows A.
  await profileButton().tap();
  ok("B unfollows A: back to “Follow Back”", await waitLabel(profileButton(), "Follow Back", 3000), await label(profileButton()));
  await sleep(1500);
  ok("…the unfollow is saved", (await edges(B, B, A)) === 0);
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".profile__action").waitFor();
  ok("…and still “Follow Back” after a reload", (await label(profileButton())) === "Follow Back", await label(profileButton()));

  // Duplicate taps: a quick double tap must not create two follows.
  followWrites = 0;
  await profileButton().tap();
  await profileButton().tap({ force: true }).catch(() => undefined); // second tap lands while the first is saving
  await sleep(2500);
  ok("a quick double tap leaves exactly one follow", (await edges(B, B, A)) === 1, `${followWrites} request(s)`);
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".profile__action").waitFor();
  ok("…and shows “Following”", (await label(profileButton())) === "Following", await label(profileButton()));
  const c2 = await counts(B, A);
  ok("…A's follower count is consistent (1)", c2.follower_count === 1, String(c2.follower_count));
  await unfollow(B, A);

  // 6. A unfollows B.
  ok("A unfollows B (setup)", [200, 204].includes(await unfollow(A, B)));
  await openProfile(A.handle);
  ok("nobody follows anybody: B sees “Follow”", (await label(profileButton())) === "Follow", await label(profileButton()));

  // Own profile: no follow button.
  await openProfile(B.handle);
  ok("own profile: “Edit profile”, no follow button", (await page.getByRole("button", { name: "Edit profile" }).count()) === 1 && (await profileButton().count()) === 0);

  // Phone layout: the button fits on screen.
  await openProfile(A.handle);
  const box = await profileButton().boundingBox();
  const vw = page.viewportSize().width;
  ok("the button is fully on screen at phone width", !!box && box.x >= 0 && box.x + box.width <= vw, box ? `${Math.round(box.x)}–${Math.round(box.x + box.width)} of ${vw}` : "no box");
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
console.log(failures ? `${failures} FAILED` : "ALL FOLLOW TESTS PASSED");
process.exit(failures ? 1 : 0);
