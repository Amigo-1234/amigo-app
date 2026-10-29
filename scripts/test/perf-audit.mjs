/**
 * Performance audit of the deployed app in a real browser (Chromium, Android
 * phone profile), under network and CPU conditions like ordinary phones on
 * Nigerian mobile networks. Read-mostly: two temporary accounts are created,
 * send a few messages to each other, and are deleted at the end.
 *
 *   BASE=https://… VERCEL_BYPASS=… OUT=perf.json node scripts/test/perf-audit.mjs
 *
 * Prints no secrets (no tokens, cookies or signed URLs).
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { chromium, devices } from "playwright";

const { BASE, VERCEL_BYPASS, OUT = "perf.json", PROFILES: ONLY } = process.env;
if (!BASE || !VERCEL_BYPASS) throw new Error("Set BASE and VERCEL_BYPASS");
const BYPASS = { "x-vercel-protection-bypass": VERCEL_BYPASS };

// Throughput in bytes/second. "ng-4g": a typical Lagos 4G connection; "ng-3g": a weak
// 3G/congested connection (Chrome's "Slow 3G" numbers). CPU slow-down ≈ an ordinary Android phone.
const ALL_PROFILES = {
  fast: { latency: 0, down: -1, up: -1, cpu: 1 },
  "ng-4g": { latency: 150, down: (4_000_000 / 8) | 0, up: (1_000_000 / 8) | 0, cpu: 4 },
  "ng-3g": { latency: 400, down: (400_000 / 8) | 0, up: (200_000 / 8) | 0, cpu: 4 },
};
const PROFILES = ONLY ? Object.fromEntries(ONLY.split(",").map((k) => [k, ALL_PROFILES[k]])) : ALL_PROFILES;
const PHONE = devices["Pixel 5"];
const results = { base: BASE, at: new Date().toISOString(), profiles: {}, idle: {}, messaging: {}, api: {} };

const ms = (x) => Math.round(x);
const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : null;
};

// ------------------------------------------------------------------ accounts

async function account(tag, who) {
  const email = `amigo-e2e-${tag}-${who}@example.com`;
  const password = randomBytes(18).toString("base64url");
  const res = await fetch(`${BASE}/neon/auth/sign-up/email`, {
    method: "POST",
    headers: { ...BYPASS, origin: BASE, "content-type": "application/json" },
    body: JSON.stringify({ email, password, name: `Perf Test ${who.toUpperCase()}` }),
  });
  if (!res.ok) throw new Error(`sign-up ${who}: ${res.status}`);
  const body = await res.json();
  const cookies = res.headers.getSetCookie();
  const cookie = cookies.map((c) => c.split(";")[0]).join("; ");
  const { token } = await (await fetch(`${BASE}/neon/auth/token`, { headers: { ...BYPASS, origin: BASE, cookie } })).json();
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
}
const rpc = (who, fn, args = {}) =>
  fetch(`${BASE}/neon/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { ...BYPASS, authorization: `Bearer ${who.token}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });

// ------------------------------------------------------------------ browser helpers

const browser = await chromium.launch();
const host = new URL(BASE).hostname;

async function phone(who, profile) {
  const ctx = await browser.newContext({ ...PHONE });
  await ctx.request.get(BASE, { headers: { ...BYPASS, "x-vercel-set-bypass-cookie": "true" }, maxRedirects: 0 }).catch(() => undefined);
  if (who)
    await ctx.addCookies(
      who.cookies.map((raw) => {
        const [pair] = raw.split(";");
        const i = pair.indexOf("=");
        return { name: pair.slice(0, i), value: pair.slice(i + 1), domain: host, path: "/", secure: true, httpOnly: /httponly/i.test(raw), sameSite: "Lax" };
      }),
    );
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  if (profile) {
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: profile.latency, downloadThroughput: profile.down, uploadThroughput: profile.up });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpu });
  }
  // Bytes on the wire, per request, from the browser itself.
  const net = { requests: [], bytes: 0 };
  const urls = new Map();
  cdp.on("Network.requestWillBeSent", (e) => urls.set(e.requestId, { url: e.request.url, method: e.request.method, t: e.timestamp }));
  cdp.on("Network.loadingFinished", (e) => {
    const r = urls.get(e.requestId);
    if (!r) return;
    net.bytes += e.encodedDataLength;
    net.requests.push({ ...r, bytes: e.encodedDataLength, end: e.timestamp });
  });
  return { ctx, page, cdp, net, reset: () => ((net.requests = []), (net.bytes = 0)) };
}

/** Where a request goes, without ids, keys or query values. */
function kind(url) {
  const u = new URL(url);
  if (u.hostname.endsWith("r2.cloudflarestorage.com")) return "R2 file";
  if (u.hostname !== host) return `external ${u.hostname}`;
  if (u.pathname.startsWith("/neon/rest/v1/rpc/")) return `rpc ${u.pathname.split("/").pop()}`;
  if (u.pathname.startsWith("/neon/rest/v1/")) return `table ${u.pathname.split("/")[4]}`;
  if (u.pathname.startsWith("/neon/auth/")) return `auth ${u.pathname.slice(11)}`;
  if (u.pathname.startsWith("/api/media/")) return "media read";
  if (u.pathname === "/api/media-sign") return "media sign";
  if (u.pathname.startsWith("/api/")) return u.pathname;
  if (u.pathname.endsWith(".wasm")) return "crypto wasm";
  if (u.pathname.startsWith("/assets/")) return `asset .${u.pathname.split(".").pop()}`;
  return "page";
}
const summarize = (reqs) => {
  const by = {};
  for (const r of reqs) {
    const k = kind(r.url);
    by[k] ??= { n: 0, kb: 0 };
    by[k].n++;
    by[k].kb += r.bytes / 1024;
  }
  for (const k of Object.keys(by)) by[k].kb = Math.round(by[k].kb);
  return by;
};

