/**
 * The Moment viewer on an iPhone-sized touch screen, offline: the app in demo
 * mode (in-memory data, no backend, no accounts) in Chromium, with every photo
 * served locally as a generated PNG of a known shape.
 *
 *   - photos show whole at their own shape (portrait, landscape, square), centred,
 *     over the blurred backdrop where they don't reach the edges;
 *   - the page behind is locked while a Moment is open (drags and wheel don't move
 *     it, a "Seen by" sheet over the Moment keeps it locked), and is put back exactly
 *     where it was however the viewer closes: the close button, a swipe down,
 *     Back, or a route change (the author's name);
 *   - the feed scrolls normally afterwards.
 *
 *   node scripts/test/moment-viewer.test.mjs
 *
 * Chromium only (WebKit isn't installed here): iOS Safari specifics still need an iPhone.
 */
import { createServer } from "vite";
import { createRequire } from "node:module";
import { deflateSync } from "node:zlib";

// The project's Playwright if installed (CI: npm i --no-save playwright), else a global one (NODE_PATH).
const { chromium } = await import("playwright").catch(() => createRequire(import.meta.url)("playwright"));

let failures = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};

// ------------------------------------------------------------ photos

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
/** A w×h PNG: coloured bands, so a stretched or cropped photo would be visible in a screenshot. */
function png(w, h, [r, g, b]) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const edge = x < 8 || y < 8 || x >= w - 8 || y >= h - 8;
      const band = Math.floor((y / h) * 6) % 2;
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = edge ? 255 : band ? r : r >> 1;
      raw[o + 1] = edge ? 255 : band ? g : g >> 1;
      raw[o + 2] = edge ? 255 : band ? b : b >> 1;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
// The demo's Moment photos (src/data/demoMoments.ts), served at these shapes. Where the shape
// differs from what the Moment stored, the photo's real shape must win.
const SHAPES = {
  "amigo-moment-studio": [1080, 1920, [60, 120, 220]], // portrait 9:16
  "amigo-moment-roof": [1600, 900, [220, 120, 60]], // landscape 16:9 (stored as portrait)
  "amigo-moment-gold": [1000, 1000, [60, 200, 120]], // square (stored as 4:5)
  "amigo-moment-paris": [1200, 1600, [200, 60, 160]], // portrait 3:4
};

// ------------------------------------------------------------ app

const server = await createServer({ mode: "demo", logLevel: "error", server: { host: "127.0.0.1", port: 0, strictPort: false } });
await server.listen();
const BASE = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 664 }, // an iPhone 13/14 screen below Safari's bars
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
});
// Nothing leaves this machine: photos are generated, everything else non-local is refused.
await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => {
  const m = route.request().url().match(/picsum\.photos\/seed\/([^/]+)\/(\d+)\/(\d+)/);
  if (!m) return route.abort();
  const [w, h, colour] = SHAPES[m[1]] ?? [Number(m[2]), Number(m[3]), [128, 128, 128]];
  return route.fulfill({ status: 200, contentType: "image/png", body: png(w, h, colour) });
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const cdp = await context.newCDPSession(page);

/** A one-finger drag, as a phone sends it (touch events → pointer events). */
async function drag(x, y, dx, dy, steps = 8) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + (dx * i) / steps, y: y + (dy * i) / steps }] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

const pageState = () =>
  page.evaluate(() => ({
    locked: document.documentElement.classList.contains("scroll-locked"),
    position: document.body.style.position,
    top: document.body.style.top,
    scrollY: Math.round(window.scrollY),
    viewportH: document.documentElement.style.getPropertyValue("--viewport-h"),
    feedTop: Math.round(document.querySelector("article")?.getBoundingClientRect().top ?? NaN),
  }));

/** Where the photo sits in the frame, and the photo's own shape. */
const photoBox = () =>
  page.evaluate(() => {
    const d = document.querySelector("dialog.moment-viewer[open]");
    const frame = d?.querySelector(".moment-visual");
    const img = d?.querySelector(".moment-visual.is-ready .moment-visual__photo");
    if (!frame || !img || !img.naturalWidth) return null;
    const f = frame.getBoundingClientRect();
    const i = img.getBoundingClientRect();
    return {
      frame: { w: f.width, h: f.height, x: f.x, y: f.y },
      img: { w: i.width, h: i.height, x: i.x, y: i.y },
      natural: { w: img.naturalWidth, h: img.naturalHeight },
      backdrop: !!d.querySelector(".moment-visual__backdrop"),
      dialog: d.getBoundingClientRect().height,
    };
  });

