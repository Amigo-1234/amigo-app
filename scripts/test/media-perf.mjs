/**
 * How fast images appear in the deployed app, in a real browser on a phone
 * profile with mobile network conditions. One temporary account posts a few
 * photos through the app's own composer; a second one opens the feed cold,
 * reloads it, scrolls, visits a profile and comes back. Both accounts are
 * deleted at the end (their files go with them).
 *
 *   BASE=https://… VERCEL_BYPASS=… OUT=media.json node scripts/test/media-perf.mjs
 *
 * Prints no secrets: no tokens, cookies, object keys or signed URLs.
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { chromium, devices } from "playwright";

const { BASE, VERCEL_BYPASS, OUT = "media.json", PROFILES: ONLY = "ng-4g,ng-3g" } = process.env;
if (!BASE || !VERCEL_BYPASS) throw new Error("Set BASE and VERCEL_BYPASS");
const BYPASS = { "x-vercel-protection-bypass": VERCEL_BYPASS };
const ALL = {
  fast: { latency: 0, down: -1, up: -1, cpu: 1 },
  "ng-4g": { latency: 150, down: (4_000_000 / 8) | 0, up: (1_000_000 / 8) | 0, cpu: 4 },
  "ng-3g": { latency: 400, down: (400_000 / 8) | 0, up: (200_000 / 8) | 0, cpu: 4 },
};
const PROFILES = Object.fromEntries(ONLY.split(",").map((k) => [k, ALL[k]]));
const PHONE = devices["Pixel 5"];
const host = new URL(BASE).hostname;
const results = { base: BASE, at: new Date().toISOString(), upload: {}, profiles: {}, failures: [] };
const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]) : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function account(tag, who) {
  const email = `amigo-e2e-${tag}-${who}@example.com`;
  const password = randomBytes(18).toString("base64url");
  const res = await fetch(`${BASE}/neon/auth/sign-up/email`, {
    method: "POST",
    headers: { ...BYPASS, origin: BASE, "content-type": "application/json" },
    body: JSON.stringify({ email, password, name: `Media Test ${who.toUpperCase()}` }),
  });
  if (!res.ok) throw new Error(`sign-up ${who}: ${res.status}`);
  const body = await res.json();
  return { id: body.user.id, email, password, cookies: res.headers.getSetCookie() };
}
async function tokenOf(p) {
  const res = await fetch(`${BASE}/neon/auth/sign-in/email`, {
    method: "POST",
    headers: { ...BYPASS, origin: BASE, "content-type": "application/json" },
    body: JSON.stringify({ email: p.email, password: p.password }),
  });
  if (!res.ok) return null;
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const t = await (await fetch(`${BASE}/neon/auth/token`, { headers: { ...BYPASS, origin: BASE, cookie } })).json().catch(() => ({}));
  return t.token ?? null;
}

const browser = await chromium.launch();

/** Which hop a request is, without keys or query values. */
function kind(url) {
  const u = new URL(url);
  if (u.hostname.endsWith("r2.cloudflarestorage.com")) return "r2";
  if (u.hostname !== host) return "other";
  if (u.pathname === "/api/media-sign") return "sign";
  if (u.pathname.startsWith("/api/media/")) return "media-fn";
  return "other";
}

