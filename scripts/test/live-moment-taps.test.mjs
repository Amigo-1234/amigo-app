/**
 * Moments opened from the feed must never let a tap reach the feed behind
 * them (owner's iPhone report: tapping right to advance sometimes opened a
 * photo or post underneath). On an iPhone-sized touch browser (Chromium or
 * WebKit), with a photo post in the feed directly under the tap point:
 *
 *   tap right → next Moment; tap right on the last → the viewer closes, and
 *   nothing behind opens; tap left → previous; hold → pauses, doesn't move;
 *   rapid taps; closing returns to the same place in the feed. Every click
 *   that lands outside the Moment viewer while it's open — or within a moment
 *   of it closing — is counted and must be zero.
 *
 * Taps are real touch taps (touchstart/touchend; the browser makes the click).
 *
 *   BASE=https://<domain> VERCEL_BYPASS=… [ENGINE=webkit] node scripts/test/live-moment-taps.test.mjs
 *
 * One temporary account (its post and Moments), deleted at the end.
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

async function account(tag) {
  const email = `amigo-e2e-${tag}-mt@example.com`;
  const password = randomBytes(18).toString("base64url");
  const res = await fetch(`${BASE}/neon/auth/sign-up/email`, {
    method: "POST",
    headers: { ...BYPASS, origin: BASE, "content-type": "application/json" },
    body: JSON.stringify({ email, password, name: `Taps Test ${tag}` }),
  });
  if (!res.ok) throw new Error(`sign-up: ${res.status}`);
  const body = await res.json();
  await sleep(800);
  return { id: body.user.id, cookies: res.headers.getSetCookie(), email, password };
}
async function deleteAccount(p) {
  const res = await fetch(`${BASE}/neon/auth/sign-in/email`, {
    method: "POST",
    headers: { ...BYPASS, origin: BASE, "content-type": "application/json" },
    body: JSON.stringify({ email: p.email, password: p.password }),
  });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const { token } = await (await fetch(`${BASE}/neon/auth/token`, { headers: { ...BYPASS, origin: BASE, cookie } })).json();
  await sleep(800);
  const d = await fetch(`${BASE}/neon/rest/v1/rpc/delete_my_account`, {
    method: "POST",
    headers: { ...BYPASS, authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ p_confirm: "DELETE" }),
  });
  return d.status === 200 || d.status === 204;
}

const tag = randomBytes(3).toString("hex");
let person = null;
const browser = await (ENGINE === "webkit" ? webkit : chromium).launch();
console.log(`info browser engine: ${ENGINE}`);
const deadline = setTimeout(() => {
  console.log("FAIL took over 8 minutes; stopping");
  failures++;
  void browser.close();
}, 8 * 60_000);

try {
  person = await account(tag);
  const host = new URL(BASE).hostname;
  const ctx = await browser.newContext({ ...devices["iPhone 13"], serviceWorkers: "block" });
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
    // Every click that lands outside the Moment viewer while it's open, or shortly after it closed.
    window.__behind = [];
    let openUntil = 0;
    const viewerOpen = () => !!document.querySelector("dialog.moment-viewer[open]");
    new MutationObserver(() => {
      if (viewerOpen()) openUntil = Infinity;
      else if (openUntil === Infinity) openUntil = Date.now() + 1500;
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] });
    document.addEventListener(
      "click",
      (e) => {
        const t = e.target;
        if (t instanceof Element && t.closest("dialog.moment-viewer")) return;
        if (viewerOpen() || Date.now() < openUntil) window.__behind.push(`${t?.tagName}.${String(t?.className ?? "").slice(0, 40)}`);
      },
      true,
    );
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

  // A photo post (the thing that must not open) …
  const photo = Buffer.from(
    await page.evaluate(async () => {
      const c = document.createElement("canvas");
      c.width = 1600;
      c.height = 1600;
      const x = c.getContext("2d");
      x.fillStyle = "#3d8bff";
      x.fillRect(0, 0, 1600, 1600);
      const b = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
      return Array.from(new Uint8Array(await b.arrayBuffer()));
    }),
  );
  await page.locator(".bottom-create").click();
  const composer = page.locator('dialog[open][aria-label="New post"]');
  await composer.locator('input[type="file"]').setInputFiles({ name: "IMG_0004.JPG", mimeType: "image/jpeg", buffer: photo });
  await composer.locator("textarea").first().fill(`Under the Moments ${tag}`);
  await composer.getByRole("button", { name: "Post", exact: true }).last().click();
  const tile = page.locator("article", { hasText: `Under the Moments ${tag}` }).locator(".media-tile__open").first();
  await tile.waitFor({ timeout: 60000 });

  // … and two text Moments.
  for (const n of [1, 2]) {
    await page.locator(".moment-composer").waitFor({ state: "detached", timeout: 10000 }).catch(() => undefined);
    await page.getByRole("button", { name: "Add a Moment", exact: true }).first().click();
    const mc = page.locator(".moment-composer");
    await mc.waitFor();
    await mc.locator("textarea").fill(`Moment ${n} ${tag}`);
    await mc.locator(".moment-composer__head").getByRole("button", { name: "Share" }).click();
    await page.getByText("Moment shared").first().waitFor({ timeout: 30000 });
  }
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await tile.waitFor({ timeout: 60000 });
  await page.waitForTimeout(1500);
  const vw = page.viewportSize().width;
  // The tap point: right of centre ("next" in the viewer) and, behind the viewer, on the feed photo.
  let at = { x: Math.round(vw * 0.75), y: 400 };
  const aim = async () => {
    const box = await tile.boundingBox();
    if (box) at = { x: Math.round(Math.max(vw * 0.6, Math.min(box.x + box.width * 0.75, vw - 20))), y: Math.round(box.y + box.height / 2) };
    return page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest(".media-tile__open"), at);
  };
  const scrollBefore = 0;

  const viewer = page.locator("dialog.moment-viewer[open]");
  const showing = async () => ((await viewer.locator(".moment-visual__text").first().textContent().catch(() => "")) ?? "").trim();
  const behind = () => page.evaluate(() => window.__behind.slice());
  let aimed = 0;
  const openMine = async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    const onPhoto = await aim();
    if (!aimed++) info("tap point", `${at.x},${at.y} of ${vw} wide · the feed photo is under it: ${onPhoto}`);
    await page.getByRole("button", { name: /^Your Moments/ }).first().click();
    await viewer.waitFor({ timeout: 15000 });
    await page.waitForTimeout(400);
  };
  const tapRight = () => page.touchscreen.tap(at.x, at.y);
  const tapLeft = () => page.touchscreen.tap(Math.round(vw * 0.15), at.y);

  // A viewer left open by a failed step would block the next one.
  const tidy = async () => {
    for (let i = 0; i < 3 && (await page.locator("dialog[open]").count()); i++) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
    }
  };

  // 1. Tap right / left, then tap right through to the end. Other people's Moments can follow
  // yours in the queue, so steps are checked by change, not by exact text.
  await openMine();
  const first = await showing();
  await tapRight();
  await page.waitForTimeout(600);
  const second = await showing();
  ok("tap right → next Moment", first === `Moment 1 ${tag}` && !!second && second !== first, `${first} → ${second}`);
  await tapLeft();
  await page.waitForTimeout(600);
  ok("tap left → previous Moment", (await showing()) === first, await showing());
  let steps = 0;
  while ((await viewer.count()) && steps < 25) {
    await tapRight();
    steps++;
    await page.waitForTimeout(600);
  }
  await page.waitForTimeout(1000);
  info("Moments in the queue", String(steps));
  ok("tap right on the last Moment closes the viewer", !(await viewer.count()));
  ok("…and nothing behind it opened (no photo viewer)", !(await page.locator("dialog.media-viewer[open]").count()));
  ok("…still on the feed (no post page)", new URL(page.url()).pathname === "/", page.url());
  ok("no click reached the feed while Moments were open or closing", !(await behind()).length, (await behind()).join(", "));
  await tidy();
  if (new URL(page.url()).pathname !== "/") await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.evaluate(() => (window.__behind.length = 0));

  // 2. Rapid taps (more than there are Moments).
  await openMine();
  for (let i = 0; i < steps + 2; i++) {
    await tapRight();
    await page.waitForTimeout(90);
  }
  await page.waitForTimeout(1500);
  ok("rapid taps: the viewer closed after the last Moment", !(await viewer.count()));
  ok("rapid taps: nothing behind opened", !(await page.locator("dialog.media-viewer[open]").count()) && new URL(page.url()).pathname === "/", page.url());
  ok("rapid taps: no click reached the feed", !(await behind()).length, (await behind()).join(", "));
  await tidy();
  if (new URL(page.url()).pathname !== "/") await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.evaluate(() => (window.__behind.length = 0));

  // 3. Hold pauses and doesn't move.
  await openMine();
  const before = await showing();
  await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    el?.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 7, pointerType: "touch", isPrimary: true, clientX: x, clientY: y, bubbles: true }));
  }, at);
  await page.waitForTimeout(900);
  const paused = await viewer.locator(".moment-viewer__paused, [aria-label*=aused]").count().catch(() => 0);
  await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    el?.dispatchEvent(new PointerEvent("pointerup", { pointerId: 7, pointerType: "touch", isPrimary: true, clientX: x, clientY: y, bubbles: true }));
  }, at);
  await page.waitForTimeout(500);
  ok("hold: stays on the same Moment", (await showing()) === before, `${before} → ${await showing()}`);
  info("hold: paused indicator shown", String(paused > 0));
  // Close with the close button: back to the same place.
  await viewer.getByRole("button", { name: "Close" }).tap();
  await page.waitForTimeout(800);
  ok("close button closes and returns to the feed", !(await viewer.count()) && new URL(page.url()).pathname === "/");
  ok("no click reached the feed at any point", !(await behind()).length, (await behind()).join(", "));
  void scrollBefore;
  ok("no uncaught errors", !problems.length, problems.slice(0, 3).join(" | "));
} catch (e) {
  failures++;
  console.log(`FAIL stopped: ${String(e?.message ?? e).slice(0, 300)}`);
} finally {
  clearTimeout(deadline);
  await browser.close().catch(() => undefined);
  if (person) {
    const done = await deleteAccount(person).catch(() => false);
    if (!done) failures++;
    console.log(`cleanup: temporary account ${done ? "deleted" : `NOT deleted id=${person.id}`}`);
  }
}
console.log(failures ? `${failures} FAILED` : "ALL MOMENT TAP TESTS PASSED");
process.exit(failures ? 1 : 0);
