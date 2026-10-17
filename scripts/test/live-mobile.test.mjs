/**
 * Live mobile browser test of media on the deployed preview (iPhone 13 profile,
 * real Neon + Cloudflare R2). Runs in GitHub Actions after live-media.test.mjs.
 *
 *   BASE=… VERCEL_BYPASS=… SHOTS=dir node scripts/test/live-mobile.test.mjs
 *
 * Signs up two temporary accounts (one does the UI flows, one drains deleted
 * files afterwards) and deletes both at the end. Prints no secrets.
 */
import { randomBytes } from "node:crypto";
import { chromium, devices } from "playwright";

const { BASE, VERCEL_BYPASS, SHOTS = "." } = process.env;
if (!BASE || !VERCEL_BYPASS) throw new Error("Set BASE and VERCEL_BYPASS");
const BYPASS = { "x-vercel-protection-bypass": VERCEL_BYPASS };

let failures = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};

async function account(tag, who) {
  const email = `amigo-e2e-${tag}-${who}@example.com`;
  const password = randomBytes(18).toString("base64url");
  const res = await fetch(`${BASE}/neon/auth/sign-up/email`, {
    method: "POST",
    headers: { ...BYPASS, origin: BASE, "content-type": "application/json" },
    body: JSON.stringify({ email, password, name: `Mobile Test ${who.toUpperCase()}` }),
  });
  if (!res.ok) throw new Error(`sign-up ${who}: ${res.status}`);
  const body = await res.json();
  const cookies = res.headers.getSetCookie();
  const cookie = cookies.map((c) => c.split(";")[0]).join("; ");
  const { token } = await (await fetch(`${BASE}/neon/auth/token`, { headers: { ...BYPASS, origin: BASE, cookie } })).json();
  return { id: body.user.id, token, cookies };
}

const rpc = (who, fn, args = {}) =>
  fetch(`${BASE}/neon/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { ...BYPASS, authorization: `Bearer ${who.token}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });

