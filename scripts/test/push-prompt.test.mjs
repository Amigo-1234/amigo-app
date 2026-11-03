/**
 * Home's notification opt-in (src/features/notifications/PushPrompt.tsx), offline:
 *
 *   1. The rules (promptRules.ts), for every push state and browser permission.
 *   2. In the demo app (?demo=push) with the browser's Notification and Push APIs replaced by a
 *      stand-in that counts every native permission request and every subscription:
 *        - the browser is asked only after "Enable notifications" is tapped, never on load;
 *        - granted: one subscription, the prompt goes for good, Settings shows it on;
 *        - a double tap asks once and subscribes once;
 *        - "Maybe later" and close: never asks, never back;
 *        - denied (now or earlier): how to allow it, no second question, "Got it" ends it;
 *        - the browser's question closed unanswered: treated as "maybe later";
 *        - turned off earlier in Settings (permission granted, no subscription): no prompt;
 *        - iPhone in Safari: Home Screen instructions, no button that can't work;
 *        - unsupported browser: nothing;
 *        - a private window refusing push: a clear message, the prompt stays.
 *
 *   node scripts/test/push-prompt.test.mjs
 */
import { createServer } from "vite";
import { createRequire } from "node:module";

const { chromium, devices } = await import("playwright").catch(() => createRequire(import.meta.url)("playwright"));

let failures = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};

const server = await createServer({ mode: "demo", logLevel: "error", server: { host: "127.0.0.1", port: 0, strictPort: false } });
await server.listen();
const BASE = `http://127.0.0.1:${server.httpServer.address().port}`;

// ------------------------------------------------------------ 1. rules
const R = await server.ssrLoadModule("/src/features/notifications/promptRules.ts");
const rules = [
  ["off", "default", false, "ask"],
  ["off", "granted", false, null], // turned off in Settings earlier: don't nag
  ["off", "denied", false, null],
  ["on", "granted", false, null],
  ["denied", "denied", false, "denied"],
  ["ios-home-screen", null, false, "ios"],
  ["unsupported", null, false, null],
  ["not-configured", "default", false, null],
  [null, "default", false, null], // still checking
  ["off", "default", true, null], // dismissed
  ["denied", "denied", true, null],
  ["ios-home-screen", null, true, null],
];
for (const [status, permission, dismissed, want] of rules) {
  ok(`rule: ${status ?? "checking"} / ${permission ?? "no API"}${dismissed ? " / dismissed" : ""} → ${want ?? "nothing"}`, R.promptView(status, permission, dismissed) === want);
}

// ------------------------------------------------------------ 2. in the app
const browser = await chromium.launch();

/** The browser's permission and push service, as this test says. Survives reloads (localStorage). */
function stand_in({ perm, answer, unsupported, failSubscribe }) {
  const store = (k, v) => (v === undefined ? JSON.parse(localStorage.getItem(`__push_${k}`) ?? "null") : localStorage.setItem(`__push_${k}`, JSON.stringify(v)));
  if (store("calls") === null) store("calls", { request: 0, subscribe: 0 });
  const count = (k) => { const c = store("calls"); c[k]++; store("calls", c); };
  // Skip the welcome card so Home goes straight to the prompt.
  localStorage.setItem("amigo.welcome.done.me", "1");
  if (unsupported) {
    delete window.PushManager;
    delete window.Notification;
    return;
  }
  if (store("perm") === null) store("perm", perm);
  class FakeNotification {
    static get permission() { return store("perm"); }
    static async requestPermission() {
      count("request");
      await new Promise((r) => setTimeout(r, 150)); // the browser's dialog takes a moment
      if (answer !== "default") store("perm", answer);
      return answer;
    }
  }
  Object.defineProperty(window, "Notification", { value: FakeNotification, configurable: true, writable: true });
  window.PushManager ??= function PushManager() {};
  const makeSub = () => ({
    endpoint: "https://fcm.googleapis.com/fcm/send/push-prompt-test",
    options: { applicationServerKey: null },
    toJSON() { return { endpoint: this.endpoint, keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) } }; },
    async unsubscribe() { store("sub", false); return true; },
  });
  const pushManager = {
    async getSubscription() { return store("sub") ? makeSub() : null; },
    async subscribe() {
      count("subscribe");
      if (failSubscribe) throw new Error("Registration failed - permission denied");
      store("sub", true);
      return makeSub();
    },
  };
  const reg = { pushManager, scope: "/", active: null, update: async () => {}, addEventListener() {} };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { getRegistration: async () => reg, register: async () => reg, ready: Promise.resolve(reg), controller: null, addEventListener() {}, removeEventListener() {} },
  });
}

