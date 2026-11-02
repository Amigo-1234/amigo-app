/**
 * Marketplace in the demo app (src/data/demoMarketplace.ts), offline:
 *
 *   - off (?demo=business): /market says it isn't open; no Explore link;
 *   - browse (?demo=market): sold listings left out, word search, kind/category/price filters, sort;
 *   - a listing page: price, details, seller; save, and Saved listings;
 *   - selling: no business → told to create one; then a business lists a product (naira → kobo),
 *     changes its status in Manage Business, and it shows on the business page with its badge;
 *   - a business post shares the listing; the card follows the listing (sold, then gone when deleted);
 *   - a restaurant's products are its Menu, grouped by section; About shows hours;
 *   - admin: remove (gone from search), restore (back as a draft), switch off;
 *   - phone width: no sideways scrolling.
 *
 *   node scripts/test/marketplace.test.mjs
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
  await page.waitForTimeout(1200);
  return { context, page, errors };
}

/** In-app navigation (demo data lives in memory, so no reloads). */
async function go(page, path) {
  await page.evaluate((p) => {
    history.pushState({ idx: 1 }, "", p);
    dispatchEvent(new PopStateEvent("popstate", { state: { idx: 1 } }));
  }, path);
  await page.waitForTimeout(900);
}
const text = (page) => page.locator("main").innerText();
const tiles = (page) => page.locator(".mk-tile .mk-tile__title").allInnerTexts();

