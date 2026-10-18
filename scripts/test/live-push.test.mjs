/**
 * Web Push end to end on a deployed environment, through a real push service:
 * Google Chrome subscribes with Google's push service (Playwright's Chromium
 * has no push keys), the app registers the device, and we check that
 *   1. "Send a test notification" reaches the device's service worker, and
 *   2. a direct message from another account makes the device show
 *      "You have a new message on Amigo." while Amigo isn't open there,
 *      without any message text in the notification.
 * Temporary accounts only; deleted at the end. Prints no secrets.
 *
 *   BASE=… VERCEL_BYPASS=… node scripts/test/live-push.test.mjs
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, devices } from "playwright";

const { BASE, VERCEL_BYPASS } = process.env;
if (!BASE || !VERCEL_BYPASS) throw new Error("Set BASE and VERCEL_BYPASS");
const BYPASS = { "x-vercel-protection-bypass": VERCEL_BYPASS };
const host = new URL(BASE).hostname;
let failures = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function account(tag, who) {
  const email = `amigo-e2e-${tag}-${who}@example.com`;
  const password = randomBytes(18).toString("base64url");
  const res = await fetch(`${BASE}/neon/auth/sign-up/email`, {
    method: "POST",
    headers: { ...BYPASS, origin: BASE, "content-type": "application/json" },
    body: JSON.stringify({ email, password, name: `Push Test ${who.toUpperCase()}` }),
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

async function open(browserType, who, opts = {}) {
  let ctx;
  if (opts.persistent) {
    // A real (non-incognito) profile: Chrome refuses push subscriptions in incognito,
    // and Playwright's ordinary contexts are incognito-like.
    ctx = await browserType.launchPersistentContext(mkdtempSync(join(tmpdir(), "amigo-push-")), { ...(opts.launch ?? {}), ...(opts.context ?? {}) });
    browsers.push({ contexts: () => [ctx], close: () => ctx.close() });
  } else {
    const browser = await browserType.launch(opts.launch ?? {});
    browsers.push(browser);
    ctx = await browser.newContext({ ...(opts.device ?? {}), ...(opts.context ?? {}) });
  }
  await ctx.request.get(BASE, { headers: { ...BYPASS, "x-vercel-set-bypass-cookie": "true" }, maxRedirects: 0 }).catch(() => undefined);
  await ctx.addCookies(
    who.cookies.map((raw) => {
      const [pair] = raw.split(";");
      const i = pair.indexOf("=");
      return { name: pair.slice(0, i), value: pair.slice(i + 1), domain: host, path: "/", secure: true, httpOnly: /httponly/i.test(raw), sameSite: "Lax" };
    }),
  );
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.setDefaultTimeout(45000);
  await page.goto(BASE, { waitUntil: "load" });
  const agree = page.getByRole("button", { name: "I agree" });
  await agree.waitFor({ timeout: 20000 }).catch(() => undefined);
  if (await agree.isVisible().catch(() => false)) await agree.click();
  await page.locator(".bottom-create").waitFor();
  return { ctx, page };
}

/** Notifications the service worker is showing right now (title/body/tag/url only). */
const shown = (page) =>
  page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return (await reg.getNotifications()).map((n) => ({ title: n.title, body: n.body, tag: n.tag, url: n.data?.url ?? null }));
  });

