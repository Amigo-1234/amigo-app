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
  page.setDefaultTimeout(15000);
  const errors = [];
  const bad = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
  page.on("response", (r) => {
    const u = new URL(r.url());
    if (r.status() >= 400 && (u.pathname.startsWith("/api/") || u.pathname.startsWith("/neon/") || u.hostname.endsWith("r2.cloudflarestorage.com")))
      bad.push(`${r.request().method()} ${u.hostname.endsWith("r2.cloudflarestorage.com") ? "R2" : u.pathname.replace(/[0-9a-f-]{32,}/g, "…")} ${r.status()}`);
  });
  /** What the phone shows right now (no secrets: page text and button names only). */
  const describe = async () => {
    const text = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 220);
    const buttons = await page.locator("button:visible").evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-label") || b.textContent?.trim()).filter(Boolean).slice(0, 25)).catch(() => []);
    return `url=${new URL(page.url()).pathname} · text="${text}" · buttons=[${buttons.join(" | ")}] · failed requests=[${bad.slice(-6).join(", ")}] · errors=[${errors.slice(-3).join(" | ").slice(0, 300)}]`;
  };
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (e) {
      failures++;
      console.log(`FAIL ${name}: ${e.message.split("\n")[0]}`);
      console.log(`     page: ${await describe()}`);
    }
    await page.screenshot({ path: `${SHOTS}/${name.replace(/\W+/g, "-")}.png` }).catch(() => undefined);
  };
  const check = async (label, cond) => {
    if (cond) return ok(label, true);
    ok(label, false, await describe());
  };
  // A real image for uploads: a screenshot (PNG) of a coloured box.
  await page.setContent(`<div style="width:320px;height:240px;background:linear-gradient(135deg,#ff5a3c,#ffd166)"></div>`);
  const photo = await page.locator("div").screenshot();

  await page.goto(BASE, { waitUntil: "networkidle" });
  // A new account first accepts the legal documents, as in the app.
  const agree = page.getByRole("button", { name: "I agree" });
  await agree.waitFor().catch(() => undefined);
  if (await agree.isVisible().catch(() => false)) {
    await agree.click();
    ok("legal acceptance gate works on a phone", true);
  }
  await page.locator(".bottom-create").waitFor().catch(() => undefined);
  const home = (await page.locator(".bottom-create").count()) === 1;
  await check("signed-in home loads on a phone", home);
  if (!home) throw new Error("not signed in on the page; skipping the UI flows");
  const imgLoaded = (loc) => loc.evaluate((img) => img.complete && img.naturalWidth > 0).catch(() => false);
  const waitImg = async (loc, ms = 20000) => {
    await loc.waitFor({ timeout: ms }).catch(() => undefined);
    for (let t = 0; t < ms && !(await imgLoaded(loc)); t += 500) await page.waitForTimeout(500);
    return imgLoaded(loc);
  };
  const noOverflow = async () => (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0;
  const R2 = /r2\.cloudflarestorage\.com/;
  const compose = async (text, file) => {
    await page.locator(".bottom-create").click();
    const dialog = page.getByRole("dialog");
    await dialog.locator('input[type="file"]').setInputFiles({ name: file, mimeType: "image/png", buffer: photo });
    await dialog.locator("textarea").fill(text);
    await page.waitForTimeout(800);
    await dialog.getByRole("button", { name: "Post", exact: true }).first().click();
  };

  await step("photo post", async () => {
    // Slow R2 down so the in-progress state is visible.
    await page.route(R2, async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await compose(`Live photo post ${tag}`, "photo.png");
    await check("upload in progress is shown (Posting…)", await page.getByText("Posting…").first().isVisible().catch(() => false));
    await check("photo post appears and its image loads from R2", await waitImg(page.locator(`article:has-text("Live photo post ${tag}") img`).first()));
    await page.unroute(R2);
    await check("no horizontal scroll with a photo post", await noOverflow());
  });

  await step("upload failure and retry", async () => {
    await page.route(R2, (route) => route.abort());
    await compose(`Retry photo post ${tag}`, "photo2.png");
    const failed = page.getByText("Couldn't post. Your post is saved here.").first();
    await failed.waitFor({ timeout: 30000 }).catch(() => undefined);
    await check("failed upload shows a clear error with Retry", await failed.isVisible().catch(() => false));
    await page.unroute(R2);
    await page.locator(`article:has-text("Retry photo post ${tag}")`).getByRole("button", { name: "Retry" }).click();
    await check("Retry posts it and the image loads", await waitImg(page.locator(`article:has-text("Retry photo post ${tag}") img`).first(), 30000));
  });

  await step("profile picture", async () => {
    await page.goto(`${BASE}/profile`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Edit profile" }).click();
    const form = page.locator('form[aria-label="Edit profile"]');
    await form.locator('input[type="file"]').setInputFiles({ name: "me.png", mimeType: "image/png", buffer: photo });
    await page.waitForTimeout(1500);
    await form.getByRole("button", { name: "Save" }).click();
    await form.waitFor({ state: "detached", timeout: 30000 });
    await page.reload({ waitUntil: "networkidle" });
    const avatar = page.locator('.profile img[src*="/api/media/"]').first();
    await check("profile picture saved and loads from R2 after reload", await waitImg(avatar));
  });

  await step("photo Moment", async () => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Add a Moment" }).first().click();
    const mdialog = page.getByRole("dialog");
    await mdialog.locator('input[type="file"]').setInputFiles({ name: "m.png", mimeType: "image/png", buffer: photo });
    await page.waitForTimeout(1500);
    await mdialog.getByRole("button", { name: "Share Moment" }).click();
    const shared = page.getByText(/Moment shared/).first();
    await shared.waitFor({ timeout: 30000 }).catch(() => undefined);
    await check("photo Moment shared", await shared.isVisible().catch(() => false));
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: /Your Moments/ }).first().click();
    await check("photo Moment opens and its image loads from R2", await waitImg(page.locator('img[src*="/api/media/"]').last()));
  });

  // Keep signed links to A's files to prove they're deleted from R2 later.
  const { data: rows } = await (await fetch(`${BASE}/neon/rest/v1/posts?author_id=eq.${A.id}&select=media:post_media(storage_path)`, { headers: { ...BYPASS, authorization: `Bearer ${A.token}` } })).json().then((d) => ({ data: d }));
  const get = (path) => fetch(`${BASE}/neon/rest/v1/${path}`, { headers: { ...BYPASS, authorization: `Bearer ${A.token}` } }).then((r) => (r.ok ? r.json() : []), () => []);
  const [me] = await get(`profiles?id=eq.${A.id}&select=avatar_url`);
  const moments = await get(`moments?author_id=eq.${A.id}&select=media_path`);
  const keys = [
    ...(Array.isArray(rows) ? rows : []).flatMap((p) => p.media.map((m) => m.storage_path)),
    ...(me?.avatar_url?.startsWith("/api/media/") ? [me.avatar_url.slice(11)] : []),
    ...moments.map((m) => m.media_path).filter(Boolean),
  ];
  console.log(`files created by the UI flows: ${keys.length}`);
  for (const key of keys) {
    const r = await fetch(`${BASE}/api/media/${key}?json=1`, { headers: { ...BYPASS, authorization: `Bearer ${A.token}` } });
    if (r.ok) signedLinks.push((await r.json()).url);
  }
  const pageErrors = errors.filter((e) => !e.startsWith("console:"));
  ok("no uncaught page errors during the flows", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));
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
