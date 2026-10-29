/**
 * Business pages in the demo app (src/data/demoBusiness.ts), offline:
 *
 *   - off (plain ?demo): no Settings row, no Explore link, /settings/business says "not available";
 *   - on (?demo=business): create (reserved handle and "Amigo" names refused), the page at
 *     /b/:handle never shows who runs it, posting as the business, its posts signed by the
 *     business with Delete only (no Edit, no Block), deleting one, the handle locked for 30 days;
 *   - the directory: search and category filter; follow and unfollow another business;
 *   - another business's post: no Delete;
 *   - admin: the list, suspend hides the page, restore brings it back, the on/off switch;
 *   - phone width: no sideways scrolling on the business page.
 *
 *   node scripts/test/business.test.mjs
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
    history.pushState({ idx: 1 }, "", p + location.search);
    dispatchEvent(new PopStateEvent("popstate", { state: { idx: 1 } }));
  }, path);
  await page.waitForTimeout(900);
}
const text = (page) => page.locator("main").innerText();

try {
  // ---------------------------------------------------------------- off
  {
    const { context, page, errors } = await open("demo");
    await go(page, "/settings");
    ok("off: no business row in Settings", (await page.getByText("Create a business page").count()) === 0 && (await page.getByText("Your business").count()) === 0);
    await go(page, "/explore");
    ok("off: no Find businesses link on Explore", (await page.getByRole("link", { name: "Find businesses" }).count()) === 0);
    await go(page, "/settings/business");
    ok("off: creating says not available", (await page.getByText("Business pages aren't available yet").count()) === 1);
    ok("off: no page errors", errors.length === 0, errors.join("; "));
    await context.close();
  }

  // ---------------------------------------------------------------- on
  {
    const { context, page, errors } = await open("demo=business");
    await go(page, "/settings");
    ok("on: Settings offers to create a business page", (await page.getByRole("link", { name: /Create a business page/ }).count()) === 1);
    await go(page, "/explore");
    ok("on: Explore links to businesses", (await page.getByRole("link", { name: "Find businesses" }).count()) === 1);

    await go(page, "/settings/business");
    const fill = async (name, handle) => {
      await page.getByLabel("Business name").fill(name);
      await page.getByLabel("Handle").fill(handle);
    };
    await fill("Sunrise Bakery", "admin");
    await page.getByRole("button", { name: "Create business page" }).click();
    await page.waitForTimeout(700);
    ok("create: a reserved handle is refused", (await page.getByRole("alert").innerText()).includes("handle isn't available"));
    await fill("Amigo Bakery", "sunrise_bakery");
    await page.getByRole("button", { name: "Create business page" }).click();
    await page.waitForTimeout(700);
    ok("create: a name using Amigo is refused", (await page.getByRole("alert").innerText()).includes("name isn't allowed"));
    await fill("Sunrise Bakery", "sunrise_bakery");
    await page.getByLabel("Category").selectOption("food_drink");
    await page.getByLabel("Website (optional)").fill("https://sunrise.example.com");
    await page.getByRole("button", { name: "Create business page" }).click();
    await page.waitForTimeout(1500);
    ok("create: goes to /b/sunrise_bakery", new URL(page.url()).pathname === "/b/sunrise_bakery");
    let body = await text(page);
    ok("page: name, handle and category shown", body.includes("Sunrise Bakery") && body.includes("/b/sunrise_bakery") && body.includes("Food & drink"));
    const pageText = await page.locator(".biz-profile").innerText();
    ok("page: owner's name and @handle never shown", !/Sam Okafor|samokafor/i.test(pageText), pageText);
    ok("page: the owner gets a post box and settings link", (await page.getByLabel("Post as your business").count()) === 1 && (await page.getByRole("link", { name: "Business settings" }).count()) === 1);
    ok("page: no Follow button on your own business", (await page.getByRole("button", { name: /Follow Sunrise Bakery/ }).count()) === 0);

    await page.getByLabel("Post as your business").fill("Fresh bread every morning from 7am.");
    await page.getByRole("button", { name: "Post", exact: true }).click();
    await page.waitForTimeout(1500);
    const post = page.locator("article.post").filter({ hasText: "Fresh bread every morning" });
    ok("post: appears on the page", (await post.count()) === 1);
    const head = (await post.locator(".post__head").innerText()).replace(/\s+/g, " ");
    ok("post: signed by the business, labelled Business", head.includes("Sunrise Bakery") && head.includes("Business") && head.includes("/b/sunrise_bakery") && !head.includes("@") && !/Sam Okafor/.test(head), head);
    await post.getByRole("button", { name: "Post options" }).click();
    await page.waitForTimeout(400);
    ok("post menu: Delete, but no Edit and no Block", (await page.getByRole("button", { name: "Delete" }).count()) === 1 && (await page.getByRole("button", { name: "Edit" }).count()) === 0 && (await page.getByRole("button", { name: /^Block/ }).count()) === 0);
    await page.getByRole("button", { name: "Delete" }).click();
    await page.waitForTimeout(400);
    await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
    await page.waitForTimeout(1500);
    ok("post: deleted", (await page.locator("article.post").filter({ hasText: "Fresh bread every morning" }).count()) === 0);

    await go(page, "/settings/business");
    ok("settings: handle can't change again for 30 days", await page.getByLabel("Handle").isDisabled());
    ok("settings: says when it can change", (await page.getByText(/You can change it again on/).count()) === 1);

    await go(page, "/settings");
    ok("settings: row now reads Your business", (await page.getByRole("link", { name: /Your business/ }).count()) === 1);

    // Directory
    await go(page, "/business");
    body = await text(page);
    ok("directory: lists businesses", body.includes("Kofi's Kitchen") && body.includes("Mira Studio") && body.includes("Sunrise Bakery"));
    await page.getByRole("button", { name: "Technology" }).click();
    await page.waitForTimeout(900);
    body = await text(page);
    ok("directory: category filter", body.includes("Leo Phone Repairs") && !body.includes("Kofi's Kitchen"));
    await page.getByRole("button", { name: "All", exact: true }).click();
    await page.getByPlaceholder("Search businesses").fill("mira");
    await page.waitForTimeout(1200);
    body = await text(page);
    ok("directory: search", body.includes("Mira Studio") && !body.includes("Kofi's Kitchen"));

    // Another business
    await go(page, "/b/kofis_kitchen");
    body = await text(page);
    ok("other page: shows contacts", body.includes("kofis-kitchen.example.com") && body.includes("+234"));
    ok("other page: following (demo starts following it), 128 followers", (await page.getByRole("button", { name: "Unfollow Kofi's Kitchen" }).count()) === 1 && body.includes("128"));
    await page.getByRole("button", { name: "Unfollow Kofi's Kitchen" }).click();
    await page.waitForTimeout(700);
    ok("unfollow: count goes down", (await text(page)).includes("127") && (await page.getByRole("button", { name: "Follow Kofi's Kitchen" }).count()) === 1);
    await page.getByRole("button", { name: "Follow Kofi's Kitchen" }).click();
    await page.waitForTimeout(700);
    ok("follow: count back up", (await text(page)).includes("128"));
    const theirs = page.locator("article.post").first();
    await theirs.getByRole("button", { name: "Post options" }).click();
    await page.waitForTimeout(400);
    ok("their post menu: no Delete, no Edit, no Block", (await page.getByRole("button", { name: "Delete" }).count()) === 0 && (await page.getByRole("button", { name: "Edit" }).count()) === 0 && (await page.getByRole("button", { name: /^Block/ }).count()) === 0);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // Admin
    await go(page, "/admin/businesses");
    body = await text(page);
    ok("admin: list with who runs each page", body.includes("Kofi's Kitchen") && body.includes("run by @"));
    const row = page.locator(".admin-row").filter({ hasText: "Kofi's Kitchen" });
    await row.getByRole("button", { name: "Suspend" }).click();
    await page.waitForTimeout(900);
    ok("admin: suspended", (await page.locator(".admin-row").filter({ hasText: "Kofi's Kitchen" }).getByText("Suspended").count()) >= 1);
    await go(page, "/b/kofis_kitchen");
    ok("suspended page isn't shown", (await page.getByText("This business page isn't available").count()) === 1);
    await go(page, "/admin/businesses");
    await page.locator(".admin-row").filter({ hasText: "Kofi's Kitchen" }).getByRole("button", { name: "Restore" }).click();
    await page.waitForTimeout(900);
    await go(page, "/b/kofis_kitchen");
    ok("restored page is back", (await page.getByRole("heading", { name: "Kofi's Kitchen" }).count()) >= 1);
    await go(page, "/admin/businesses");
    await page.getByRole("button", { name: "Turn off" }).click();
    await page.waitForTimeout(900);
    ok("admin: switch reads off", (await page.getByText(/^Off: nobody can create/).count()) === 1);
    ok("on: no page errors", errors.length === 0, errors.join("; "));
    await context.close();
  }

  // ---------------------------------------------------------------- phone width
  {
    const { context, page } = await open("demo=business", devices["iPhone 13"]);
    await go(page, "/b/kofis_kitchen");
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok("phone: no sideways scrolling on a business page", wide <= 0, `${wide}px`);
    await go(page, "/business");
    const wide2 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok("phone: no sideways scrolling in the directory", wide2 <= 0, `${wide2}px`);
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL BUSINESS TESTS PASSED");
process.exit(failures ? 1 : 0);
