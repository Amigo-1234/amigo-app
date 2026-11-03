/**
 * Mobile smoke test for message interactions (iPhone 13 profile, real touch
 * events) against the demo backend:  npx vite --mode demo --port 5173, then
 *   node scripts/test/mobile-dm.smoke.mjs <screenshot-dir>
 * Uses the globally installed Playwright (PLAYWRIGHT_PATH to override).
 */
import { createRequire } from "module";
const { chromium, devices } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH ?? "/opt/node22/lib/node_modules/playwright");
const SP = process.argv[2] ?? ".";
const b = await chromium.launch();
const ctx = await b.newContext({ ...devices["iPhone 13"] });
await ctx.route(/picsum|pravatar/, (r) => r.abort());
const p = await ctx.newPage();
const errs = []; p.on("pageerror", (e) => errs.push(e.message));
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + m); };
await p.goto("http://localhost:5173/messages/c-leo"); await p.waitForTimeout(2500);
console.log("url", p.url(), "msgs", await p.locator(".msg").count());
const bubble = p.locator(".msg--theirs .msg__bubble").last();
const box = await bubble.boundingBox();
ok(!!box, "their message visible on phone");

// long-press via touch events
const cdp = await ctx.newCDPSession(p);
const touch = async (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
await touch("touchStart", cx, cy); await p.waitForTimeout(650); await touch("touchEnd", cx, cy); await p.waitForTimeout(500);
ok(await p.locator(".msg-actions").isVisible(), "long-press opens message actions sheet");
await p.screenshot({ path: SP + "/m-actions.png" });
await p.locator(".msg-actions__emoji", { hasText: "😂" }).first().click(); await p.waitForTimeout(700);
ok((await p.locator(".msg__reaction").count()) >= 1, "reaction chip shows after reacting");

// swipe right to reply on own message
const mine = p.locator(".msg--mine .msg__bubble").last();
const mb = await mine.boundingBox();
const y = mb.y + mb.height / 2, x0 = mb.x + 10;
await touch("touchStart", x0, y);
for (let i = 1; i <= 8; i++) { await touch("touchMove", x0 + i * 10, y); await p.waitForTimeout(16); }
await touch("touchEnd", x0 + 80, y); await p.waitForTimeout(400);
ok((await p.locator(".msg-composer__reply").count()) === 1, "swipe right starts a reply");

// own message actions: edit + unsend available
const mb2 = await mine.boundingBox();
await touch("touchStart", mb2.x + mb2.width / 2, mb2.y + mb2.height / 2); await p.waitForTimeout(650); await touch("touchEnd", 0, 0); await p.waitForTimeout(500);
const sheetText = await p.locator(".msg-actions").innerText();
ok(sheetText.includes("Unsend"), "own message offers Unsend");
await p.locator(".msg-actions .sheet-menu__item", { hasText: "Unsend" }).click(); await p.waitForTimeout(300);
const before = await p.locator(".msg--mine").count();
await p.getByRole("button", { name: "Unsend", exact: true }).last().click(); await p.waitForTimeout(800);
ok((await p.locator(".msg--mine").count()) === before - 1, "unsend removes the message");

// send + edit
ok((await p.locator(".msg-composer__reply").count()) === 0, "reply preview cleared when its message is unsent");
await p.locator("#msg-input").fill("typo mesage"); await p.getByRole("button", { name: /^Send/ }).click(); await p.waitForTimeout(1200);
const last = p.locator(".msg--mine .msg__bubble").last();
const lb = await last.boundingBox();
await touch("touchStart", lb.x + lb.width / 2, lb.y + lb.height / 2); await p.waitForTimeout(650); await touch("touchEnd", 0, 0); await p.waitForTimeout(500);
await p.locator(".msg-actions .sheet-menu__item", { hasText: "Edit" }).click(); await p.waitForTimeout(300);
await p.locator(".sheet-form textarea").fill("typo message"); await p.getByRole("button", { name: "Save" }).click(); await p.waitForTimeout(800);
ok((await p.locator(".msg--mine .msg__text").last().innerText()) === "typo message", "edit updates text");
ok((await p.locator(".msg--mine").last().innerText()).includes("Edited"), "shows Edited");

// layout: no horizontal scroll, composer above keyboard area
const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
ok(overflow <= 0, "no horizontal scroll at 390px (" + overflow + ")");
const tiny = await p.evaluate(() => [...document.querySelectorAll(".msg-actions__emoji, .msg__reaction, #msg-input")].filter((e) => { const r = e.getBoundingClientRect(); return r.width && (r.height < 24); }).length);
ok(tiny === 0, "touch targets not tiny");
await p.screenshot({ path: SP + "/m-convo.png" });
ok(errs.length === 0, "no page errors " + errs.join(" | ").slice(0, 200));
console.log(fails ? fails + " FAILED" : "ALL PASS");
await b.close();
