/**
 * The phone tab bar on the Home feed hides while scrolling down and comes back
 * on scrolling up, near the top and on other screens. iPhone SE (1st and 3rd
 * gen) / 13 / 15 Pro Max sizes (Chromium or WebKit):
 *
 *   visible at the top; hidden after scrolling down; a few pixels up don't bring
 *   it back, a real scroll up does; nothing on the page moves when it hides or
 *   shows; Create works once it's back; the end of the feed clears the bar;
 *   back on the feed from a post it's shown; other screens never hide it;
 *   reduced motion has no slide.
 *
 * Scrolling is done by the page in small steps (with slowing steps standing in
 * for momentum): automated browsers, not a physical iPhone.
 *
 *   BASE=https://<domain> VERCEL_BYPASS=… [ENGINE=webkit] node scripts/test/live-bottom-nav.test.mjs
 *
 * One temporary account (its posts), deleted at the end.
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

async function token(p) {
  const res = await fetch(`${BASE}/neon/auth/sign-in/email`, {
    method: "POST",
    headers: { ...BYPASS, origin: BASE, "content-type": "application/json" },
    body: JSON.stringify({ email: p.email, password: p.password }),
  });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return (await (await fetch(`${BASE}/neon/auth/token`, { headers: { ...BYPASS, origin: BASE, cookie } })).json()).token;
}
const rpc = (tok, fn, args) =>
  fetch(`${BASE}/neon/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { ...BYPASS, authorization: `Bearer ${tok}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });

const tag = randomBytes(3).toString("hex");
const person = { email: `amigo-e2e-${tag}-nav@example.com`, password: randomBytes(18).toString("base64url") };
let created = false;
const browser = await (ENGINE === "webkit" ? webkit : chromium).launch();
console.log(`info browser engine: ${ENGINE}`);
const deadline = setTimeout(() => {
  console.log("FAIL took over 8 minutes; stopping");
  failures++;
  void browser.close();
}, 8 * 60_000);

try {
  const res = await fetch(`${BASE}/neon/auth/sign-up/email`, {
    method: "POST",
    headers: { ...BYPASS, origin: BASE, "content-type": "application/json" },
    body: JSON.stringify({ ...person, name: `Nav Test ${tag}` }),
  });
  if (!res.ok) throw new Error(`sign-up: ${res.status}`);
  created = true;
  person.cookies = res.headers.getSetCookie();
  await sleep(800);
  const tok = await token(person);
  // Enough of a feed to scroll through, including a long post.
  const long = `Long post ${tag}. ` + "A caption that runs on to make a tall card. ".repeat(9);
  for (let i = 0; i < 12; i++) {
    const r = await rpc(tok, "create_post", { p_body: i === 6 ? long : `Nav post ${i} ${tag}\n\nline two\n\nline three` });
    if (!r.ok) throw new Error(`create_post ${i}: ${r.status}`);
  }

  const host = new URL(BASE).hostname;
  // iPhone SE 1st gen (320 wide), SE 2nd/3rd gen (375×667, no home indicator), 13, 15 Pro Max.
  const se2 = { ...devices["iPhone 8"], viewport: { width: 375, height: 667 } };
  const sizes = [["iPhone SE", devices["iPhone SE"]], ["iPhone SE 3", se2], ["iPhone 13", devices["iPhone 13"]], ["iPhone 15 Pro Max", devices["iPhone 15 Pro Max"]]].filter(([, d]) => d);
  for (const [n, [size, device]] of sizes.entries()) {
    const ctx = await browser.newContext({ ...device, serviceWorkers: "block", reducedMotion: n === 0 ? "reduce" : "no-preference" });
    await ctx.request.get(BASE, { headers: { ...BYPASS, "x-vercel-set-bypass-cookie": "true" }, maxRedirects: 0 });
    await ctx.addCookies(
      person.cookies.map((raw) => {
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
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(20000);
    const problems = [];
    page.on("pageerror", (e) => !/access control checks|^Load failed$/i.test(e.message) && problems.push(e.message.slice(0, 160)));
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    const agree = page.getByRole("button", { name: "I agree" });
    await agree.waitFor({ timeout: 8000 }).catch(() => undefined);
    if (await agree.isVisible().catch(() => false)) {
      await agree.click();
      await agree.waitFor({ state: "detached", timeout: 15000 }).catch(() => undefined);
    }
    await page.locator("article", { hasText: `Nav post 0 ${tag}` }).first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(1000);
    const vp = page.viewportSize();
    const L = `[${size} ${vp.width}×${vp.height}]`;

    /** Where the bar is: fully on screen, fully off, or moving. */
    const bar = () =>
      page.evaluate(() => {
        const r = document.querySelector(".bottom-nav").getBoundingClientRect();
        return r.top >= window.innerHeight - 1 ? "hidden" : Math.abs(r.bottom - window.innerHeight) < 1 ? "shown" : `moving ${Math.round(r.top)}`;
      });
    /** Scroll by `by` in steps, like a finger (or slowing, like momentum). */
    const scroll = async (by, steps = 12, slowing = false) => {
      let w = 0;
      const ws = Array.from({ length: steps }, (_, i) => (slowing ? steps - i : 1));
      const total = ws.reduce((a, b) => a + b, 0);
      for (const s of ws) {
        const d = Math.round((by * s) / total);
        w += d;
        await page.evaluate((d) => window.scrollBy(0, d), d);
        await page.waitForTimeout(24);
      }
      await page.waitForTimeout(450);
      return w;
    };

    ok(`${L} shown at the top`, (await bar()) === "shown");
    const anchor = page.locator("article", { hasText: `Nav post 3 ${tag}` }).first();
    await scroll(600, 16);
    ok(`${L} scrolling down hides it`, (await bar()) === "hidden", await bar());
    const at = await page.evaluate(() => [window.scrollY, document.documentElement.scrollHeight]);
    const y0 = (await anchor.boundingBox())?.y;
    await scroll(-6, 2);
    ok(`${L} a tiny movement up doesn't bring it back`, (await bar()) === "hidden", await bar());
    await scroll(6, 2);
    await scroll(-80, 8);
    ok(`${L} a real scroll up shows it`, (await bar()) === "shown", await bar());
    await scroll(80, 8);
    const after = await page.evaluate(() => [window.scrollY, document.documentElement.scrollHeight]);
    const y1 = (await anchor.boundingBox())?.y;
    ok(`${L} nothing on the page moves when it hides / shows`, after[0] === at[0] && after[1] === at[1] && y0 === y1, `scroll ${at[0]}→${after[0]}, height ${at[1]}→${after[1]}, post ${y0}→${y1}`);
    await scroll(900, 14, true);
    ok(`${L} hidden after a flick that slows down (momentum)`, (await bar()) === "hidden", await bar());
    await scroll(-300, 14, true);
    ok(`${L} shown after a flick up`, (await bar()) === "shown", await bar());

    // The long post: scrolling through it hides the bar; its text isn't covered once at the end.
    const longCard = page.locator("article", { hasText: `Long post ${tag}` }).first();
    await longCard.scrollIntoViewIfNeeded();
    await scroll(200, 8);
    ok(`${L} scrolling through a long post hides it`, (await bar()) === "hidden", await bar());

    // Create works once it's back.
    await scroll(-80, 8);
    await page.locator(".bottom-create").tap();
    const composer = page.locator('dialog[open][aria-label="New post"]');
    ok(`${L} Create opens the composer`, await composer.waitFor({ timeout: 8000 }).then(() => true, () => false));
    await page.keyboard.press("Escape");
    await composer.waitFor({ state: "detached", timeout: 8000 }).catch(() => undefined);

    // The end of the feed clears the bar (when it's shown there).
    const clear = await page.evaluate(() => {
      const nav = document.querySelector(".bottom-nav").getBoundingClientRect().height;
      return parseFloat(getComputedStyle(document.querySelector(".main")).paddingBottom) >= nav - 1;
    });
    ok(`${L} the end of the feed has room for the bar (nothing under it)`, clear);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(500);
    await scroll(-40, 6);
    const last = await page.evaluate(() => {
      const posts = [...document.querySelectorAll("main article")];
      const r = posts.at(-1)?.getBoundingClientRect();
      const top = document.querySelector(".bottom-nav").getBoundingClientRect().top;
      return { shown: Math.abs(document.querySelector(".bottom-nav").getBoundingClientRect().bottom - window.innerHeight) < 1, room: r ? Math.round(top - r.bottom) : null, maxY: document.documentElement.scrollHeight - window.innerHeight - window.scrollY };
    });
    info(`${L} near the end with the bar shown`, JSON.stringify(last));

    // Back from another screen: shown.
    await scroll(-200, 6);
    await scroll(400, 10);
    ok(`${L} (hidden before leaving)`, (await bar()) === "hidden", await bar());
    await page.locator("article", { hasText: `Nav post 1 ${tag}` }).first().locator("p, .post-card__body").first().click().catch(() => undefined);
    await page.waitForURL((u) => u.pathname !== "/", { timeout: 8000 }).catch(() => undefined);
    if (new URL(page.url()).pathname === "/") await page.goto(`${BASE}/notifications`, { waitUntil: "load" });
    await page.waitForTimeout(600);
    ok(`${L} another screen shows it`, (await bar()) === "shown", `${new URL(page.url()).pathname}: ${await bar()}`);
    await page.evaluate(() => window.scrollBy(0, 400));
    await page.waitForTimeout(500);
    ok(`${L} other screens never hide it`, (await bar()) === "shown", await bar());
    await page.goBack();
    await page.waitForTimeout(1200);
    ok(`${L} back on the feed: shown`, new URL(page.url()).pathname === "/" && (await bar()) === "shown", `${new URL(page.url()).pathname}: ${await bar()}`);

    if (n === 0) {
      const dur = await page.evaluate(() => getComputedStyle(document.querySelector(".bottom-nav")).transitionDuration);
      ok(`${L} reduced motion: no slide`, dur.split(",").every((d) => parseFloat(d) < 0.02), dur);
    }
    ok(`${L} no uncaught errors`, !problems.length, problems.slice(0, 3).join(" | "));
    await ctx.close();
  }
} catch (e) {
  failures++;
  console.log(`FAIL stopped: ${String(e?.message ?? e).slice(0, 300)}`);
} finally {
  clearTimeout(deadline);
  await browser.close().catch(() => undefined);
  if (created) {
    const tok = await token(person).catch(() => null);
    await sleep(800);
    const d = tok ? await rpc(tok, "delete_my_account", { p_confirm: "DELETE" }) : { status: 0 };
    const done = d.status === 200 || d.status === 204;
    if (!done) failures++;
    console.log(`cleanup: temporary account ${done ? "deleted" : `NOT deleted (${d.status})`}`);
  }
}
console.log(failures ? `${failures} FAILED` : "ALL BOTTOM NAV TESTS PASSED");
process.exit(failures ? 1 : 0);