async function phone(who, profile) {
  const ctx = await browser.newContext({ ...PHONE });
  await ctx.request.get(BASE, { headers: { ...BYPASS, "x-vercel-set-bypass-cookie": "true" }, maxRedirects: 0 }).catch(() => undefined);
  await ctx.addCookies(
    who.cookies.map((raw) => {
      const [pair] = raw.split(";");
      const i = pair.indexOf("=");
      return { name: pair.slice(0, i), value: pair.slice(i + 1), domain: host, path: "/", secure: true, httpOnly: /httponly/i.test(raw), sameSite: "Lax" };
    }),
  );
  // Every <img> load in the page, with when it finished and what it is.
  await ctx.addInitScript(() => {
    window.__img = [];
    document.addEventListener(
      "load",
      (e) => {
        const el = e.target;
        if (!(el instanceof HTMLImageElement)) return;
        const r = el.getBoundingClientRect();
        window.__img.push({
          t: performance.now(),
          avatar: !!el.closest(".avatar"),
          post: !!el.closest(".post-media, .media-grid"),
          visible: r.bottom > 0 && r.top < innerHeight,
          naturalW: el.naturalWidth,
          small: /-sm\.[a-z]+(\?|$)/.test(new URL(el.currentSrc, location.href).pathname + "?"),
          shownW: Math.round(r.width * devicePixelRatio),
        });
      },
      true,
    );
  });
  const net = { hops: [], cached: 0, swDownloads: 0 };
  // Requests made by the service worker (reported by Playwright for Chromium).
  ctx.on("request", (r) => r.serviceWorker() && kind(r.url()) === "r2" && net.swDownloads++);
  const p = { ctx, net, reset: () => ((net.hops = []), (net.cached = 0), (net.swDownloads = 0)) };
  /** A tab with throttling and request tracking; a new one has no in-memory image cache. */
  p.newTab = async () => {
    const page = await ctx.newPage();
    page.setDefaultTimeout(60000);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Network.enable");
    if (profile) {
      await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: profile.latency, downloadThroughput: profile.down, uploadThroughput: profile.up });
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpu });
    }
    const open = new Map();
    cdp.on("Network.requestWillBeSent", (e) => {
      const k = kind(e.request.url);
      const prev = open.get(e.requestId);
      // A redirect ends the previous hop of the same request.
      if (prev && e.redirectResponse) net.hops.push({ kind: prev.kind, ms: (e.timestamp - prev.t) * 1000, bytes: 0, status: e.redirectResponse.status });
      if (k !== "other") open.set(e.requestId, { kind: k, t: e.timestamp });
      else open.delete(e.requestId);
    });
    cdp.on("Network.requestServedFromCache", (e) => open.has(e.requestId) && net.cached++);
    cdp.on("Network.responseReceived", (e) => {
      const o = open.get(e.requestId);
      if (o) o.status = e.response.status;
      if (o && e.response.fromDiskCache) o.disk = true;
      if (o && e.response.fromServiceWorker) o.sw = true;
    });
    cdp.on("Network.loadingFinished", (e) => {
      const o = open.get(e.requestId);
      if (!o) return;
      open.delete(e.requestId);
      if (o.disk) return void net.cached++;
      net.hops.push({ kind: o.kind, ms: (e.timestamp - o.t) * 1000, bytes: e.encodedDataLength, status: o.status, sw: !!o.sw });
    });
    p.page = page;
    p.cdp = cdp;
  };
  await p.newTab();
  return p;
}

const summary = (net) => {
  const by = {};
  for (const h of net.hops) {
    by[h.kind] ??= { n: 0, kb: 0, ms: [] };
    by[h.kind].n++;
    by[h.kind].kb += h.bytes / 1024;
    by[h.kind].ms.push(h.ms);
  }
  const out = {};
  for (const [k, v] of Object.entries(by)) out[k] = { n: v.n, kb: Math.round(v.kb), p50: pct(v.ms, 50), p95: pct(v.ms, 95) };
  // Answered by the app's photo cache (service worker) rather than the network.
  const fromApp = net.hops.filter((h) => h.sw && h.kind === "r2").length;
  // Photos the service worker itself had to download (a cache miss, or a link it may not reuse).
  return { ...out, servedFromCache: net.cached, photosFromAppCache: Math.max(0, fromApp - net.swDownloads), swDownloads: net.swDownloads };
};

/** Image timings since this page's navigation, read in the page. */
async function images(page) {
  const list = await page.evaluate(() => window.__img ?? []);
  const posts = list.filter((i) => i.post);
  const firstPost = posts[0]?.t ?? null;
  const visiblePosts = posts.filter((i) => i.visible);
  return {
    firstPostImageMs: firstPost && Math.round(firstPost),
    lastVisiblePostImageMs: visiblePosts.length ? Math.round(Math.max(...visiblePosts.map((i) => i.t))) : null,
    postImages: posts.length,
    smallCopies: posts.filter((i) => i.small).length,
    avatars: list.filter((i) => i.avatar).length,
    // How much larger than its displayed size each post image was (1 = exact).
    oversize: pct(posts.filter((i) => i.shownW > 0).map((i) => (i.naturalW / i.shownW) * 100), 50) / 100,
  };
}

async function acceptLegal(page) {
  const agree = page.getByRole("button", { name: "I agree" });
  await agree.waitFor({ timeout: 30000 }).catch(() => undefined);
  if (await agree.isVisible().catch(() => false)) await agree.click();
}

