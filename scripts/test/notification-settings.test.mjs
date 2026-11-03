/**
 * Settings → Notifications, offline: the app in demo mode (in-memory data, no backend, no
 * accounts) in Chromium, every non-local request refused.
 *
 *   - Settings links to the page; every control is there: banners, sounds, push on this
 *     device (the demo has no push key, so it says it isn't available and nothing subscribes),
 *     what to be pushed about, and the devices list;
 *   - each tile is a switch (role, aria-checked, a visible On/Off) that works by mouse and
 *     keyboard;
 *   - banners and sounds are kept on this device (localStorage, survives a reload);
 *     push choices are saved through the data source (survive leaving and coming back);
 *   - a device can be removed;
 *   - every switch is on screen at 1280×800 without scrolling, and nothing overflows sideways
 *     on a 390-wide phone.
 *
 *   node scripts/test/notification-settings.test.mjs
 */
import { createServer } from "vite";
import { createRequire } from "node:module";

// The project's Playwright if installed (CI: npm i --no-save playwright), else a global one (NODE_PATH).
const { chromium } = await import("playwright").catch(() => createRequire(import.meta.url)("playwright"));

let failures = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};

const server = await createServer({ mode: "demo", logLevel: "error", server: { host: "127.0.0.1", port: 0, strictPort: false } });
await server.listen();
const BASE = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
// Nothing leaves this machine (the demo's avatars and photos are refused, which is fine here).
const outside = [];
await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => {
  if (!/pravatar\.cc|picsum\.photos/.test(route.request().url())) outside.push(route.request().url());
  return route.abort();
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

const tile = (name) => page.getByRole("switch", { name, exact: true });
const checked = async (name) => (await tile(name).getAttribute("aria-checked")) === "true";
const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem("amigo:alerts") ?? "{}"));

try {
  // ---- Settings → the page
  await page.goto(`${BASE}/settings`, { waitUntil: "load" });
  const link = page.getByRole("link", { name: /Notification settings/ });
  ok("Settings links to notification settings", await link.waitFor({ timeout: 30000 }).then(() => true, () => false));
  const settingsSwitches = await page.locator("#set-notifications").locator("..").getByRole("switch").count();
  ok("…and no longer stacks the switches itself", settingsSwitches === 0, String(settingsSwitches));
  await link.click();
  await page.waitForURL(/\/settings\/notifications$/);
  await tile("Worlds").waitFor({ timeout: 10000 });

  // ---- Everything is there
  for (const name of ["Banners", "Sounds", "New messages", "Likes, replies and follows", "Worlds"]) ok(`switch: ${name}`, (await tile(name).count()) === 1);
  ok("the three groups are labelled", (await page.locator("h3").allTextContents()).join(" | ") === "While Amigo is open | Push notifications | Devices that get your notifications");
  const device = (await page.locator(".settings-row__detail").first().textContent()) ?? "";
  ok("push on this device: says it isn't available in the demo (nothing subscribes)", /aren't available/.test(device), device);
  ok("two devices listed", (await page.locator(".settings-devices li").count()) === 2);
  ok("tiles show On/Off in words, not colour only", (await tile("Banners").textContent())?.includes("On"));

  // ---- Every switch on screen at 1280×800
  const offscreen = await page.evaluate(() =>
    [...document.querySelectorAll('[role="switch"]')].filter((e) => e.getBoundingClientRect().bottom > innerHeight).map((e) => e.textContent),
  );
  ok("every switch is visible at 1280×800 without scrolling", offscreen.length === 0, offscreen.join(", "));

  // ---- Banners and sounds: this device, kept across a reload
  await tile("Banners").click();
  ok("Banners turns off", !(await checked("Banners")));
  ok("…and shows Off", (await tile("Banners").textContent())?.includes("Off"));
  await tile("Sounds").focus();
  await page.keyboard.press("Space");
  ok("Sounds turns off from the keyboard", !(await checked("Sounds")));
  ok("…both kept on this device", JSON.stringify(await stored()) === JSON.stringify({ banners: false, sounds: false }), JSON.stringify(await stored()));
  await page.reload({ waitUntil: "load" });
  await tile("Banners").waitFor({ timeout: 10000 });
  ok("…still off after a reload", !(await checked("Banners")) && !(await checked("Sounds")));
  await tile("Banners").click();
  await tile("Sounds").click();
  ok("…and back on", (await checked("Banners")) && (await checked("Sounds")));

  // ---- Push choices: saved through the data source
  await tile("New messages").click();
  ok("New messages turns off", !(await checked("New messages")));
  await page.waitForTimeout(400); // the demo's save delay
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.waitForURL(/\/settings$/);
  await page.getByRole("link", { name: /Notification settings/ }).click();
  await tile("New messages").waitFor({ timeout: 10000 });
  ok("…and is still off after leaving and coming back", !(await checked("New messages")));
  await tile("New messages").click();
  ok("…and back on", await checked("New messages"));

  // ---- Remove a device
  await page.getByRole("button", { name: "Stop notifications on Windows · Chrome" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".settings-devices li").length === 1, null, { timeout: 5000 }).catch(() => undefined);
  ok("a device can be removed", (await page.locator(".settings-devices li").count()) === 1);

  // ---- Phone width
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  ok("nothing overflows sideways on a 390-wide phone", overflow <= 0, `${overflow}px`);
  const narrow = await page.evaluate(() =>
    [...document.querySelectorAll('[role="switch"]')].map((e) => e.getBoundingClientRect()).filter((r) => r.width < 44 || r.height < 44).length,
  );
  ok("every tile is at least 44×44 (a comfortable tap)", narrow === 0, String(narrow));

  ok("nothing was sent outside this machine", outside.length === 0, outside.slice(0, 3).join(", "));
  ok("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (e) {
  failures++;
  console.log(`FAIL ${e?.message ?? e}`);
} finally {
  await browser.close();
  await server.close();
}
console.log(failures ? `${failures} FAILURE(S)` : "ALL NOTIFICATION SETTINGS TESTS PASSED");
process.exit(failures ? 1 : 0);
