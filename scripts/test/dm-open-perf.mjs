/**
 * How long a conversation takes to open, in a real browser (Chromium, Android
 * phone profile) on throttled mobile networks, against a deployed environment.
 *
 * B sends A a thread of messages (some with photos). Then A opens it:
 *   cold      — a fresh page load straight to the conversation (as when tapping a push notification)
 *   in-app    — from the Messages list without a reload
 *   repeat    — the same conversation again, a moment later
 *   new device — a second browser for A that didn't exist when the messages were
 *               sent (like adding Amigo to the iPhone Home Screen): old messages
 *               can't be decrypted there, which must not stall the screen
 * For each: time until the first messages show, until all are shown, until the
 * photos are visible, and the requests made while opening (kinds and counts only).
 *
 * Temporary accounts only; deleted at the end. Prints no secrets or message text.
 *
 *   BASE=… VERCEL_BYPASS=… [PROFILES=ng-4g,ng-3g] [N=30] OUT=dm-open.json node scripts/test/dm-open-perf.mjs
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { chromium, devices } from "playwright";

const { BASE, VERCEL_BYPASS, OUT = "dm-open.json", PROFILES: ONLY = "ng-4g,ng-3g" } = process.env;
const N = Number(process.env.N ?? 30);
const PHOTOS = 3;
if (!BASE || !VERCEL_BYPASS) throw new Error("Set BASE and VERCEL_BYPASS");
const BYPASS = { "x-vercel-protection-bypass": VERCEL_BYPASS };
const ALL = {
  "ng-4g": { latency: 150, down: (4_000_000 / 8) | 0, up: (1_000_000 / 8) | 0, cpu: 4 },
  "ng-3g": { latency: 400, down: (400_000 / 8) | 0, up: (200_000 / 8) | 0, cpu: 4 },
};
const host = new URL(BASE).hostname;
const results = { base: BASE, at: new Date().toISOString(), messages: N, photos: PHOTOS, runs: {} };
let failures = 0;

async function account(tag, who) {
  const email = `amigo-e2e-${tag}-${who}@example.com`;
  const password = randomBytes(18).toString("base64url");
  const res = await fetch(`${BASE}/neon/auth/sign-up/email`, {
    method: "POST",
    headers: { ...BYPASS, origin: BASE, "content-type": "application/json" },
    body: JSON.stringify({ email, password, name: `Open Test ${who.toUpperCase()}` }),
  });
  if (!res.ok) throw new Error(`sign-up ${who}: ${res.status}`);
  return { id: (await res.json()).user.id, email, password, cookies: res.headers.getSetCookie() };
}
async function tokenOf(p) {
  const res = await fetch(`${BASE}/neon/auth/sign-in/email`, {
    method: "POST",
    headers: { ...BYPASS, origin: BASE, "content-type": "application/json" },
    body: JSON.stringify({ email: p.email, password: p.password }),
  });
  if (!res.ok) return null;
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return (await (await fetch(`${BASE}/neon/auth/token`, { headers: { ...BYPASS, origin: BASE, cookie } })).json().catch(() => ({}))).token ?? null;
}
const rpc = async (who, fn, args = {}) =>
  fetch(`${BASE}/neon/rest/v1/rpc/${fn}`, { method: "POST", headers: { ...BYPASS, authorization: `Bearer ${await tokenOf(who)}`, "content-type": "application/json" }, body: JSON.stringify(args) });

const browser = await chromium.launch();
async function phone(who) {
  const ctx = await browser.newContext({ ...devices["Pixel 5"] });
  await ctx.request.get(BASE, { headers: { ...BYPASS, "x-vercel-set-bypass-cookie": "true" }, maxRedirects: 0 }).catch(() => undefined);
  await ctx.addCookies(
    who.cookies.map((raw) => {
      const [pair] = raw.split(";");
      const i = pair.indexOf("=");
      return { name: pair.slice(0, i), value: pair.slice(i + 1), domain: host, path: "/", secure: true, httpOnly: /httponly/i.test(raw), sameSite: "Lax" };
    }),
  );
  const page = await ctx.newPage();
  page.setDefaultTimeout(90000);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  const reqs = [];
  cdp.on("Network.requestWillBeSent", (e) => reqs.push(e.request.url));
  const throttle = async (p) =>
    p
      ? (await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: p.latency, downloadThroughput: p.down, uploadThroughput: p.up }),
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: p.cpu }))
      : (await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }),
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 }));
  return { ctx, page, reqs, throttle };
}
async function enter(p) {
  await p.page.goto(BASE, { waitUntil: "load" });
  const agree = p.page.getByRole("button", { name: "I agree" });
  await agree.waitFor({ timeout: 20000 }).catch(() => undefined);
  if (await agree.isVisible().catch(() => false)) await agree.click();
  await p.page.locator(".bottom-create").waitFor();
}
function kind(url) {
  const u = new URL(url);
  if (u.hostname.endsWith("r2.cloudflarestorage.com")) return "R2 file";
  if (u.hostname !== host) return "external";
  if (u.pathname.startsWith("/neon/rest/v1/rpc/")) return `rpc ${u.pathname.split("/").pop()}`;
  if (u.pathname.startsWith("/neon/rest/v1/")) return `table ${u.pathname.split("/")[4]}`;
  if (u.pathname.startsWith("/neon/auth/")) return "auth";
  if (u.pathname.endsWith(".wasm")) return "crypto wasm";
  if (u.pathname.startsWith("/assets/")) return "asset";
  if (u.pathname.startsWith("/api/")) return u.pathname;
  return "page";
}
const tally = (urls) => urls.reduce((o, u) => ((o[kind(u)] = (o[kind(u)] ?? 0) + 1), o), {});

/** Watches the conversation screen from t0: first messages, all messages, photos, end state. */
async function watchOpen(page, t0, timeoutMs = 90000) {
  const expected = results.stored ?? N;
  const photos = results.photosSent ?? PHOTOS;
  return page.evaluate(
    ({ N, PHOTOS, timeoutMs, t0 }) =>
      new Promise((resolve) => {
        const out = { firstMs: null, allMs: null, photosMs: null, skeletonMs: null, shown: 0, undecryptable: 0, photosShown: 0, end: "timeout" };
        const start = performance.timeOrigin + performance.now() - (Date.now() - t0);
        const now = () => Math.round(performance.timeOrigin + performance.now() - start);
        const tick = () => {
          const busy = document.querySelector(".convo__scroll[aria-busy='true']");
          const msgs = document.querySelectorAll(".msgs .msg:not(.msg--typing)");
          const undec = [...msgs].filter((m) => m.querySelector(".msg__text--muted")).length;
          const imgs = [...document.querySelectorAll(".msg__image img")].filter((i) => i.complete && i.naturalWidth > 0).length;
          const err = document.querySelector(".convo [role='alert'], .state-msg--error");
          if (busy && out.skeletonMs === null) out.skeletonMs = 0;
          if (!busy && out.skeletonMs === 0) out.skeletonMs = now();
          if (msgs.length && out.firstMs === null) out.firstMs = now();
          if (msgs.length >= N && out.allMs === null) out.allMs = now();
          if (imgs >= PHOTOS && out.photosMs === null) out.photosMs = now();
          if (PHOTOS === 0) out.photosMs = 0;
          Object.assign(out, { shown: msgs.length, undecryptable: undec, photosShown: imgs });
          const doneOk = out.allMs !== null && (out.photosMs !== null || undec >= PHOTOS);
          if (doneOk || err || now() > timeoutMs) {
            out.end = doneOk ? "content" : err ? "error" : "timeout";
            return resolve(out);
          }
          setTimeout(tick, 50);
        };
        tick();
      }),
    { N: expected, PHOTOS: photos, timeoutMs, t0 },
  );
}