async function open(opts = {}, device = { viewport: { width: 430, height: 900 } }) {
  const context = await browser.newContext(device);
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
  await context.addInitScript(stand_in, { perm: "default", answer: "granted", ...opts });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${BASE}/?demo=push`, { waitUntil: "load" });
  await page.waitForTimeout(1500); // feed, then the push check
  return { context, page, errors };
}
const prompt = (page) => page.locator(".push-prompt");
const calls = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("__push_calls")));
const reload = async (page) => {
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(1500);
};

try {
  {
    const { context, page, errors } = await open();
    ok("default permission: the prompt shows with both actions",
      (await prompt(page).count()) === 1 && (await page.getByRole("button", { name: "Enable notifications" }).count()) === 1 && (await page.getByRole("button", { name: "Maybe later" }).count()) === 1);
    ok("…and the browser hasn't been asked yet", (await calls(page)).request === 0);
    await page.getByRole("button", { name: "Enable notifications" }).dblclick();
    await page.waitForTimeout(800);
    const c = await calls(page);
    ok("tap Enable (even twice): the browser is asked once, one subscription", c.request === 1 && c.subscribe === 1, JSON.stringify(c));
    ok("…the prompt goes and says so", (await prompt(page).count()) === 0 && (await page.getByText("Notifications are on for this device").count()) >= 1);
    await reload(page);
    ok("…and doesn't come back", (await prompt(page).count()) === 0 && (await calls(page)).request === 1);
    await page.goto(`${BASE}/settings/notifications?demo=push`, { waitUntil: "load" });
    await page.waitForTimeout(1500);
    ok("Settings shows notifications on for this device", (await page.getByRole("switch", { name: "Push notifications on this device" }).getAttribute("aria-checked")) === "true");
    ok("no page errors", errors.length === 0, errors.join(" | "));
    await context.close();
  }
  {
    const { context, page } = await open();
    await page.getByRole("button", { name: "Maybe later" }).click();
    ok("Maybe later: gone, and the browser never asked", (await prompt(page).count()) === 0 && (await calls(page)).request === 0);
    await reload(page);
    ok("…not back after a reload", (await prompt(page).count()) === 0);
    await context.close();
  }
  {
    const { context, page } = await open();
    await page.getByRole("button", { name: "Close" }).click();
    await reload(page);
    ok("Close works like Maybe later", (await prompt(page).count()) === 0 && (await calls(page)).request === 0);
    await context.close();
  }
  {
    const { context, page } = await open({ answer: "denied" });
    await page.getByRole("button", { name: "Enable notifications" }).click();
    await page.waitForTimeout(600);
    ok("denied: explains how to allow them in the browser's settings", (await prompt(page).textContent()).includes("Allow them in your browser's site settings"));
    ok("…with no button that would ask again", (await page.getByRole("button", { name: "Enable notifications" }).count()) === 0 && (await calls(page)).request === 1);
    await page.getByRole("button", { name: "Got it" }).click();
    await reload(page);
    ok("…Got it ends it", (await prompt(page).count()) === 0 && (await calls(page)).request === 1);
    await context.close();
  }
  {
    const { context, page } = await open({ perm: "denied" });
    ok("blocked earlier: shows the how-to once, without asking", (await prompt(page).textContent())?.includes("Notifications are blocked") && (await calls(page)).request === 0);
    await context.close();
  }
  {
    const { context, page } = await open({ answer: "default" });
    await page.getByRole("button", { name: "Enable notifications" }).click();
    await page.waitForTimeout(600);
    await reload(page);
    ok("the browser's question closed unanswered: treated as maybe later", (await prompt(page).count()) === 0 && (await calls(page)).subscribe === 0);
    await context.close();
  }
  {
    const { context, page } = await open({ perm: "granted" });
    ok("turned off earlier in Settings (granted, no subscription): no prompt", (await prompt(page).count()) === 0);
    await context.close();
  }
  {
    const { context, page } = await open({}, devices["iPhone 13"]);
    const text = (await prompt(page).textContent()) ?? "";
    ok("iPhone in Safari: Home Screen instructions", text.includes("Add to Home Screen"), text.slice(0, 80));
    ok("…without an Enable button that can't work there", (await page.getByRole("button", { name: "Enable notifications" }).count()) === 0);
    await context.close();
  }
  {
    const { context, page } = await open({ unsupported: true });
    ok("unsupported browser: no prompt", (await prompt(page).count()) === 0);
    await context.close();
  }
  {
    const { context, page } = await open({ failSubscribe: true });
    await page.getByRole("button", { name: "Enable notifications" }).click();
    await page.waitForTimeout(600);
    const text = (await prompt(page).textContent()) ?? "";
    ok("a private window refusing push: says so, and the prompt stays", text.includes("Private or incognito windows don't support them"), text.slice(0, 120));
    await context.close();
  }
  {
    // The rest of Home is unaffected in normal demo mode (no push key → no prompt).
    const context = await browser.newContext();
    await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
    const page = await context.newPage();
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    await page.waitForTimeout(1500);
    ok("normal demo (push not set up): no prompt", (await prompt(page).count()) === 0);
    await context.close();
  }
} catch (e) {
  failures++;
  console.log(`FAIL ${e?.stack ?? e}`);
} finally {
  await browser.close();
  await server.close();
}
console.log(failures ? `${failures} FAILURE(S)` : "ALL PUSH PROMPT TESTS PASSED");
process.exit(failures ? 1 : 0);
