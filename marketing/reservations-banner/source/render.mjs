import { createRequire } from "module";
const require = createRequire("/Users/mac/amigo-world/package.json");
const { chromium } = require("playwright");

const dir = process.argv[2], out = process.argv[3];
const sizes = { wide: [1920, 1080], tall: [1080, 1350] };
const browser = await chromium.launch();
for (const [v, [w, h]] of Object.entries(sizes)) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  await page.goto(`file://${dir}/banner.html?v=${v}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/amigo-world-reservations-${v}.png` });
  await page.close();
}
await browser.close();
