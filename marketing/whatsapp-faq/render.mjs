// Renders faq-banner.html to a 1080x1920 PNG (WhatsApp Status, 9:16), offline.
//   node marketing/whatsapp-faq/render.mjs
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(import.meta.url)("playwright");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
// Only local files load (the page and the app's own fonts).
await page.route(/^https?:/, (route) => route.abort());
await page.goto(pathToFileURL(join(here, "faq-banner.html")).href, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
const fonts = await page.evaluate(() => [...document.fonts].map((f) => `${f.family}:${f.status}`));
const overflow = await page.evaluate(() => {
  const page = document.querySelector(".page");
  return { scroll: page.scrollHeight, client: page.clientHeight };
});
await page.screenshot({ path: join(here, "amigo-world-faq-whatsapp.png"), clip: { x: 0, y: 0, width: 1080, height: 1920 } });
await browser.close();
console.log(JSON.stringify({ fonts, overflow }));