const tag = randomBytes(4).toString("hex");
let step = "start";
const people = [];
const browsers = [];
try {
  const A = await account(tag, "a");
  people.push(A);
  const B = await account(tag, "b");
  people.push(B);

  // B: Google Chrome (registers with Google's push service; Playwright's own
  // Chromium has no push keys and its Firefox build hides PushManager), with
  // notifications allowed as if the person tapped "Allow". Runs headed (xvfb).
  step = "open Chrome signed in as B";
  const b = await open(chromium, B, {
    persistent: true,
    launch: { channel: "chrome", headless: false },
    // Phone-sized, so the app shows its phone layout (as the other live tests use).
    context: { viewport: { width: 390, height: 844 }, permissions: ["notifications"] },
  });
  await b.page.waitForFunction(() => navigator.serviceWorker?.controller || navigator.serviceWorker?.getRegistration(), null, { timeout: 30000 }).catch(() => undefined);
  step = "Settings → notifications row";
  await b.page.goto(`${BASE}/settings`);
  const row = b.page.getByRole("button", { name: /Notifications on this device/ });
  await row.waitFor();
  await b.page.waitForFunction(() => !document.body.innerText.includes("Checking…"), null, { timeout: 30000 }).catch(() => undefined);
  const detail = (await row.innerText()).replace(/\s+/g, " ");
  ok("Settings offers notifications on this device", /Get told about new messages|On\./.test(detail), detail.slice(0, 120));
  const consoleB = [];
  b.page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && consoleB.push(m.text().slice(0, 200)));
  await row.click();
  const on = await b.page.getByText("Notifications are on for this device").waitFor({ timeout: 45000 }).then(() => true, () => false);
  const toasts = await b.page.locator(".toast").allInnerTexts().catch(() => []);
  const why = on ? "" : `row: ${(await row.innerText()).replace(/\s+/g, " ").slice(0, 120)} · toasts: ${JSON.stringify(toasts)} · console: ${JSON.stringify(consoleB.slice(-3))}`;
  ok("turning notifications on registers this device with a real push service", on, why);
  if (!on) throw new Error("push subscription not available in this browser build; stopping");
  const listed = await b.page.locator(".settings-devices li").count();
  ok("the device appears in the device list", listed === 1, String(listed));

  step = "test notification";
  // 1. Test notification through the real push service.
  await b.page.getByRole("button", { name: "Send a test notification" }).click();
  let got = [];
  for (let i = 0; i < 30 && !got.some((n) => n.tag === "test"); i++) {
    await sleep(1000);
    got = await shown(b.page);
  }
  const test = got.find((n) => n.tag === "test");
  ok("test notification delivered to the device (via the browser's push service)", !!test, JSON.stringify(got));
  ok("it says only that notifications work", test?.body === "Notifications are working on this device." && test?.title === "Amigo");
  await b.page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).forEach((n) => n.close()));

  // 2. A message from A while Amigo isn't open on B's device (only the service worker remains).
  const handleB = await (async () => {
    const token = await tokenOf(B);
    const r = await fetch(`${BASE}/neon/rest/v1/profiles?id=eq.${B.id}&select=username`, { headers: { ...BYPASS, authorization: `Bearer ${token}` } });
    return (await r.json())[0]?.username;
  })();
  // B's messaging needs to be set up once (its encryption device); give the app time to do it.
  await b.page.goto(`${BASE}/messages`);
  await sleep(8000);
  await b.page.goto("about:blank");

  step = "A sends a message";
  const a = await open(chromium, A, { device: devices["Pixel 5"] });
  await a.page.goto(`${BASE}/u/${handleB}`);
  await a.page.getByRole("button", { name: /^Message / }).first().click();
  const input = a.page.locator("#msg-input:not([disabled])");
  await input.waitFor({ timeout: 60000 });
  const secretText = `push privacy check ${tag}`;
  await input.fill(secretText);
  await a.page.getByRole("button", { name: "Send", exact: true }).click();
  await a.page.locator(".msg--mine", { hasText: secretText }).first().waitFor();

  // No Amigo page is open on B's device while the push arrives (an open, focused Amigo shows the message itself).
  await sleep(20000);
  const bPage = await b.ctx.newPage();
  await bPage.goto(`${BASE}/offline.html`).catch(() => undefined);
  got = await shown(bPage).catch(() => []);
  const dm = got.find((n) => n.tag?.startsWith("dm-"));
  ok("a new message notifies the recipient's device while Amigo is closed", !!dm, JSON.stringify(got));
  ok("the notification text is generic", dm?.body === "You have a new message on Amigo." && dm?.title === "Amigo");
  ok("no message text or names in the notification", !!dm && !JSON.stringify(dm).includes(secretText) && !/Push Test/.test(JSON.stringify(dm)));
  ok("tapping it opens that conversation", /^\/messages\/[0-9a-f-]{36}$/.test(dm?.url ?? ""), dm?.url ?? "");

  // 3. Activity: A likes B's post → B's device says who liked it (never the post's text).
  step = "activity push";
  await bPage.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).forEach((n) => n.close()));
  // As for the message: no Amigo page open on B's device while the push arrives
  // (an open, focused Amigo shows activity itself instead of a notification).
  await bPage.goto("about:blank");
  const api = async (who, path, body) => {
    const token = await tokenOf(who);
    return fetch(`${BASE}${path}`, { method: "POST", headers: { ...BYPASS, authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  };
  const postText = `push post ${tag}`;
  const created = await (await api(B, "/neon/rest/v1/rpc/create_post", { p_body: postText })).json();
  await api(A, "/neon/rest/v1/rpc/set_post_like", { p_post_id: created.id, p_liked: true });
  // What A's app does right after a like.
  await api(A, "/api/push-notify", { activity: true });
  await sleep(15000);
  await bPage.goto(`${BASE}/offline.html`).catch(() => undefined);
  const act = (await shown(bPage).catch(() => [])).find((n) => n.tag?.startsWith("act-like-")) ?? null;
  ok("a like on your post notifies your device", !!act, JSON.stringify(act));
  ok("…saying who liked it, without the post's text", act?.body === "Push Test A liked your post." && !JSON.stringify(act).includes(postText), act?.body ?? "");
  ok("…and opens that post", act?.url === `/post/${created.id}`, act?.url ?? "");

  // Turning it off removes the device.
  await b.page.goto(`${BASE}/settings`).catch(() => undefined);
  const row2 = b.page.getByRole("button", { name: /Notifications on this device/ });
  await row2.waitFor().catch(() => undefined);
  await b.page.waitForFunction(() => !document.body.innerText.includes("Checking…"), null, { timeout: 30000 }).catch(() => undefined);
  await row2.click().catch(() => undefined);
  const off = await b.page.getByText("Notifications turned off on this device").waitFor({ timeout: 20000 }).then(() => true, () => false);
  ok("turning notifications off unregisters the device", off);
} catch (e) {
  failures++;
  console.log(`FAIL at "${step}": ${String(e.message).split("\n")[0]}`);
  for (const br of browsers)
    for (const c of br.contexts())
      for (const pg of c.pages()) {
        const text = await pg.locator("body").innerText().catch(() => "");
        console.log(`     page ${new URL(pg.url()).pathname}: "${text.replace(/\s+/g, " ").slice(0, 160)}"`);
      }
} finally {
  for (const br of browsers) await br.close().catch(() => undefined);
  for (const p of people) {
    const token = await tokenOf(p);
    const d = token
      ? await fetch(`${BASE}/neon/rest/v1/rpc/delete_my_account`, { method: "POST", headers: { ...BYPASS, authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ p_confirm: "DELETE" }) })
      : null;
    console.log(`cleanup: ${d?.ok ? "temporary account deleted" : `NOT deleted (${d?.status ?? "no sign-in"})`}`);
    if (!d?.ok) failures++;
  }
}
console.log(failures ? `${failures} FAILED` : "ALL LIVE PUSH TESTS PASSED");
process.exit(failures ? 1 : 0);