/** Waits until the main area shows real content (no skeletons/loaders). */
async function contentReady(page, timeout = 60000) {
  await page.waitForFunction(
    () => {
      const main = document.querySelector("main") ?? document.body;
      if (main.querySelector(".skeleton, .loader, [aria-busy='true']")) return false;
      return (main.innerText ?? "").trim().length > 30;
    },
    null,
    { timeout, polling: 50 },
  );
}
const paintMetrics = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const nav = performance.getEntriesByType("navigation")[0];
        const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null;
        let lcp = null;
        try {
          new PerformanceObserver((l) => {
            for (const e of l.getEntries()) lcp = e.startTime;
          }).observe({ type: "largest-contentful-paint", buffered: true });
        } catch {
          /* unsupported */
        }
        setTimeout(() => resolve({ ttfb: nav?.responseStart ?? null, dcl: nav?.domContentLoadedEventEnd ?? null, fcp, lcp }), 300);
      }),
  );
async function acceptLegal(page) {
  const agree = page.getByRole("button", { name: "I agree" });
  await agree.waitFor({ timeout: 30000 }).catch(() => undefined);
  if (await agree.isVisible().catch(() => false)) await agree.click();
}
/** In-app navigation, as when tapping a link (no page reload). */
async function navigate(page, path) {
  const before = await page.evaluate(() => (document.querySelector("main")?.innerText ?? "").slice(0, 400));
  const t0 = Date.now();
  await page.evaluate((p) => {
    history.pushState({}, "", p);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
  // The new screen's own content: different from the previous screen, no skeletons/loaders.
  await page.waitForFunction(
    (prev) => {
      const main = document.querySelector("main");
      if (!main || main.querySelector(".skeleton, .loader, [aria-busy='true']")) return false;
      const text = (main.innerText ?? "").trim();
      return text.length > 30 && text.slice(0, 400) !== prev;
    },
    before,
    { timeout: 60000, polling: 20 },
  );
  return Date.now() - t0;
}

// ------------------------------------------------------------------ run

const tag = randomBytes(4).toString("hex");
const people = [];
const failures = [];
// Where a failure happened, and what the page showed then (for the report).
let step = "accounts";
let shownPage = null;
try {
  const A = await account(tag, "a");
  people.push(A);
  const B = await account(tag, "b");
  people.push(B);
  // Each accepts the legal documents once (as in the app) so measurements see the real home.
  for (const who of [A, B]) {
    const w = await phone(who, null);
    const errs = [];
    w.page.on("console", (m) => m.type() === "error" && errs.push(m.text().slice(0, 200)));
    w.page.on("pageerror", (e) => errs.push(`pageerror ${e.message.slice(0, 200)}`));
    await w.page.goto(BASE, { waitUntil: "load" });
    await acceptLegal(w.page);
    const home = await w.page.locator(".bottom-create").waitFor().then(() => true, () => false);
    if (!home) {
      const text = (await w.page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
      throw new Error(`home not reached after the legal gate: "${text}" errors=${JSON.stringify(errs.slice(-4))}`);
    }
    await w.ctx.close();
  }
  const { handle } = await (await fetch(`${BASE}/neon/rest/v1/profiles?id=eq.${A.id}&select=handle:username`, { headers: { ...BYPASS, authorization: `Bearer ${A.token}` } })).json().then((r) => r[0] ?? {});

  // ---------------- page loads per network profile
  for (const [name, profile] of Object.entries(PROFILES)) {
    const out = {};
    // Signed out, cold.
    {
      step = `${name}: signed-out cold`;
      const p = await phone(null, profile);
      shownPage = p.page;
      const t0 = Date.now();
      await p.page.goto(BASE, { waitUntil: "commit" });
      await p.page.locator('input[type="email"], form').first().waitFor();
      const shown = Date.now() - t0;
      await p.page.waitForLoadState("load");
      out.signedOutCold = { shownMs: shown, ...(await paintMetrics(p.page)), kb: Math.round(p.net.bytes / 1024), requests: p.net.requests.length };
      await p.ctx.close();
    }
    // Signed in, cold (empty cache), then warm (same browser, reload).
    {
      step = `${name}: signed-in cold`;
      const p = await phone(A, profile);
      shownPage = p.page;
      const t0 = Date.now();
      await p.page.goto(BASE, { waitUntil: "commit" });
      await p.page.locator(".bottom-create").waitFor();
      const shell = Date.now() - t0;
      await p.page.locator("main article").first().waitFor();
      const feed = Date.now() - t0;
      const paints = await paintMetrics(p.page);
      await p.page.waitForTimeout(name === "fast" ? 4000 : 10000);
      const wasm = p.net.requests.find((r) => r.url.endsWith(".wasm"));
      out.signedInCold = {
        shellMs: shell,
        feedMs: feed,
        ...paints,
        kbFirst: Math.round(p.net.bytes / 1024),
        requests: p.net.requests.length,
        cryptoWasmKb: wasm ? Math.round(wasm.bytes / 1024) : 0,
        byKind: summarize(p.net.requests),
      };
      p.reset();
      step = `${name}: signed-in warm`;
      const t1 = Date.now();
      await p.page.reload({ waitUntil: "commit" });
      await p.page.locator(".bottom-create").waitFor();
      const shellW = Date.now() - t1;
      await p.page.locator("main article").first().waitFor();
      out.signedInWarm = { shellMs: shellW, feedMs: Date.now() - t1, kb: Math.round(p.net.bytes / 1024), requests: p.net.requests.length };
      // Startup API calls in order: start offset and duration (ms) — sequential chains show up here.
      const page0 = p.net.requests.find((r) => kind(r.url) === "page")?.t ?? p.net.requests[0]?.t ?? 0;
      out.signedInWarm.apiTimeline = p.net.requests
        .filter((r) => /^(rpc|table|auth|media|R2|\/api)/.test(kind(r.url)))
        .sort((a, b) => a.t - b.t)
        .slice(0, 30)
        .map((r) => `${kind(r.url)} @${ms((r.t - page0) * 1000)}+${ms((r.end - r.t) * 1000)}`);

      // In-app navigation between the main sections (first visit, then a revisit).
      const routes = ["/explore", "/notifications", `/u/${handle}`, "/messages", "/worlds", "/support", "/bookmarks", "/settings", "/"];
      out.navigation = {};
      for (const r of routes) {
        try {
          const label = r.startsWith("/u/") ? "/u/<me>" : r;
          out.navigation[label] = { first: await navigate(p.page, r) };
        } catch (e) {
          out.navigation[r] = { error: String(e.message).split("\n")[0] };
        }
      }
      for (const r of ["/explore", "/notifications", `/u/${handle}`, "/messages", "/"]) {
        const label = r.startsWith("/u/") ? "/u/<me>" : r;
        try {
          out.navigation[label].revisit = await navigate(p.page, r);
        } catch (e) {
          out.navigation[label].revisitError = String(e.message).split("\n")[0];
        }
      }
      const metrics = await p.cdp.send("Performance.enable").then(() => p.cdp.send("Performance.getMetrics"));
      out.heapMb = Math.round((metrics.metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0) / 1048576);
      await p.ctx.close();
    }
    results.profiles[name] = out;
    console.log(`profile ${name}:`, JSON.stringify(out));
  }

  // ---------------- background requests while idle (fast network)
  {
    const conv = await (await rpc(A, "dm_open", { p_peer: B.id })).json();
    const p = await phone(A, null);
    await p.page.goto(BASE, { waitUntil: "load" });
    await contentReady(p.page);
    for (const [label, path, seconds] of [
      ["home", "/", 60],
      ["messages list", "/messages", 30],
      ["open conversation", `/messages/${conv}`, 30],
    ]) {
      await navigate(p.page, path).catch(() => undefined);
      await p.page.waitForTimeout(3000);
      p.reset();
      await p.page.waitForTimeout(seconds * 1000);
      const reqs = p.net.requests.filter((r) => !r.url.includes("/assets/"));
      results.idle[label] = { seconds, perMinute: Math.round((reqs.length / seconds) * 60), kbPerMinute: Math.round((p.net.bytes / 1024 / seconds) * 60), byKind: summarize(reqs) };
      console.log(`idle ${label}:`, JSON.stringify(results.idle[label]));
    }
    await p.ctx.close();

    // ---------------- messaging latency: D watches the conversation, C sends.
    // One browser per person for the whole section (a fresh browser is a new,
    // unverified device that must be approved before it can send).
    const C = await account(tag, "c");
    people.push(C);
    const D = await account(tag, "d");
    people.push(D);
    const pc = await phone(C, null);
    const pd = await phone(D, null);
    for (const x of [pc, pd]) {
      await x.page.goto(BASE, { waitUntil: "load" });
      await acceptLegal(x.page);
      await x.page.locator(".bottom-create").waitFor();
      await x.page.goto(`${BASE}/messages`, { waitUntil: "load" });
      await x.page.waitForTimeout(4000);
    }
    const conv2 = await (await rpc(C, "dm_open", { p_peer: D.id })).json();
    for (const name of Object.keys(PROFILES).filter((n) => n !== "ng-3g")) {
      const prof = PROFILES[name];
      for (const x of [pc, pd]) {
        await x.cdp.send("Network.emulateNetworkConditions", { offline: false, latency: prof.latency, downloadThroughput: prof.down, uploadThroughput: prof.up });
        await x.cdp.send("Emulation.setCPUThrottlingRate", { rate: prof.cpu });
      }
      let t0 = Date.now();
      await pc.page.goto(`${BASE}/messages/${conv2}`, { waitUntil: "commit" });
      await pc.page.locator("#msg-input:not([disabled])").waitFor();
      const openMs = Date.now() - t0;
      await pd.page.goto(`${BASE}/messages/${conv2}`, { waitUntil: "commit" });
      await pd.page.locator("#msg-input").waitFor();
      await pd.page.waitForTimeout(3000);
      const delivery = [];
      const sendAck = [];
      for (let i = 0; i < 5; i++) {
        const text = `perf ${name} ${i} ${tag}`;
        await pc.page.locator("#msg-input").fill(text);
        t0 = Date.now();
        await pc.page.getByRole("button", { name: "Send", exact: true }).click();
        await Promise.all([
          pc.page.locator(".msg--mine", { hasText: text }).first().waitFor().then(() => sendAck.push(Date.now() - t0)).catch(() => undefined),
          pd.page.locator(".msg--theirs", { hasText: text }).first().waitFor({ timeout: 60000 }).then(() => delivery.push(Date.now() - t0)).catch(() => failures.push(`message ${i} not delivered on ${name}`)),
        ]);
        await pc.page.waitForTimeout(800);
      }
      t0 = Date.now();
      await pc.page.locator("#msg-input").pressSequentially("typing…", { delay: 40 });
      const typingMs = await pd.page.locator(".msg--typing").first().waitFor({ timeout: 20000 }).then(() => Date.now() - t0).catch(() => null);
      await pc.page.locator("#msg-input").fill("");
      results.messaging[name] = {
        openConversationMs: openMs,
        shownToSenderMs: { p50: pct(sendAck, 50), max: sendAck.length ? Math.max(...sendAck) : null },
        deliveredToPeerMs: { p50: pct(delivery, 50), p95: pct(delivery, 95), samples: delivery },
        typingSeenMs: typingMs,
      };
      console.log(`messaging ${name}:`, JSON.stringify(results.messaging[name]));
    }
    await pc.ctx.close();
    await pd.ctx.close();
  }

  // ---------------- API latency from this runner (where is it served from?)
  {
    const N = 15;
    const time = async (fn) => {
      const t = [];
      let where = "";
      for (let i = 0; i < N; i++) {
        const t0 = performance.now();
        const r = await fn();
        await r.arrayBuffer();
        t.push(performance.now() - t0);
        where = r.headers.get("x-vercel-id")?.split("::").slice(0, -1).join(" → ") ?? where;
      }
      return { p50: ms(pct(t, 50)), p95: ms(pct(t, 95)), first: ms(t[0]), servedVia: where || "direct" };
    };
    const direct = "https://ep-dry-mode-zano9y8g.apirest.c-2.eu-west-2.aws.neon.tech/neondb/rest/v1";
    const auth = { authorization: `Bearer ${A.token}`, "content-type": "application/json" };
    results.api = {
      "rpc unread_notification_count via /neon proxy": await time(() => fetch(`${BASE}/neon/rest/v1/rpc/unread_notification_count`, { method: "POST", headers: { ...BYPASS, ...auth }, body: "{}" })),
      "rpc unread_notification_count direct to Neon": await time(() => fetch(`${direct}/rpc/unread_notification_count`, { method: "POST", headers: auth, body: "{}" })),
      "feed (20 posts) via proxy": await time(() => fetch(`${BASE}/neon/rest/v1/rpc/feed_posts?select=id`, { method: "POST", headers: { ...BYPASS, ...auth }, body: JSON.stringify({ p_scope: "latest", p_limit: 21 }) })),
      "session check /neon/auth/get-session": await time(() => fetch(`${BASE}/neon/auth/get-session`, { headers: { ...BYPASS, origin: BASE, cookie: A.cookies.map((c) => c.split(";")[0]).join("; ") } })),
      "static index.html": await time(() => fetch(`${BASE}/`, { headers: BYPASS })),
    };
    console.log("api:", JSON.stringify(results.api));
  }
} catch (e) {
  // Landmarks only, never page text (production pages show real people's posts).
  const seen = {};
  if (shownPage) {
    seen.path = await shownPage.evaluate(() => location.pathname).catch(() => "?");
    for (const [k, sel] of Object.entries({ shell: ".bottom-create", article: "main article", signIn: 'input[type="email"]', legal: 'button:has-text("I agree")', error: '[role="alert"]' }))
      seen[k] = await shownPage.locator(sel).count().catch(() => -1);
  }
  failures.push(`${step}: ${String(e.message).split("\n")[0]} ${JSON.stringify(seen)}`);
  console.error("error:", String(e.message).split("\n")[0]);
} finally {
  await browser.close();
  for (const p of people) {
    await signInAgain(p);
    const d = await rpc(p, "delete_my_account", { p_confirm: "DELETE" }).catch(() => ({ status: 0 }));
    const done = d.status === 200 || d.status === 204;
    if (!done) failures.push(`cleanup ${p.id}`);
    console.log(`cleanup: temporary account ${done ? "deleted" : `NOT deleted id=${p.id}`}`);
  }
}
results.failures = failures;
writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(`SUMMARY ${JSON.stringify(results)}`);
console.log(failures.length ? `DONE with ${failures.length} problem(s): ${failures.join("; ")}` : "DONE");
