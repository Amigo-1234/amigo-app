/**
 * Photo Moments through the app's UI on an iPhone-sized browser (Chromium or
 * WebKit), with camera-sized photos made in the browser:
 *
 *   a 24 MP landscape JPEG and a 12 MP JPEG marked "rotate 90°" (EXIF 6, as
 *   iPhones save portrait shots) → the composer shows a "Preparing" state, the
 *   preview shows the real picture (never a black frame), upright and in its
 *   own shape, Share stays disabled until the preview has loaded → sharing →
 *   opening the Moment shows the full-size photo.
 *
 *   BASE=https://<domain> VERCEL_BYPASS=… [ENGINE=webkit] node scripts/test/live-moment-photo.test.mjs
 *
 * One temporary account, deleted at the end (its Moments go with it). Prints no secrets.
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
  const email = `amigo-e2e-${tag}-m@example.com`;
  const password = randomBytes(18).toString("base64url");
  const res = await fetch(`${BASE}/neon/auth/sign-up/email`, {
    method: "POST",
    headers: { ...BYPASS, origin: BASE, "content-type": "application/json" },
    body: JSON.stringify({ email, password, name: `Photo Test ${tag}` }),
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

/** Adds an EXIF block saying "rotate 90° clockwise to display" (orientation 6). */
function withOrientation6(jpeg) {
  const tiff = Buffer.concat([Buffer.from("MM\0\x2a"), u32(8), u16(1), u16(0x0112), u16(3), u32(1), u16(6), u16(0), u32(0)]);
  const app1 = Buffer.concat([Buffer.from("Exif\0\0"), tiff]);
  return Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1]), u16(app1.length + 2), app1, jpeg.subarray(2)]);
  function u16(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; }
  function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; }
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

  /** A camera-sized JPEG drawn in the page: a colour gradient with a dark band along its top edge. */
  const makeJpeg = (w, h) =>
    page.evaluate(
      async ({ w, h }) => {
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const x = c.getContext("2d");
        const g = x.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, "#ff8a3d");
        g.addColorStop(1, "#3d6bff");
        x.fillStyle = g;
        x.fillRect(0, 0, w, h);
        x.fillStyle = "#111";
        x.fillRect(0, 0, w, Math.round(h * 0.08));
        const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
        c.width = c.height = 0;
        return Array.from(new Uint8Array(await blob.arrayBuffer()));
      },
      { w, h },
    ).then((a) => Buffer.from(a));

  /** What the composer preview actually shows: its shape, and whether it's a real picture. */
  const inspect = (sel) =>
    page.evaluate((sel) => {
      const img = document.querySelector(sel);
      if (!img || !img.complete || !img.naturalWidth) return null;
      const c = document.createElement("canvas");
      c.width = 24;
      c.height = 24;
      const x = c.getContext("2d");
      x.drawImage(img, 0, 0, 24, 24);
      const d = x.getImageData(0, 0, 24, 24).data;
      let min = 765, max = 0;
      const edge = { top: 0, bottom: 0, left: 0, right: 0 };
      for (let i = 0; i < d.length; i += 4) {
        const v = d[i] + d[i + 1] + d[i + 2];
        min = Math.min(min, v);
        max = Math.max(max, v);
        const row = Math.floor(i / 4 / 24), col = (i / 4) % 24;
        if (row === 0) edge.top += v;
        if (row === 23) edge.bottom += v;
        if (col === 0) edge.left += v;
        if (col === 23) edge.right += v;
      }
      const darkest = Object.entries(edge).sort((a, b) => a[1] - b[1])[0][0];
      return { w: img.naturalWidth, h: img.naturalHeight, range: max - min, darkest, opacity: getComputedStyle(img).opacity };
    }, sel);

  const cases = [
    { name: "24 MP landscape JPEG", w: 5712, h: 4284, rotate: false },
    { name: "12 MP iPhone portrait (EXIF rotate 90°)", w: 4032, h: 3024, rotate: true },
  ];
  for (const c of cases) {
    let bytes = await makeJpeg(c.w, c.h);
    if (c.rotate) bytes = withOrientation6(bytes);
    await page.getByRole("button", { name: "Add a Moment" }).first().click();
    const sheet = page.locator(".moment-composer");
    await sheet.waitFor();
    const share = sheet.locator(".moment-composer__head").getByRole("button", { name: "Share" });
    await sheet.locator('input[type="file"]').setInputFiles({ name: "IMG_0001.JPG", mimeType: "image/jpeg", buffer: bytes });
    const preparing = await sheet.getByText("Preparing your photo…").isVisible().catch(() => false);
    const disabledWhilePreparing = preparing ? await share.isDisabled() : null;
    const ready = await sheet.locator(".moment-composer__frame .moment-visual.is-ready.has-photo").waitFor({ timeout: 30000 }).then(() => true, () => false);
    ok(`${c.name}: the preview loads`, ready, (await sheet.innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 160));
    if (preparing) ok(`${c.name}: Share is disabled while the photo is prepared`, disabledWhilePreparing === true);
    const shown = await inspect(".moment-composer__frame .moment-visual__photo");
    ok(`${c.name}: the preview is a real picture, not a black frame`, !!shown && shown.range > 60 && shown.opacity === "1", JSON.stringify(shown));
    // The dark band is along the photo's top edge as stored; "rotate 90° clockwise" puts it on the right.
    ok(`${c.name}: upright and in its own shape`, !!shown && (shown.h > shown.w) === c.rotate && shown.darkest === (c.rotate ? "right" : "top"), JSON.stringify(shown));
    ok(`${c.name}: kept at high resolution (longest edge ≥ 2000 px)`, !!shown && Math.max(shown.w, shown.h) >= 2000, shown ? `${shown.w}×${shown.h}` : "");
    ok(`${c.name}: no error shown`, !(await sheet.locator(".moment-composer__status--error, .form-error").count()));
    ok(`${c.name}: Share is enabled once the preview is ready`, await share.isEnabled());
    if (!c.rotate) {
      await share.click();
      ok("the Moment is shared", await page.getByText("Moment shared").first().waitFor({ timeout: 30000 }).then(() => true, () => false));
    } else {
      await sheet.getByRole("button", { name: "Close" }).first().click();
      await sheet.waitFor({ state: "detached" }).catch(() => undefined);
    }
  }

  // Open it: the full-size photo shows.
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^Your Moments/ }).first().click();
  const viewerPhoto = ".moment-viewer .moment-visual__photo";
  const opened = await page.locator(".moment-viewer .moment-visual.is-ready").waitFor({ timeout: 30000 }).then(() => true, () => false);
  ok("opening the Moment shows its photo", opened);
  const big = await inspect(viewerPhoto).catch(() => null);
  ok("…the real picture at full size (not a blurry thumbnail)", !!big && big.range > 60 && Math.max(big.w, big.h) >= 2000, JSON.stringify(big));
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
console.log(failures ? `${failures} FAILED` : "ALL MOMENT PHOTO TESTS PASSED");
process.exit(failures ? 1 : 0);
