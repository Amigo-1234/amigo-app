/**
 * First-visit tour in the demo app (?demo&tour), offline: starts on Home, walks every step on a
 * phone and a desktop (each bubble fully on screen, highlight on the right control), Back works,
 * the last step opens the composer, and it never shows again; Skip and Esc end it for good.
 *
 *   node scripts/test/tour.test.mjs [screenshots-dir]
 */
import { createServer } from "vite";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";

const { chromium, devices } = await import("playwright").catch(() => createRequire(import.meta.url)("playwright"));
const SHOTS = process.argv[2];
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
let failures = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};

const server = await createServer({ mode: "demo", logLevel: "error", server: { host: "127.0.0.1", port: 0, strictPort: false } });
await server.listen();
const BASE = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch();

async function open(device, query = "demo=reset&tour") {
  const context = await browser.newContext(device);
  await context.addInitScript(() => localStorage.setItem("amigo.welcome.done.me", "1"));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/?${query}`, { waitUntil: "load" });
  await page.waitForTimeout(2800);
  return { context, page, errors };
}
const bubble = (page) => page.locator(".tour__bubble");
const title = (page) => page.locator(".tour__title").innerText();
const onScreen = async (page) => {
  const b = await bubble(page).boundingBox();
  const vp = page.viewportSize();
  return !!b && b.x >= 0 && b.y >= 0 && b.x + b.width <= vp.width + 1 && b.y + b.height <= vp.height + 1;
};

try {
  for (const [name, device] of [["phone", devices["iPhone 13"]], ["desktop", { viewport: { width: 1280, height: 820 } }]]) {
    const { context, page, errors } = await open(device);
    ok(`${name}: the tour starts on Home`, (await bubble(page).count()) === 1);
    ok(`${name}: it opens with a welcome`, /Welcome to Amigo World/.test(await title(page)));
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}-00.png` });
    const seen = [];
    for (let i = 0; i < 12; i++) {
      const t = await title(page);
      seen.push(t);
      ok(`${name}: "${t}" bubble fully on screen`, await onScreen(page));
      if (t === "You're all set!") break;
      await page.locator(".tour__bubble [data-primary]").click();
      await page.waitForTimeout(500);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}-${String(i + 1).padStart(2, "0")}.png` });
      const hole = await page.locator(".tour__hole").boundingBox().catch(() => null);
      const now = await title(page);
      if (now !== "You're all set!") ok(`${name}: "${now}" highlights something`, !!hole && hole.width > 20, JSON.stringify(hole));
    }
    ok(`${name}: covers the main places`, ["Home", "Explore", "Create a post", "Messages", "Notifications", "Your profile"].every((s) => seen.includes(s)), seen.join(" → "));
    ok(`${name}: Worlds or Market, whichever is on screen`, seen.includes("Worlds") || seen.includes("Market"));
    await page.locator(".tour__bubble [data-primary]").click();
    await page.waitForTimeout(600);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}-zz-after.png` });
    ok(`${name}: the last step opens the composer`, await page.evaluate(() => !!document.querySelector("dialog[open]")), await page.evaluate(() => document.body.innerText.slice(0, 80)));
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(2800);
    ok(`${name}: never again after finishing`, (await bubble(page).count()) === 0);
    ok(`${name}: no page errors`, errors.length === 0, errors.join(" | "));
    await context.close();
  }

  // Back, Skip and Esc
  {
    const { context, page } = await open({ viewport: { width: 1280, height: 820 } });
    await page.locator(".tour__bubble [data-primary]").click();
    await page.locator(".tour__bubble [data-primary]").click();
    await page.waitForTimeout(300);
    const second = await title(page);
    await bubble(page).getByRole("button", { name: "Back" }).click();
    await page.waitForTimeout(300);
    ok("Back returns to the previous step", (await title(page)) === "Home" && second === "Explore", `${second} → ${await title(page)}`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    ok("Esc ends the tour", (await bubble(page).count()) === 0);
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(2800);
    ok("…and it stays ended", (await bubble(page).count()) === 0);
    await context.close();
  }
  {
    const { context, page } = await open(devices["iPhone 13"]);
    await bubble(page).getByRole("button", { name: "Skip tour" }).click();
    await page.waitForTimeout(300);
    ok("Skip tour ends it", (await bubble(page).count()) === 0);
    await context.close();
  }
  {
    const { context, page } = await open({ viewport: { width: 1280, height: 820 } }, "demo=reset");
    ok("plain demo (tests, UI work): no tour", (await bubble(page).count()) === 0);
    await context.close();
  }
} catch (e) {
  ok("ran to the end", false, String(e).slice(0, 300));
} finally {
  await browser.close();
  await server.close();
  console.log(failures ? `\n${failures} FAILED` : "\nALL TOUR TESTS PASSED");
  process.exit(failures ? 1 : 0);
}