const SHOTS = process.env.SHOTS;
let shot = 0;
async function checkWhole(label, b) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${++shot}-${label.replace(/[^a-z0-9]+/gi, "-")}.png` });
  if (!b) return ok(`${label}: photo on screen`, false);
  const shape = b.natural.w / b.natural.h;
  const shown = b.img.w / b.img.h;
  const inside = b.img.x >= b.frame.x - 1 && b.img.y >= b.frame.y - 1 && b.img.x + b.img.w <= b.frame.x + b.frame.w + 1 && b.img.y + b.img.h <= b.frame.y + b.frame.h + 1;
  const fits = Math.abs(b.img.w - b.frame.w) < 1.5 || Math.abs(b.img.h - b.frame.h) < 1.5;
  const centred = Math.abs(b.img.x + b.img.w / 2 - (b.frame.x + b.frame.w / 2)) < 1.5 && Math.abs(b.img.y + b.img.h / 2 - (b.frame.y + b.frame.h / 2)) < 1.5;
  const gaps = b.img.w < b.frame.w - 1 || b.img.h < b.frame.h - 1;
  ok(`${label}: shape kept (${b.natural.w}×${b.natural.h})`, Math.abs(shown / shape - 1) < 0.01, `shown ${b.img.w.toFixed(1)}×${b.img.h.toFixed(1)}`);
  ok(`${label}: whole photo inside the frame, as large as fits, centred`, inside && fits && centred, JSON.stringify(b.img));
  if (gaps) ok(`${label}: blurred backdrop fills the rest`, b.backdrop);
}

const viewer = page.locator("dialog.moment-viewer[open]");
const ready = () => viewer.locator(".moment-visual.is-ready").first().waitFor({ timeout: 10000 });
const currentId = () => viewer.locator(".moment-viewer__time").first().getAttribute("datetime");

async function scrollFeedTo(y) {
  await page.evaluate((y) => window.scrollTo(0, y), y);
  await page.waitForTimeout(150);
  return pageState();
}

/** Opens someone's Moments without scrolling the row into view (the page stays where it is). */
async function openMoments(name) {
  // A tap right after a close is swallowed on purpose (it mustn't land on the feed): wait it out.
  await page.waitForTimeout(600);
  await page.getByRole("button", { name }).first().evaluate((b) => b.click());
  await viewer.waitFor();
  await ready();
}

const closed = async () => {
  await page.waitForFunction(() => !document.querySelector("dialog.moment-viewer[open]"), null, { timeout: 5000 });
  await page.waitForTimeout(100);
};

try {
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.locator(".moments-row").waitFor({ timeout: 30000 });
  await page.locator("article").nth(3).waitFor({ timeout: 30000 });

  // ---- 1. Open a Moment with the feed scrolled part-way down
  const before = await scrollFeedTo(700);
  ok("setup: the feed is scrolled", before.scrollY > 300, String(before.scrollY));
  await openMoments(/^Ama Mensah's Moments/);
  let s = await pageState();
  ok("open: page locked (html.scroll-locked, body pinned at its offset)", s.locked && s.position === "fixed" && s.top === `-${before.scrollY}px` && s.feedTop === before.feedTop, JSON.stringify(s));
  ok("open: viewer sized to the visible viewport", !!s.viewportH && Math.abs((await photoBox()).dialog - parseInt(s.viewportH)) < 1.5, s.viewportH);
  await checkWhole("landscape photo", await photoBox());

  // Drags and the wheel over the Moment don't move the page.
  await drag(200, 420, 0, -220);
  await page.mouse.wheel(0, 800);
  await page.waitForTimeout(200);
  const afterDrag = await pageState();
  ok("open: dragging up and the wheel don't scroll the page", afterDrag.top === s.top && afterDrag.feedTop === s.feedTop, JSON.stringify(afterDrag));
  ok("open: still open after an upward drag", await viewer.isVisible());

  // ---- 2. Next Moment (tap the right side)
  const first = await currentId();
  await page.touchscreen.tap(330, 330);
  await page.waitForFunction((id) => document.querySelector("dialog.moment-viewer[open] .moment-viewer__time")?.getAttribute("datetime") !== id, first, { timeout: 5000 });
  await ready();
  await checkWhole("square photo", await photoBox());
  ok("next Moment: page still locked", (await pageState()).locked);

  // ---- 3. Close with the button: page back where it was, scrolls normally
  await viewer.getByRole("button", { name: "Close" }).click();
  await closed();
  s = await pageState();
  ok("close button: page released and back where it was", !s.locked && s.position === "" && s.top === "" && s.scrollY === before.scrollY && s.feedTop === before.feedTop && !s.viewportH, JSON.stringify(s));

  // ---- 4. Swipe down to close
  const before4 = await scrollFeedTo(450);
  await openMoments(/^Mira/);
  await checkWhole("portrait photo (9:16)", await photoBox());
  await drag(200, 250, 0, 200);
  await closed();
  s = await pageState();
  ok("swipe down: closed, page released where it was", !s.locked && s.position === "" && s.scrollY === before4.scrollY, JSON.stringify(s));

  // ---- 5. Back button closes and releases
  const before5 = await scrollFeedTo(900);
  await openMoments(/^Zoë/);
  await checkWhole("portrait photo (3:4)", await photoBox());
  await page.goBack();
  await closed();
  s = await pageState();
  ok("Back: closed, page released where it was", !s.locked && s.position === "" && s.scrollY === before5.scrollY, JSON.stringify(s));

  // ---- 6. Your own Moment: "Seen by" over it
  await page.waitForTimeout(600);
  await scrollFeedTo(0);
  await page.getByRole("button", { name: "Add a Moment", exact: true }).first().click();
  const composer = page.locator(".moment-composer");
  await composer.waitFor();
  await composer.locator('input[type="file"]').setInputFiles({ name: "wide.png", mimeType: "image/png", buffer: png(1200, 800, [240, 200, 40]) });
  await composer.locator(".moment-composer__frame .moment-visual.has-photo.is-ready").waitFor({ timeout: 15000 });
  const preview = await composer.evaluate((c) => {
    const f = c.querySelector(".moment-composer__frame .moment-visual").getBoundingClientRect();
    const i = c.querySelector(".moment-composer__frame .moment-visual__photo").getBoundingClientRect();
    return { fw: f.width, fh: f.height, iw: i.width, ih: i.height };
  });
  ok("composer preview: the whole photo at its shape", Math.abs(preview.iw / preview.ih - 1.5) < 0.015 && Math.abs(preview.iw - preview.fw) < 1.5 && preview.ih < preview.fh, JSON.stringify(preview));
  ok("composer: no fill/zoom controls (the whole photo always shows)", (await composer.getByRole("group", { name: "Photo framing" }).count()) === 0);
  await composer.locator(".moment-composer__head").getByRole("button", { name: "Share" }).click();
  await page.getByText("Moment shared").first().waitFor({ timeout: 15000 });
  await composer.waitFor({ state: "detached", timeout: 10000 }).catch(() => undefined);
  await page.waitForTimeout(400);

  const mine0 = await scrollFeedTo(600);
  await openMoments(/^Your Moments/);
  await checkWhole("your landscape photo (3:2)", await photoBox());
  await viewer.getByRole("button", { name: /Seen by/ }).click();
  const seen = page.locator("dialog.sheet[open]", { hasText: "Seen by" });
  await seen.waitFor();
  const panel = await seen.locator(".sheet__panel").boundingBox();
  await drag(panel.x + panel.width / 2, panel.y + 30, 0, -200);
  await page.mouse.move(panel.x + panel.width / 2, panel.y + 30);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(200);
  s = await pageState();
  ok("Seen by open: page locked and unmoved", s.locked && s.position === "fixed" && s.top === `-${mine0.scrollY}px` && s.feedTop === mine0.feedTop, JSON.stringify(s));
  await page.keyboard.press("Escape");
  await seen.waitFor({ state: "hidden", timeout: 5000 });
  s = await pageState();
  ok("Seen by closed: the Moment is still open and the page still locked", (await viewer.isVisible()) && s.locked && s.position === "fixed", JSON.stringify(s));

  // ---- 7. A route change closes it (the author's name → profile) and releases the page
  await viewer.locator(".moment-viewer__who").click();
  await closed();
  await page.waitForTimeout(300);
  s = await pageState();
  ok("route change: page released", !s.locked && s.position === "" && s.top === "", JSON.stringify(s) + " " + page.url());

  // ---- 8. Normal scrolling afterwards
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.locator("article").nth(3).waitFor({ timeout: 30000 });
  await openMoments(/^Ama Mensah's Moments/);
  await viewer.getByRole("button", { name: "Close" }).click();
  await closed();
  const start8 = (await pageState()).scrollY;
  await drag(200, 560, 0, -300);
  await page.waitForTimeout(600);
  s = await pageState();
  ok("after closing: the feed scrolls by touch again", s.scrollY > start8 + 100 && !s.locked, JSON.stringify(s));

  ok("no page errors", errors.length === 0, errors.join(" | "));
} catch (e) {
  failures++;
  console.log(`FAIL ${e?.message ?? e}`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/failure.png` }).catch(() => undefined);
} finally {
  await browser.close();
  await server.close();
}
console.log(failures ? `${failures} FAILURE(S)` : "ALL MOMENT VIEWER TESTS PASSED");
process.exit(failures ? 1 : 0);
