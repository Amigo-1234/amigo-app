/**
 * Post view counts in the demo app (src/data/demoSource.ts → demoPostViews), offline:
 *
 *   - off (plain ?demo): no eye under posts, nothing recorded;
 *   - on (?demo=views): other people's posts show an eye and a total; a post on screen for a
 *     second counts once (one added), never again, and your own posts never gain views;
 *   - Admin → Creators: the switch reads on and turns off; on a database without the migration
 *     (?demo=views-missing) it says so and offers no button;
 *   - phone width: the action row doesn't scroll sideways.
 *
 *   node scripts/test/post-views.test.mjs
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
const browser = await chromium.launch();

async function open(query, device = {}) {
  const context = await browser.newContext(device);
  await context.addInitScript(() => localStorage.setItem("amigo.welcome.done.me", "1"));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/?${query}`, { waitUntil: "load" });
  await page.waitForTimeout(1500);
  return { context, page, errors };
}

/** The view label under a post ("341 views"), or null when there's no eye. */
const viewsOf = (page, text) =>
  page.locator("article.post", { hasText: text }).first().locator(".action--views .visually-hidden").textContent({ timeout: 2000 }).catch(() => null);
const num = (s) => (s ? Number(s.replace(/\D/g, "")) : null);

try {
  {
    const { context, page, errors } = await open("demo");
    await page.waitForTimeout(4500);
    ok("off: no eye under posts", (await page.locator(".action--views").count()) === 0);
    ok("off: no page errors", errors.length === 0, errors.join("; "));
    await context.close();
  }

  {
    const { context, page, errors } = await open("demo=views");
    ok("on: posts show an eye", (await page.locator(".action--views").count()) > 0);
    const before = num(await viewsOf(page, "Hot take: the best group chats"));
    ok("on: another person's post shows its total", before !== null && before > 0, String(before));
    // Seen for a second, then sent in the next batch (a few seconds).
    await page.locator("article.post", { hasText: "Hot take: the best group chats" }).first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(5000);
    const after = num(await viewsOf(page, "Hot take: the best group chats"));
    ok("on: seeing it adds one view", after === before + 1, `${before} → ${after}`);
    await page.mouse.wheel(0, 3000);
    await page.waitForTimeout(1500);
    await page.locator("article.post", { hasText: "Hot take: the best group chats" }).first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(5000);
    ok("on: seeing it again adds nothing", num(await viewsOf(page, "Hot take: the best group chats")) === after);
    ok("on: the eye isn't a button", (await page.locator("button.action--views, a.action--views").count()) === 0);
    ok("on: no page errors", errors.length === 0, errors.join("; "));

    // Your own post: write one, look at it, it stays without views.
    await page.keyboard.press("n");
    await page.waitForTimeout(600);
    await page.locator("dialog textarea, [role=dialog] textarea").first().fill("Views test: my own post");
    await page.getByRole("button", { name: /^Post$/ }).last().click();
    await page.waitForTimeout(2500);
    await page.locator("article.post", { hasText: "Views test: my own post" }).first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(5000);
    ok("own post: never gains views", (num(await viewsOf(page, "Views test: my own post")) ?? 0) === 0);

    await page.evaluate(() => {
      history.pushState({ idx: 1 }, "", "/admin/creators" + location.search);
      dispatchEvent(new PopStateEvent("popstate", { state: { idx: 1 } }));
    });
    await page.waitForTimeout(1200);
    const card = page.locator("section", { has: page.getByRole("heading", { name: "Post view counts" }) });
    ok("admin: the switch reads on", (await card.innerText()).includes("On:"));
    await card.getByRole("button", { name: "Turn off" }).click();
    await page.waitForTimeout(600);
    ok("admin: it turns off", (await card.innerText()).includes("Off:"));
    await context.close();
  }

  {
    // A database without the migration: nothing to switch, and posts show no eye.
    const { context, page, errors } = await open("demo=views-missing");
    ok("missing: no eye under posts", (await page.locator(".action--views").count()) === 0);
    await page.evaluate(() => {
      history.pushState({ idx: 1 }, "", "/admin/creators" + location.search);
      dispatchEvent(new PopStateEvent("popstate", { state: { idx: 1 } }));
    });
    await page.waitForTimeout(1200);
    const card = page.locator("section", { has: page.getByRole("heading", { name: "Post view counts" }) });
    ok("missing: the card says it isn't available on this database", (await card.innerText()).includes("Not available on this database"));
    ok("missing: no Turn on button to fail", (await card.getByRole("button").count()) === 0);
    ok("missing: no page errors", errors.length === 0, errors.join("; "));
    await context.close();
  }

  {
    const { context, page } = await open("demo=views", devices["iPhone 13"]);
    await page.waitForTimeout(1500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok("phone: no sideways scrolling with the eye in the action row", overflow <= 0, `${overflow}px`);
    const rowFits = await page.evaluate(() =>
      [...document.querySelectorAll(".post__actions")].every((f) => f.scrollWidth <= f.clientWidth + 1),
    );
    ok("phone: every action row fits", rowFits);
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL POST VIEW TESTS PASSED");
process.exit(failures ? 1 : 0);