const tag = randomBytes(4).toString("hex");
const people = [];
try {
  const A = await account(tag, "a");
  people.push(A);
  const B = await account(tag, "b");
  people.push(B);

  // ------------------------------------------------ A posts photos through the app
  {
    const p = await phone(A, null);
    await p.page.goto(BASE, { waitUntil: "load" });
    await acceptLegal(p.page);
    await p.page.locator(".bottom-create").waitFor();
    // A camera-like photo: 3000×2000 with fine detail, as a high-quality JPEG (~1.5–3 MB).
    const make = (seed) =>
      p.page.evaluate(async (s) => {
        const c = document.createElement("canvas");
        c.width = 3000;
        c.height = 2000;
        const g = c.getContext("2d");
        const grad = g.createLinearGradient(0, 0, 3000, 2000);
        grad.addColorStop(0, `hsl(${s * 70},70%,55%)`);
        grad.addColorStop(1, `hsl(${s * 70 + 120},60%,35%)`);
        g.fillStyle = grad;
        g.fillRect(0, 0, 3000, 2000);
        const img = g.getImageData(0, 0, 3000, 2000);
        let x = s * 9301 + 49297;
        for (let i = 0; i < img.data.length; i += 4) {
          x = (x * 1103515245 + 12345) & 0x7fffffff;
          const n = (x % 48) - 24;
          img.data[i] += n;
          img.data[i + 1] += n;
          img.data[i + 2] += n;
        }
        g.putImageData(img, 0, 0);
        const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.92));
        return Array.from(new Uint8Array(await blob.arrayBuffer()));
      }, seed);
    const sizes = [];
    for (let i = 1; i <= 4; i++) {
      const photo = Buffer.from(await make(i));
      sizes.push(Math.round(photo.length / 1024));
      await p.page.locator(".bottom-create").click();
      const dialog = p.page.getByRole("dialog");
      await dialog.locator("textarea").first().fill(`Media perf ${tag} #${i}`);
      await dialog.locator('input[type="file"]').setInputFiles({ name: `p${i}.jpg`, mimeType: "image/jpeg", buffer: photo });
      await dialog.locator(".media-tile img, .composer img").first().waitFor({ timeout: 30000 }).catch(() => undefined);
      p.reset();
      const t0 = Date.now();
      await dialog.getByRole("button", { name: "Post", exact: true }).first().click();
      // Posted = the post shows its uploaded image (not the local preview of the composer).
      await p.page.waitForFunction(
        (t) => [...document.querySelectorAll("main article")].some((a) => a.textContent.includes(t) && [...a.querySelectorAll(".post-media img")].some((img) => img.complete && img.naturalWidth > 0 && !img.currentSrc.startsWith("blob:"))),
        `Media perf ${tag} #${i}`,
        { timeout: 120000, polling: 100 },
      );
      results.upload[`#${i}`] = { pickedKb: sizes[i - 1], postedMs: Date.now() - t0 };
      await sleep(500);
    }
    await p.ctx.close();
  }
  // B accepts the legal documents once.
  {
    const p = await phone(B, null);
    await p.page.goto(BASE, { waitUntil: "load" });
    await acceptLegal(p.page);
    await p.page.locator(".bottom-create").waitFor();
    await p.ctx.close();
  }
  const handle = await (async () => {
    const token = await tokenOf(A);
    const r = await fetch(`${BASE}/neon/rest/v1/profiles?id=eq.${A.id}&select=username`, { headers: { ...BYPASS, authorization: `Bearer ${token}` } });
    return (await r.json())[0]?.username;
  })();

  // ------------------------------------------------ B views, per network profile
  for (const [name, profile] of Object.entries(PROFILES)) {
    const out = {};
    const p = await phone(B, profile);
    const settle = name === "ng-3g" ? 25000 : 12000;
    // Cold: empty browser cache.
    await p.page.goto(BASE, { waitUntil: "commit" });
    await p.page.locator(".post-media img").first().waitFor({ timeout: 90000 }).catch(() => results.failures.push(`${name}: no feed image (cold)`));
    await sleep(settle);
    out.cold = { ...(await images(p.page)), network: summary(p.net) };
    // Reload: what the browser kept.
    p.reset();
    await p.page.reload({ waitUntil: "commit" });
    await p.page.locator(".post-media img").first().waitFor({ timeout: 90000 }).catch(() => results.failures.push(`${name}: no feed image (reload)`));
    await sleep(settle / 2);
    out.reload = { ...(await images(p.page)), network: summary(p.net) };
    // A later visit: the browser's own cache is gone (links rotate every 30 minutes,
    // and iOS evicts it), so only the app's photo cache can avoid re-downloading.
    p.reset();
    await p.cdp.send("Network.clearBrowserCache");
    const before = p.page;
    await p.newTab();
    await before.close();
    p.reset();
    await p.page.goto(BASE, { waitUntil: "commit" });
    await p.page.locator(".post-media img").first().waitFor({ timeout: 90000 }).catch(() => results.failures.push(`${name}: no feed image (returning)`));
    await sleep(settle / 2);
    out.returning = { ...(await images(p.page)), network: summary(p.net) };
    out.cacheEntries = await p.page.evaluate(async () => ((await caches.has("amigo-media-v1")) ? (await (await caches.open("amigo-media-v1")).keys()).length : 0));
    // The viewer: the feed copy at once, the full photo only now.
    p.reset();
    const tv = Date.now();
    await p.page.locator(".media-tile__open").first().click();
    const smallMs = await p.page.locator(".media-viewer__img--small, .media-viewer__img.is-loaded").first().waitFor({ timeout: 60000 }).then(() => Date.now() - tv, () => null);
    const fullMs = await p.page.locator(".media-viewer__img.is-loaded").first().waitFor({ timeout: 90000 }).then(() => Date.now() - tv, () => null);
    out.viewer = { firstPictureMs: smallMs, fullPhotoMs: fullMs, network: summary(p.net) };
    await p.page.keyboard.press("Escape");
    await sleep(500);
    // Scroll through the feed and back to the top.
    p.reset();
    for (let i = 0; i < 6; i++) {
      await p.page.mouse.wheel(0, 900);
      await sleep(700);
    }
    await sleep(settle / 2);
    const scrolled = summary(p.net);
    p.reset();
    await p.page.evaluate(() => scrollTo(0, 0));
    await sleep(3000);
    out.scroll = { down: scrolled, backToTop: summary(p.net) };
    // Visit A's profile (media grid) and come back to Home, in the app.
    if (handle) {
      p.reset();
      await p.page.evaluate((h) => {
        history.pushState({}, "", `/u/${h}`);
        dispatchEvent(new PopStateEvent("popstate"));
      }, handle);
      await p.page.locator("main img").first().waitFor({ timeout: 60000 }).catch(() => undefined);
      await sleep(settle / 2);
      const profileNet = summary(p.net);
      p.reset();
      await p.page.goBack();
      await sleep(3000);
      out.profileVisit = { profile: profileNet, backHome: summary(p.net) };
    }
    await p.ctx.close();
    results.profiles[name] = out;
    console.log(`profile ${name}: ${JSON.stringify(out)}`);
  }
  // ------------------------------------------------ signing out empties the photo cache
  {
    const p = await phone(B, null);
    await p.page.goto(BASE, { waitUntil: "load" });
    await p.page.locator(".post-media img").first().waitFor({ timeout: 60000 }).catch(() => undefined);
    await p.page.reload({ waitUntil: "load" });
    await sleep(6000);
    const count = () => p.page.evaluate(async () => ((await caches.has("amigo-media-v1")) ? (await (await caches.open("amigo-media-v1")).keys()).length : 0));
    const before = await count();
    await p.page.goto(`${BASE}/settings`, { waitUntil: "load" });
    await p.page.getByRole("button", { name: /^Sign out/ }).first().click();
    const confirm = p.page.getByRole("dialog").getByRole("button", { name: /^Sign out/ });
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
    await sleep(3000);
    const after = await count();
    results.signOut = { photosCachedBefore: before, photosCachedAfter: after };
    if (!(before > 0 && after === 0)) results.failures.push(`sign-out cache: ${before} -> ${after}`);
    await p.ctx.close();
  }
} catch (e) {
  results.failures.push(String(e.message).split("\n")[0]);
  console.error("error:", results.failures.at(-1));
} finally {
  for (const p of people) {
    const token = await tokenOf(p);
    const d = token
      ? await fetch(`${BASE}/neon/rest/v1/rpc/delete_my_account`, { method: "POST", headers: { ...BYPASS, authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ p_confirm: "DELETE" }) })
      : null;
    console.log(`cleanup: ${d?.ok ? "temporary account deleted" : `NOT deleted (${d?.status ?? "no sign-in"})`}`);
    if (!d?.ok) results.failures.push("cleanup");
  }
  await browser.close();
  writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(`SUMMARY ${JSON.stringify(results)}`);
}