const tag = randomBytes(4).toString("hex");
const people = [];
const signedLinks = [];
const browser = await chromium.launch();
try {
  const A = await account(tag, "a");
  people.push(A);
  const D = await account(tag, "d");
  people.push(D);

  const ctx = await browser.newContext({ ...devices["iPhone 13"], extraHTTPHeaders: BYPASS });
  const host = new URL(BASE).hostname;
  await ctx.addCookies(
    A.cookies.map((c) => {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      return { name: pair.slice(0, i), value: pair.slice(i + 1), domain: host, path: "/", secure: true, httpOnly: /httponly/i.test(c), sameSite: "Lax" };
    }),
  );
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // A real image for uploads: a screenshot (PNG) of a coloured box.
  await page.setContent(`<div style="width:320px;height:240px;background:linear-gradient(135deg,#ff5a3c,#ffd166)"></div>`);
  const photo = await page.locator("div").screenshot();

  await page.goto(BASE, { waitUntil: "networkidle" });
  // A new account first accepts the legal documents, as in the app.
  const agree = page.getByRole("button", { name: "I agree" });
  await agree.waitFor({ timeout: 15000 }).catch(() => undefined);
  if (await agree.isVisible().catch(() => false)) {
    await agree.click();
    ok("legal acceptance gate works on a phone", true);
  }
  await page.locator(".bottom-create").waitFor({ timeout: 15000 }).catch(() => undefined);
  const home = (await page.locator(".bottom-create").count()) === 1;
  await page.screenshot({ path: `${SHOTS}/mobile-home.png` });
  ok("signed-in home loads on a phone", home, `${page.url()} · ${(await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 160)}`);
  if (!home) throw new Error("not signed in on the page; skipping the UI flows");
  const imgLoaded = (loc) => loc.evaluate((img) => img.complete && img.naturalWidth > 0).catch(() => false);
  const noOverflow = async () => (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0;

  // ---- photo post (with a visible "Posting…" state while uploading)
  await page.route(/r2\.cloudflarestorage\.com/, async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page.locator(".bottom-create").click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('input[type="file"]').setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: photo });
  await dialog.locator("textarea").fill(`Live photo post ${tag}`);
  await page.waitForTimeout(800);
  await dialog.getByRole("button", { name: "Post", exact: true }).first().click();
  const posting = await page.getByText("Posting…").first().isVisible().catch(() => false);
  ok("upload in progress is shown (Posting…)", posting);
  const postImg = page.locator(`article:has-text("Live photo post ${tag}") img`).first();
  await postImg.waitFor({ timeout: 30000 }).catch(() => undefined);
  await page.waitForTimeout(1500);
  ok("photo post appears and its image loads from R2", await imgLoaded(postImg));
  await page.unroute(/r2\.cloudflarestorage\.com/);
  await page.screenshot({ path: `${SHOTS}/mobile-photo-post.png` });
  ok("no horizontal scroll with a photo post", await noOverflow());

  // ---- upload failure: R2 unreachable → the post waits with Retry, then succeeds
  await page.route(/r2\.cloudflarestorage\.com/, (route) => route.abort());
  await page.locator(".bottom-create").click();
  await dialog.locator('input[type="file"]').setInputFiles({ name: "photo2.png", mimeType: "image/png", buffer: photo });
  await dialog.locator("textarea").fill(`Retry photo post ${tag}`);
  await page.waitForTimeout(800);
  await dialog.getByRole("button", { name: "Post", exact: true }).first().click();
  const failed = page.getByText("Couldn't post. Your post is saved here.");
  await failed.first().waitFor({ timeout: 30000 }).catch(() => undefined);
  ok("failed upload shows a clear error with Retry", await failed.first().isVisible().catch(() => false));
  await page.screenshot({ path: `${SHOTS}/mobile-upload-failed.png` });
  await page.unroute(/r2\.cloudflarestorage\.com/);
  await page.getByRole("button", { name: "Retry" }).first().click();
  const retried = page.locator(`article:has-text("Retry photo post ${tag}") img`).first();
  await retried.waitFor({ timeout: 30000 }).catch(() => undefined);
  await page.waitForTimeout(1500);
  ok("Retry posts it and the image loads", await imgLoaded(retried));

  // ---- profile picture
  await page.goto(`${BASE}/profile`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Edit profile" }).click();
  await page.locator('form[aria-label="Edit profile"] input[type="file"]').setInputFiles({ name: "me.png", mimeType: "image/png", buffer: photo });
  await page.waitForTimeout(1500);
  await page.locator('form[aria-label="Edit profile"]').getByRole("button", { name: "Save" }).click();
  await page.waitForTimeout(3000);
  await page.reload({ waitUntil: "networkidle" });
  const avatar = page.locator(".profile img").first();
  ok("profile picture saved and loads from R2 after reload", await imgLoaded(avatar), await avatar.getAttribute("src").catch(() => "none"));
  await page.screenshot({ path: `${SHOTS}/mobile-profile.png` });

  // ---- photo Moment
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Add a Moment|Your Moments/ }).first().click();
  const mdialog = page.getByRole("dialog");
  await mdialog.locator('input[type="file"]').setInputFiles({ name: "m.png", mimeType: "image/png", buffer: photo });
  await page.waitForTimeout(1500);
  await mdialog.getByRole("button", { name: "Share Moment" }).click();
  const shared = page.getByText(/Moment shared/);
  await shared.first().waitFor({ timeout: 30000 }).catch(() => undefined);
  ok("photo Moment shared", await shared.first().isVisible().catch(() => false));
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: /Your Moments/ }).first().click();
  await page.waitForTimeout(2500);
  const momentImg = page.locator(".moment-viewer img, [class*=moment] img").first();
  ok("photo Moment opens and its image loads from R2", await imgLoaded(momentImg));
  await page.screenshot({ path: `${SHOTS}/mobile-moment.png` });

  // Keep signed links to A's files to prove they're deleted from R2 later.
  const { data: rows } = await (await fetch(`${BASE}/neon/rest/v1/posts?author_id=eq.${A.id}&select=media:post_media(storage_path)`, { headers: { ...BYPASS, authorization: `Bearer ${A.token}` } })).json().then((d) => ({ data: d }));
  for (const key of (rows ?? []).flatMap((p) => p.media.map((m) => m.storage_path))) {
    const r = await fetch(`${BASE}/api/media/${key}?json=1`, { headers: { ...BYPASS, authorization: `Bearer ${A.token}` } });
    if (r.ok) signedLinks.push((await r.json()).url);
  }
  ok("no page errors during the flows", errors.length === 0, errors.join(" | ").slice(0, 300));
} catch (e) {
  console.error("error:", e.message);
  failures++;
} finally {
  await browser.close();
  const del = async (p) => {
    const d = await rpc(p, "delete_my_account", { p_confirm: "DELETE" }).catch(() => ({ status: 0 }));
    const done = d.status === 200 || d.status === 204;
    if (!done) failures++;
    console.log(`cleanup: temporary account ${done ? "deleted" : `NOT deleted (${d.status}) id=${p.id}`}`);
  };
  const drainer = people.at(-1);
  for (const p of people.slice(0, -1)) await del(p);
  if (drainer) {
    for (let i = 0; i < 4; i++) {
      await fetch(`${BASE}/api/media-upload`, {
        method: "POST",
        headers: { ...BYPASS, authorization: `Bearer ${drainer.token}`, "content-type": "application/json" },
        body: JSON.stringify({ purpose: "post", mime: "image/jpeg", size: 1 }),
      }).catch(() => undefined);
    }
    const gone = await Promise.all(signedLinks.map((u) => fetch(u).then((x) => x.status, () => 0)));
    ok("cleanup: test files removed from R2", gone.every((st) => st === 404), gone.join(","));
    await del(drainer);
  }
}
console.log(failures ? `${failures} FAILED` : "ALL LIVE MOBILE TESTS PASSED");
process.exit(failures ? 1 : 0);
