// Renders the thank-you banner at 2x: story 9:16 (WhatsApp Status / Instagram Stories), feed 4:5 (Instagram), wide 16:9 (X).
import { createRequire } from "module";
const require = createRequire("/Users/mac/amigo-world/package.json");
const { chromium } = require("playwright");
const dir = new URL(".", import.meta.url).pathname, out = new URL("..", import.meta.url).pathname;
const sizes = { story: [1080, 1920], feed: [1080, 1350], wide: [1600, 900] };
const browser = await chromium.launch();
for (const [v, [w, h]] of Object.entries(sizes)) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  await page.goto(`file://${dir}banner.html?v=${v}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}amigo-world-thank-you-${v}.png` });
  await page.close();
}
await browser.close();
console.log("rendered", Object.keys(sizes).join(", "));