const tag = randomBytes(4).toString("hex");
const people = [];
let step = "accounts";
try {
  const A = await account(tag, "a");
  people.push(A);
  const B = await account(tag, "b");
  people.push(B);

  step = "set up both devices";
  const a1 = await phone(A);
  const b = await phone(B);
  for (const x of [a1, b]) {
    await enter(x);
    await x.page.goto(`${BASE}/messages`, { waitUntil: "load" });
    await x.page.waitForTimeout(6000);
  }
  const conv = await (await rpc(B, "dm_open", { p_peer: A.id })).json();

  step = "B sends the thread";
  await b.page.goto(`${BASE}/messages/${conv}`, { waitUntil: "load" });
  const input = b.page.locator("#msg-input:not([disabled])");
  // A real image (a piece of the screen), as a phone would attach.
  const png = await b.page.screenshot({ clip: { x: 0, y: 0, width: 320, height: 240 } });
  await input.waitFor({ timeout: 60000 });
  for (let i = 0; i < N; i++) {
    if (i % Math.floor(N / PHOTOS) === 0 && i / Math.floor(N / PHOTOS) < PHOTOS) {
      await b.page.locator('form[aria-label="Write a message"] input[type="file"]').setInputFiles({ name: `p${i}.png`, mimeType: "image/png", buffer: png });
      await b.page.waitForTimeout(700);
    }
    await input.fill(`thread message ${i + 1}`);
    await b.page.getByRole("button", { name: "Send", exact: true }).click();
    await b.page.locator(".msg--mine", { hasText: `thread message ${i + 1}` }).first().waitFor();
  }
  // Wait until nothing is still on its way, then record what actually got stored.
  await b.page.waitForFunction(() => !document.querySelector(".msg.is-pending:not(.is-failed)"), null, { timeout: 120000 }).catch(() => undefined);
  results.senderFailed = await b.page.locator(".msg.is-failed").count();
  results.photosSent = await b.page.locator(".msg--mine:not(.is-pending) .msg__image img").count();
  results.senderToasts = await b.page.locator(".toast").allInnerTexts().catch(() => []);
  const thread = await (await rpc(A, "dm_thread", { p_conversation: conv, p_after: null, p_limit: 100 })).json().catch(() => null);
  results.stored = Array.isArray(thread?.messages) ? thread.messages.filter((m) => !m.relates_to).length : null;
  console.log(`info stored ${results.stored} of ${N} (failed on the sender's screen: ${results.senderFailed}) ${JSON.stringify(results.senderToasts)}`);
  await b.ctx.close();

  const a2 = await phone(A); // a device that didn't exist when the messages were sent
  await enter(a2);

  for (const name of ONLY.split(",")) {
    const prof = ALL[name];
    const run = {};
    step = `${name}: cold open`;
    await a1.throttle(prof);
    a1.reqs.length = 0;
    let t0 = Date.now();
    await a1.page.goto(`${BASE}/messages/${conv}`, { waitUntil: "commit" });
    run.cold = await watchOpen(a1.page, t0);
    run.cold.requests = tally(a1.reqs);

    step = `${name}: in-app open`;
    await a1.page.goto(`${BASE}/messages`, { waitUntil: "load" });
    await a1.page.locator(".convo-list a, .conversation-list a, a[href^='/messages/']").first().waitFor({ timeout: 60000 }).catch(() => undefined);
    await a1.page.waitForTimeout(1500);
    a1.reqs.length = 0;
    t0 = Date.now();
    await a1.page.evaluate((p) => {
      history.pushState({}, "", p);
      dispatchEvent(new PopStateEvent("popstate"));
    }, `/messages/${conv}`);
    run.inApp = await watchOpen(a1.page, t0);
    run.inApp.requests = tally(a1.reqs);

    step = `${name}: repeat open`;
    await a1.page.evaluate(() => {
      history.pushState({}, "", "/messages");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await a1.page.waitForTimeout(1500);
    t0 = Date.now();
    await a1.page.evaluate((p) => {
      history.pushState({}, "", p);
      dispatchEvent(new PopStateEvent("popstate"));
    }, `/messages/${conv}`);
    run.repeat = await watchOpen(a1.page, t0);

    step = `${name}: new device`;
    await a2.throttle(prof);
    a2.reqs.length = 0;
    t0 = Date.now();
    await a2.page.goto(`${BASE}/messages/${conv}`, { waitUntil: "commit" });
    run.newDevice = await watchOpen(a2.page, t0);
    run.newDevice.requests = tally(a2.reqs);

    for (const [k, v] of Object.entries(run)) if (v.end !== "content" && !(k === "newDevice" && v.end !== "timeout")) failures++;
    results.runs[name] = run;
    console.log(`${name}:`, JSON.stringify(run));
    await a1.throttle(null);
    await a2.throttle(null);
  }
} catch (e) {
  failures++;
  console.log(`FAIL at "${step}": ${String(e.message).split("\n")[0]}`);
} finally {
  await browser.close();
  for (const p of people) {
    const token = await tokenOf(p);
    const d = token
      ? await fetch(`${BASE}/neon/rest/v1/rpc/delete_my_account`, { method: "POST", headers: { ...BYPASS, authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ p_confirm: "DELETE" }) })
      : null;
    console.log(`cleanup: ${d?.ok ? "temporary account deleted" : `NOT deleted (${d?.status ?? "no sign-in"})`}`);
  }
  writeFileSync(OUT, JSON.stringify(results, null, 2));
}
console.log(failures ? `${failures} OPEN(S) DID NOT RESOLVE` : "ALL OPENS RESOLVED");
process.exit(0);