try {
  // ---------------------------------------------------------------- off
  {
    const { context, page, errors } = await open("demo=business");
    await go(page, "/market");
    ok("off: the Marketplace says it isn't open", (await page.getByText("The Marketplace isn't open yet").count()) === 1);
    await go(page, "/explore");
    ok("off: no Marketplace link on Explore", (await page.getByRole("link", { name: "Marketplace" }).count()) === 0);
    ok("off: no page errors", errors.length === 0, errors.join("; "));
    await context.close();
  }

  // ---------------------------------------------------------------- on
  {
    const { context, page, errors } = await open("demo=market");
    await go(page, "/explore");
    ok("on: Explore links to the Marketplace", (await page.getByRole("link", { name: "Marketplace" }).count()) === 1);
    await go(page, "/market");
    let titles = await tiles(page);
    ok("browse: open listings show; sold ones don't", titles.length === 5 && !titles.includes("Phone case (used)"), titles.join(" | "));
    ok("browse: prices in naira", (await text(page)).includes("₦35,000") && (await text(page)).includes("from ₦60,000"));

    await page.getByPlaceholder("Search products and services").fill("jol");
    await page.waitForTimeout(1200);
    ok("search: words match by prefix", (await tiles(page)).join() === "Party jollof tray (serves 10)");
    await page.getByPlaceholder("Search products and services").fill("");
    await page.waitForTimeout(1000);
    await page.getByRole("button", { name: "Services", exact: true }).click();
    await page.waitForTimeout(900);
    titles = await tiles(page);
    ok("filter: services only", titles.length === 3 && titles.includes("Portrait session") && !titles.includes("Beef suya (large)"), titles.join(" | "));
    await page.getByRole("button", { name: "Repairs & maintenance" }).click();
    await page.waitForTimeout(900);
    ok("filter: category", (await tiles(page)).join() === "iPhone screen replacement");
    await page.getByRole("button", { name: "Everything" }).click();
    await page.waitForTimeout(600);
    await page.getByPlaceholder("Max ₦").fill("30000");
    await page.waitForTimeout(900);
    titles = await tiles(page);
    ok("filter: price up to ₦30,000", titles.length === 2 && titles.includes("Beef suya (large)") && titles.includes("Portrait session"), titles.join(" | "));
    await page.getByPlaceholder("Max ₦").fill("abc");
    await page.waitForTimeout(500);
    ok("filter: a non-number price is explained", (await page.getByText("Prices are numbers in naira").count()) === 1);
    await page.getByPlaceholder("Max ₦").fill("");
    await page.getByLabel("Sort").selectOption("price_desc");
    await page.waitForTimeout(900);
    titles = await tiles(page);
    ok("sort: price high to low", titles[0] === "Event catering" && titles.at(-1) === "Beef suya (large)", titles.join(" | "));

    // Listing page + save
    await go(page, "/l/lst-portrait");
    let body = await text(page);
    ok("listing: price per session, details and the seller", body.includes("₦25,000 / session") && body.includes("Mira Studio") && body.includes("/b/mira_studio") && body.includes("One hour in studio"));
    ok("listing: honest about payments", body.includes("Amigo doesn't handle payments"));
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForTimeout(500);
    ok("save: the button says Saved", (await page.getByRole("button", { name: "Saved" }).count()) === 1);
    await go(page, "/market/saved");
    ok("save: it's in Saved listings", (await tiles(page)).join() === "Portrait session");

    // Selling needs a business
    await go(page, "/market/sell");
    ok("sell: without a business you're told to create one", (await page.getByText("Only business pages can sell for now").count()) === 1);
    await go(page, "/settings/business");
    await page.getByLabel("Business name").fill("Sunrise Shoes");
    await page.getByLabel("Handle").fill("sunrise_shoes");
    await page.getByLabel("Category").selectOption("retail");
    await page.getByRole("button", { name: "Create business page" }).click();
    await page.waitForTimeout(1500);

    await go(page, "/market/sell");
    await page.getByLabel("Title").fill("Red running shoes");
    await page.getByLabel("Category").selectOption("fashion");
    await page.getByLabel("Price (₦, optional)").fill("15,000");
    await page.getByLabel("Condition").selectOption("new");
    await page.getByLabel("Area").fill("Lekki, Lagos");
    await page.getByRole("checkbox", { name: "Delivery" }).check();
    await page.getByRole("button", { name: "Publish listing" }).click();
    await page.waitForTimeout(1500);
    const listingUrl = new URL(page.url()).pathname;
    body = await text(page);
    ok("sell: published and opened (₦15,000, new, delivery)", /^\/l\/lst-/.test(listingUrl) && body.includes("₦15,000") && body.includes("New") && body.includes("Delivery"), listingUrl);
    ok("sell: the owner gets Edit and status, not Save", (await page.getByRole("button", { name: "Edit" }).count()) === 1 && (await page.getByRole("button", { name: "Save", exact: true }).count()) === 0);

    await go(page, "/settings/business");
    await page.getByLabel("Status of Red running shoes").selectOption("reserved");
    await page.waitForTimeout(700);
    await go(page, "/b/sunrise_shoes");
    await page.getByRole("tab", { name: "Products" }).click();
    await page.waitForTimeout(900);
    ok("business page: the product shows, marked reserved", (await tiles(page)).join() === "Red running shoes" && (await page.locator(".mk-badge--reserved").count()) === 1);

    // Share in a post; the card follows the listing
    await page.getByRole("tab", { name: "Posts" }).click();
    await page.waitForTimeout(700);
    await page.getByLabel("Post as your business").fill("New in this week");
    await page.getByLabel("Share a listing (optional)").selectOption({ label: "Red running shoes" });
    await page.getByRole("button", { name: "Post", exact: true }).click();
    await page.waitForTimeout(1500);
    const card = page.locator("article.post").filter({ hasText: "New in this week" }).locator(".mk-postcard");
    ok("post: shares the listing as a card", (await card.innerText()).includes("Red running shoes") && (await card.innerText()).includes("₦15,000"));
    await go(page, listingUrl);
    await page.getByLabel("Status").selectOption("sold");
    await page.waitForTimeout(700);
    await go(page, "/b/sunrise_shoes");
    await page.locator("article.post").filter({ hasText: "New in this week" }).waitFor({ timeout: 5000 });
    ok("post: the card now says Sold", (await page.locator("article.post").filter({ hasText: "New in this week" }).locator(".mk-badge--sold").count()) === 1);
    await go(page, listingUrl);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.waitForTimeout(400);
    await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
    await page.waitForTimeout(1200);
    await go(page, "/b/sunrise_shoes");
    await page.locator("article.post").filter({ hasText: "New in this week" }).waitFor({ timeout: 5000 });
    ok("post: after deleting, the post stays and the card goes", (await page.locator("article.post").filter({ hasText: "New in this week" }).locator(".mk-postcard").count()) === 0);

    // A restaurant: Menu grouped by section, About with hours
    await go(page, "/b/kofis_kitchen");
    ok("restaurant: tabs Posts, Menu, Services, About", (await page.getByRole("tab").allInnerTexts()).join() === "Posts,Menu,Services,About");
    await page.getByRole("tab", { name: "Menu" }).click();
    await page.waitForTimeout(900);
    body = await text(page);
    ok("restaurant: menu grouped by section", body.indexOf("Trays") < body.indexOf("Party jollof") && body.indexOf("Grill") < body.indexOf("Beef suya"));
    await page.getByRole("tab", { name: "About" }).click();
    await page.waitForTimeout(500);
    ok("restaurant: About lists opening hours", (await text(page)).includes("Friday") && (await text(page)).includes("10:00–23:00") && (await text(page)).includes("Sunday"));
    await go(page, "/b/mira_studio");
    await page.getByRole("tab", { name: "About" }).waitFor({ timeout: 5000 });
    ok("service business: Services comes before Products", (await page.getByRole("tab").allInnerTexts()).join() === "Posts,Services,Products,About");

    // Admin
    await go(page, "/admin/marketplace");
    ok("admin: listings with who runs them", (await text(page)).includes("Party jollof tray") && (await text(page)).includes("run by @"));
    await page.locator(".admin-row").filter({ hasText: "Party jollof tray" }).getByRole("button", { name: "Remove" }).click();
    await page.waitForTimeout(900);
    await go(page, "/market");
    await page.getByPlaceholder("Search products and services").fill("jollof");
    await page.waitForTimeout(1200);
    ok("admin: a removed listing leaves the Marketplace", (await tiles(page)).length === 0);
    await go(page, "/admin/marketplace");
    await page.locator(".admin-row").filter({ hasText: "Party jollof tray" }).getByRole("button", { name: "Restore" }).click();
    await page.waitForTimeout(900);
    ok("admin: restore brings it back as a draft", (await page.locator(".admin-row").filter({ hasText: "Party jollof tray" }).innerText()).includes("Draft"));
    await page.getByRole("button", { name: "Turn off" }).click();
    await page.waitForTimeout(900);
    ok("admin: the switch reads off", (await page.getByText(/^Off: only admins/).count()) === 1);
    ok("on: no page errors", errors.length === 0, errors.join("; "));
    await context.close();
  }

  // ---------------------------------------------------------------- phone width
  {
    const { context, page } = await open("demo=market", devices["iPhone 13"]);
    for (const path of ["/market", "/l/lst-jollof", "/b/kofis_kitchen"]) {
      await go(page, path);
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      ok(`phone: no sideways scrolling on ${path}`, wide <= 0, `${wide}px`);
    }
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL MARKETPLACE TESTS PASSED");
process.exit(failures ? 1 : 0);
