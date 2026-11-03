/**
 * Full-screen viewers and sheets on an iPhone-sized touch browser (Chromium or
 * WebKit): looking at a photo must never close it or reach the screen behind.
 *
 *   Post photo viewer: the full-size photo loads (not the feed copy); tapping
 *   Zoom in / out, tapping the dark space around the photo and pinching keep it
 *   open; Save is offered; a swipe down and the close button close it.
 *   Moment viewer: a pinch zooms the photo (the Moment pauses) without closing
 *   it or skipping ahead; Done zooms back out; a swipe down closes.
 *   Sheets: a press that starts in the panel and ends on the backdrop keeps
 *   the sheet open; a tap on the backdrop closes it.
 *
 * Gestures are sent as touch pointer events (what iOS Safari delivers).
 *
 *   BASE=https://<domain> VERCEL_BYPASS=… [ENGINE=webkit] node scripts/test/live-viewers.test.mjs
 *
 * One temporary account (its post and Moment), deleted at the end. Prints no secrets.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function account(tag) {
  const email = `amigo-e2e-${tag}-v@example.com`;
  const password = randomBytes(18).toString("base64url");
  const res = await fetch(`${BASE}/neon/auth/sign-up/email`, {
    method: "POST",
    headers: { ...BYPASS, origin: BASE, "content-type": "application/json" },
    body: JSON.stringify({ email, password, name: `Viewer Test ${tag}` }),
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
  const ctx = await browser.newContext({ ...devices["iPhone 13"] });
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
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  const agree = page.getByRole("button", { name: "I agree" });
  await agree.waitFor({ timeout: 8000 }).catch(() => undefined);
  if (await agree.isVisible().catch(() => false)) {
    await agree.click();
    await agree.waitFor({ state: "detached", timeout: 15000 }).catch(() => undefined);
  }

  /** A 12 MP landscape photo: wide enough to leave dark space above and below it in a portrait viewer. */
  const photo = Buffer.from(
    await page.evaluate(async () => {
      const c = document.createElement("canvas");
      c.width = 4032;
      c.height = 3024;
      const x = c.getContext("2d");
      const g = x.createLinearGradient(0, 0, 4032, 3024);
      g.addColorStop(0, "#2bb673");
      g.addColorStop(1, "#ffcc33");
      x.fillStyle = g;
      x.fillRect(0, 0, 4032, 3024);
      const b = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
      c.width = c.height = 0;
      return Array.from(new Uint8Array(await b.arrayBuffer()));
    }),
  );

  /** Touch gestures as iOS delivers them: pointer events with pointerType "touch". */
  const gesture = (selector, kind) =>
    page.evaluate(
      async ({ selector, kind }) => {
        const el = document.querySelector(selector);
        if (!el) return "missing";
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const fire = (type, id, x, y, target = el) =>
          target.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: "touch", isPrimary: id === 1, clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true }));
        const wait = () => new Promise((res) => requestAnimationFrame(() => res()));
        if (kind === "pinch") {
          fire("pointerdown", 1, cx - 20, cy);
          fire("pointerdown", 2, cx + 20, cy);
          for (let i = 1; i <= 8; i++) {
            fire("pointermove", 1, cx - 20 - i * 15, cy - i * 4);
            fire("pointermove", 2, cx + 20 + i * 15, cy + i * 12);
            await wait();
          }
          // Fingers lift one after the other, the last one well below where it started.
          fire("pointerup", 1, cx - 140, cy - 32);
          await wait();
          fire("pointerup", 2, cx + 140, cy + 140);
        } else if (kind === "swipe-down") {
          fire("pointerdown", 1, cx, cy - 100);
          for (let i = 1; i <= 8; i++) {
            fire("pointermove", 1, cx + 4, cy - 100 + i * 30);
            await wait();
          }
          fire("pointerup", 1, cx + 4, cy + 140);
        } else if (kind === "tap-top") {
          // The dark space above a landscape photo.
          const x = cx;
          const y = r.top + 40;
          const target = document.elementFromPoint(x, y) ?? el;
          fire("pointerdown", 1, x, y, target);
          fire("pointerup", 1, x, y, target);
          target.dispatchEvent(new MouseEvent("click", { clientX: x, clientY: y, bubbles: true }));
        }
        await wait();
        return "done";
      },
      { selector, kind },
    );

  // ------------------------------------------------------------ a photo post
  await page.locator(".bottom-create").click();
  const composer = page.locator('dialog[aria-label="New post"]');
  await composer.waitFor();
  await composer.locator('input[type="file"]').setInputFiles({ name: "IMG_0002.JPG", mimeType: "image/jpeg", buffer: photo });
  await composer.locator("textarea").first().fill(`Viewer test ${tag}`);
  await composer.getByRole("button", { name: "Post", exact: true }).last().click();
  const tile = page.locator("article", { hasText: `Viewer test ${tag}` }).locator(".media-tile__open").first();
  ok("photo post appears in the feed", await tile.waitFor({ timeout: 45000 }).then(() => true, () => false));

  // ------------------------------------------------------------ post viewer
  const viewer = page.locator("dialog.media-viewer");
  const isOpen = () => viewer.evaluate((d) => d.open).catch(() => false);
  await tile.tap();
  ok("tapping the photo opens the viewer", await page.waitForFunction(() => document.querySelector("dialog.media-viewer")?.open, null, { timeout: 10000 }).then(() => true, () => false));
  const full = await page.waitForFunction(() => document.querySelector(".media-viewer__img.is-loaded")?.naturalWidth || 0, null, { timeout: 30000 }).then((h) => h.jsonValue(), () => 0);
  const imgs = await page.evaluate(() =>
    [...document.querySelectorAll(".media-viewer__img")].map((i) => `${i.className} ${i.src.split(":")[0]}${i.src.includes("size=sm") ? "(sm)" : ""} complete=${i.complete} w=${i.naturalWidth}`),
  );
  ok("the full-size photo loads (not the feed copy)", full >= 2000, `${full} px wide · ${imgs.join(" | ")}`);
  ok("Save is offered", await viewer.getByRole("button", { name: "Save photo" }).isVisible());

  await viewer.getByRole("button", { name: "Zoom in" }).tap();
  await sleep(600);
  ok("tapping Zoom in zooms and keeps the viewer open", (await isOpen()) && (await page.locator(".media-viewer__stage.is-zoomed").count()) === 1);
  await viewer.getByRole("button", { name: "Zoom out" }).tap();
  await sleep(600);
  ok("tapping Zoom out keeps the viewer open", await isOpen());

  await gesture(".media-viewer__stage", "tap-top");
  await sleep(700);
  ok("tapping the dark space around the photo doesn't close it", await isOpen());
  await gesture(".media-viewer__stage", "pinch");
  await sleep(700);
  ok("pinching the photo doesn't close it (even when a finger lifts low)", await isOpen());
  ok("…and zooms it", (await page.locator(".media-viewer__stage.is-zoomed").count()) === 1);
  await page.keyboard.press("0"); // back to normal size
  await sleep(200);
  await gesture(".media-viewer__stage", "swipe-down");
  await sleep(700);
  ok("a deliberate swipe down closes it", !(await isOpen()));
  await tile.tap();
  await page.waitForFunction(() => document.querySelector("dialog.media-viewer")?.open, null, { timeout: 10000 }).catch(() => undefined);
  await viewer.getByRole("button", { name: "Close" }).tap();
  await sleep(500);
  ok("the close button closes it", !(await isOpen()));

  // ------------------------------------------------------------ sheets
  await page.locator("article", { hasText: `Viewer test ${tag}` }).getByRole("button", { name: "Post options" }).tap();
  await page.waitForFunction(() => document.querySelector('dialog[open][aria-label="Post options"]'), null, { timeout: 10000 }).catch(() => undefined);
  // Every post has its own (closed) options sheet: this is the open one.
  const sheet = page.locator('dialog[open][aria-label="Post options"]');
  const panel = await sheet.locator(".sheet__panel").boundingBox();
  if (panel) {
    await page.mouse.move(panel.x + panel.width / 2, panel.y + 20);
    await page.mouse.down();
    await page.mouse.move(panel.x + panel.width / 2, Math.max(10, panel.y - 120), { steps: 6 });
    await page.mouse.up();
  }
  await sleep(400);
  ok("a press that starts in a sheet and ends on the backdrop keeps it open", (await sheet.count()) === 1);
  await page.mouse.click(20, 40);
  await sleep(400);
  ok("a tap on the backdrop closes the sheet", (await page.locator('dialog[open][aria-label="Post options"]').count()) === 0);

  // ------------------------------------------------------------ Moment viewer
  await page.getByRole("button", { name: "Add a Moment" }).first().click();
  const mc = page.locator(".moment-composer");
  await mc.locator('input[type="file"]').setInputFiles({ name: "IMG_0003.JPG", mimeType: "image/jpeg", buffer: photo });
  await mc.locator(".moment-visual.is-ready.has-photo").waitFor({ timeout: 30000 });
  await mc.locator(".moment-composer__head").getByRole("button", { name: "Share" }).click();
  await page.getByText("Moment shared").first().waitFor({ timeout: 30000 });
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^Your Moments/ }).first().click();
  const mv = page.locator("dialog.moment-viewer");
  await page.locator(".moment-viewer .moment-visual.is-ready").waitFor({ timeout: 30000 });
  const mOpen = () => mv.evaluate((d) => d.open).catch(() => false);
  await gesture(".moment-viewer__frame", "pinch");
  await sleep(700);
  ok("pinching a Moment doesn't close it", await mOpen());
  ok("…zooms the photo", (await page.locator(".moment-viewer__zoom.is-zoomed").count()) === 1);
  const doneBtn = mv.getByRole("button", { name: "Done" });
  ok("…and offers Done to zoom back out", await doneBtn.isVisible().catch(() => false));
  await sleep(6500); // a Moment advances after a few seconds unless paused
  ok("…while zoomed the Moment stays open (paused)", (await mOpen()) && (await page.locator(".moment-viewer__zoom.is-zoomed").count()) === 1);
  await doneBtn.tap().catch(() => undefined);
  await sleep(300);
  ok("Done zooms back out", (await page.locator(".moment-viewer__zoom.is-zoomed").count()) === 0);
  await gesture(".moment-viewer__frame", "swipe-down");
  await sleep(800);
  ok("a deliberate swipe down closes the Moment", !(await mOpen()));
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
console.log(failures ? `${failures} FAILED` : "ALL VIEWER TESTS PASSED");
process.exit(failures ? 1 : 0);
