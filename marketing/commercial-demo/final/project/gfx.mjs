// Renders the master's graphics at 1920x1080 (Chromium; this ffmpeg has no drawtext) and builds the composited
// stills (Ada's Atelier tall frames, the scene 12 entry). Output: ./gfx/
import { createRequire } from "module";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
const req = createRequire("/Users/mac/amigo-world/package.json");
const { chromium } = req("playwright");
const P = new URL(".", import.meta.url).pathname, G = `${P}gfx`, ROOT = new URL("../..", import.meta.url).pathname;
mkdirSync(G, { recursive: true });
const TL = JSON.parse(readFileSync(`${P}timeline.json`, "utf8"));
const FD = "/Users/mac/amigo-world/public/_maintenance/fonts";
const font = (f) => `data:font/woff2;base64,${readFileSync(`${FD}/${f}`).toString("base64")}`;
const CSS = `@font-face{font-family:Bricolage;src:url(${font("bricolage-grotesque-latin-standard-normal.woff2")})}
@font-face{font-family:Geist;src:url(${font("geist-latin-wght-normal.woff2")})}
html,body{margin:0;overflow:hidden;font-family:Geist,sans-serif;color:#f3f1ee;background:transparent}`;
const MARK = (s) => `<svg width="${s}" height="${s}" viewBox="0 0 32 32"><path d="M9 0h14a9 9 0 0 1 9 9v14a9 9 0 0 1-9 9H3a3 3 0 0 1-3-3V9a9 9 0 0 1 9-9z" fill="#ff5a3c"/><circle cx="14.6" cy="17.2" r="5.6" fill="none" stroke="#1d0a05" stroke-width="3.2"/><rect x="19.6" y="10" width="3.3" height="13" rx="1.65" fill="#1d0a05"/></svg>`;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const ff = (a) => execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...a]);

// Phone geometry (px): screen 424 wide = 393 pt at k px/pt; 54 pt status band, then the 2556-px recording scaled to 918.
export const PH = { k: 424 / 393, x: 748, y: 52, w: 424, band: 58, foot: 918, h: 976, r: 58, bez: 12 };
const BACK = `radial-gradient(ellipse 60% 70% at 50% 45%, #1d1419 0%, #0d0b10 55%, #070609 100%)`;

const b = await chromium.launch();
const p = await b.newPage();
async function shot(name, html, { w = 1920, h = 1080, transparent = true } = {}) {
  await p.setViewportSize({ width: w, height: h });
  await p.setContent(`<!doctype html><html><head><style>${CSS}</style></head><body style="width:${w}px;height:${h}px">${html}</body></html>`);
  await p.evaluate(() => document.fonts.ready);
  await p.screenshot({ path: `${G}/${name}.png`, omitBackground: transparent });
}
// iOS-style status bar content for a screen `w` px wide at `k` px/pt (time 9:41, full signal, Wi-Fi, battery).
const statusBar = (k, w) => `
  <div style="position:absolute;left:0;top:0;width:${w}px;height:${54 * k}px;color:#fff;font:600 ${17 * k}px -apple-system,system-ui,sans-serif">
    <div style="position:absolute;left:${(w - 126 * k) / 2}px;top:${11 * k}px;width:${126 * k}px;height:${37 * k}px;border-radius:${19 * k}px;background:#000"></div>
    <div style="position:absolute;left:${52 * k}px;top:${17 * k}px;letter-spacing:-.01em">9:41</div>
    <svg style="position:absolute;right:${28 * k}px;top:${20 * k}px" width="${76 * k}" height="${13 * k}" viewBox="0 0 76 13" fill="#fff">
      <rect x="0" y="8" width="3" height="4" rx="1"/><rect x="4.7" y="5.8" width="3" height="6.2" rx="1"/><rect x="9.4" y="3.4" width="3" height="8.6" rx="1"/><rect x="14.1" y="1" width="3" height="11" rx="1"/>
      <path d="M30.5 3.1a10.6 10.6 0 0 1 14 0l-1.5 1.6a8.4 8.4 0 0 0-11 0zM33.2 6a6.6 6.6 0 0 1 8.6 0l-1.5 1.6a4.4 4.4 0 0 0-5.6 0zM37.5 11.6 35.9 9.9a2.4 2.4 0 0 1 3.2 0z"/>
      <rect x="51.5" y=".5" width="22" height="11.5" rx="3.4" fill="none" stroke="#fff" stroke-opacity=".45"/><rect x="53.5" y="2.5" width="18" height="7.5" rx="1.8"/><path d="M74.8 4.4v3.7a2 2 0 0 0 0-3.7z" fill-opacity=".45"/>
    </svg></div>`;

// 1) Phone: background + body + shadow (screen area black), and the top layer (bezel ring, buttons, status bar, home indicator).
const { x, y, w, h, r, bez } = PH;
await shot("phone-bg", `<div style="position:absolute;inset:0;background:${BACK}"></div>
  <div style="position:absolute;left:${x - bez}px;top:${y - bez}px;width:${w + 2 * bez}px;height:${h + 2 * bez}px;border-radius:${r + bez}px;background:#000;box-shadow:0 40px 90px rgba(0,0,0,.65),0 0 0 1px rgba(255,255,255,.04),0 0 140px rgba(255,90,60,.10)"></div>`, { transparent: false });
await shot("phone-top", `<svg width="1920" height="1080" style="position:absolute;inset:0">
  <defs><linearGradient id="ti" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#5b5961"/><stop offset=".5" stop-color="#2b2a2f"/><stop offset="1" stop-color="#4a484f"/></linearGradient></defs>
  <path fill-rule="evenodd" fill="#050506" d="M${x - bez + r + bez} ${y - bez}h${w - 2 * r}a${r + bez} ${r + bez} 0 0 1 ${r + bez} ${r + bez}v${h - 2 * r}a${r + bez} ${r + bez} 0 0 1 -${r + bez} ${r + bez}h-${w - 2 * r}a${r + bez} ${r + bez} 0 0 1 -${r + bez} -${r + bez}v-${h - 2 * r}a${r + bez} ${r + bez} 0 0 1 ${r + bez} -${r + bez}z
    M${x + r} ${y}a${r} ${r} 0 0 0 -${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 0 ${r} ${r}h${w - 2 * r}a${r} ${r} 0 0 0 ${r} -${r}v-${h - 2 * r}a${r} ${r} 0 0 0 -${r} -${r}z"/>
  <rect x="${x - bez - 1.5}" y="${y - bez - 1.5}" width="${w + 2 * bez + 3}" height="${h + 2 * bez + 3}" rx="${r + bez + 1.5}" fill="none" stroke="url(#ti)" stroke-width="3"/>
  <rect x="${x - bez - 5}" y="${y + 150}" width="3" height="40" rx="1.5" fill="#3a3940"/><rect x="${x - bez - 5}" y="${y + 215}" width="3" height="70" rx="1.5" fill="#3a3940"/><rect x="${x - bez - 5}" y="${y + 300}" width="3" height="70" rx="1.5" fill="#3a3940"/>
  <rect x="${x + w + bez + 2}" y="${y + 240}" width="3" height="105" rx="1.5" fill="#3a3940"/></svg>
  <div style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px">${statusBar(PH.k, w)}</div>`);

// 2) Close-up of the phone's top for the reaction banners (crop 1180x700 of the recording at 1:1, 3.0 px/pt).
const WK = 1180 / 393, WX = 370, WY = 64, WB = Math.round(54 * WK), WH = WB + 700;
const R1 = Math.round(55 * WK), R2 = 28;
const wideBg = `<div style="position:absolute;inset:0;background:${BACK}"></div>
  <div style="position:absolute;left:${WX}px;top:${WY}px;width:1180px;height:${WH}px;border-radius:${R1}px ${R1}px ${R2}px ${R2}px;background:#000;box-shadow:0 40px 90px rgba(0,0,0,.65),0 0 140px rgba(255,90,60,.10)"></div>`;
await shot("wide-bg", wideBg, { transparent: false });
const hole = `M${WX + R1} ${WY}H${WX + 1180 - R1}A${R1} ${R1} 0 0 1 ${WX + 1180} ${WY + R1}V${WY + WH - R2}A${R2} ${R2} 0 0 1 ${WX + 1180 - R2} ${WY + WH}H${WX + R2}A${R2} ${R2} 0 0 1 ${WX} ${WY + WH - R2}V${WY + R1}A${R1} ${R1} 0 0 1 ${WX + R1} ${WY}Z`;
await shot("wide-top", `<div style="position:absolute;inset:0;clip-path:path(evenodd,'M0 0H1920V1080H0Z ${hole}')">${wideBg}</div>
  <div style="position:absolute;left:${WX}px;top:${WY}px;width:1180px;height:${WH}px">${statusBar(WK, 1180)}</div>`);
export const WIDE = { x: WX, y: WY, band: WB, w: 1180, h: WH };

// 3) Hold cards for shots still to be filmed (clearly marked, never mistakable for final picture).
const card = (s, w = 1920) => `<div style="position:absolute;inset:0;width:${w}px;background:#100e13;overflow:hidden">
  <div style="position:absolute;inset:28px;border:2px dashed rgba(255,90,60,.45);border-radius:18px"></div>
  <div style="position:absolute;left:${w > 1000 ? 150 : 90}px;right:${w > 1000 ? 150 : 70}px;top:50%;transform:translateY(-50%)">
    <div style="display:inline-block;background:#ff5a3c;color:#1d0a05;font:700 ${w > 1000 ? 20 : 17}px Geist;letter-spacing:.14em;padding:9px 16px;border-radius:8px">SHOT TO FILM · SCENE ${s.scene}</div>
    <div style="font:700 ${w > 1000 ? 54 : 40}px/1.12 Bricolage;margin-top:26px;letter-spacing:-.01em">${esc(s.action)}</div>
    <div style="font:400 ${w > 1000 ? 24 : 20}px/1.45 Geist;color:#aaa4b4;margin-top:22px">${esc(s.framing)}${s.cast ? ` · ${esc(s.cast)}` : ""}</div>
    <div style="font:500 ${w > 1000 ? 18 : 16}px Geist;color:#6f6a7a;margin-top:26px;letter-spacing:.04em">Drop-in file: assets/drop-in/live-action/${esc(s.file)}</div>
  </div></div>`;
for (const s of TL) {
  if (s.type === "pending") await shot(`pending-${s.id}`, card(s), { transparent: false });
  if (s.type === "split") await shot(`pending-${s.id}-left`, card(s.left, 960), { w: 960, transparent: false });
}
// 5) End card (original wording), three build states.
const end = (step) => `<div style="position:absolute;inset:0;background:radial-gradient(ellipse at 50% 32%,#1f1520 0%,#09080c 68%);display:flex;flex-direction:column;align-items:center;justify-content:center">
  <div style="display:flex;align-items:center;gap:30px">${MARK(124)}<div style="font:700 104px Bricolage;letter-spacing:-.015em">Amigo World</div></div>
  <div style="font:600 64px Bricolage;margin-top:54px;color:#ece8f3;opacity:${step >= 1 ? 1 : 0}">Your world, together.</div>
  <div style="margin-top:62px;display:flex;flex-direction:column;align-items:center;gap:20px;opacity:${step >= 2 ? 1 : 0}">
    <div style="background:#ff5a3c;color:#1d0a05;font:700 40px Geist;padding:24px 54px;border-radius:999px;box-shadow:0 18px 60px rgba(255,90,60,.35)">Reserve your username</div>
    <div style="font:500 31px Geist;color:#c9c3d3">reserve.amigoworld.com.ng</div>
    <div style="font:500 25px Geist;color:#837d8f">Free · 18+</div></div></div>`;
for (const i of [0, 1, 2]) await shot(`end${i}`, end(i), { transparent: false });
// 6) Ada's Atelier logo as the 128 px avatar patch.
const svg = readFileSync(`${ROOT}ada-atelier/logo-adas-atelier.svg`, "utf8");
await shot("logo128", `<div style="width:128px;height:128px;border-radius:50%;overflow:hidden;background:url('data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}') center/cover"></div>`, { w: 128, h: 128 });
// 7) Scene 12 entry: the real entry card with Femi's photo between its text and its like row.
const roof = `${ROOT}final/assets/drop-in/rooftop-still.jpg`;
// Femi's entry photo: the rooftop still when supplied; otherwise frame 0 of the scene 13 Lagos aerial (Pexels 31661123),
// so the 12→13 match cut lands on the same image.
const photo = existsSync(roof) ? roof : `${ROOT}final/assets/stock/pexels-31661123-frame0_entry-photo.jpg`;
const srcCard = `${ROOT}final/assets/s12-entry-card-source.png`;
const u = (f) => `data:image/${f.endsWith(".png") ? "png" : "jpeg"};base64,${readFileSync(f).toString("base64")}`;
const sl = (top, h, from) => `<div style="position:absolute;left:0;top:${top}px;width:1179px;height:${h}px;background:url(${u(srcCard)}) 0 -${from}px no-repeat"></div>`;
await shot("entry-composite", `<div style="position:absolute;inset:0;background:#0c0c0e"></div>${sl(0, 140, 0)}<div style="position:absolute;left:0;top:140px;width:1179px;height:10px;background:#0c0c0e"></div>${sl(150, 859, 921)}${sl(1009, 380, 1780)}
  <div style="position:absolute;left:48px;top:1413px;width:1084px;height:813px;border-radius:36px;background:url(${u(photo)}) center 40%/cover"></div>${sl(2250, 110, 2190)}${sl(2360, 196, 2360)}`, { w: 1179, h: 2556, transparent: false });
// 8) Ada's Atelier frames (393x659 pt captures) stitched into full-height 393x852 pt screens using the next approved
//    frame's real content, joined in blank rows between posts; navigation bar kept at the bottom.
const AF = (n) => `${ROOT}ada-atelier/composite-frame-${n}.png`;
ff(["-i", AF(1), "-i", AF(2), "-filter_complex", "[0]crop=1179:1680:0:0[a];[1]crop=1179:680:0:522[b];[0]crop=1179:196:0:1781[n];[a][b][n]vstack=3", `${G}/ada-T1.png`]);
ff(["-i", AF(2), "-i", AF(3), "-filter_complex", "[0]crop=1179:1700:0:0[a];[1]crop=1179:660:0:355[b];[0]crop=1179:196:0:1781[n];[a][b][n]vstack=3", `${G}/ada-T2.png`]);
await b.close();
console.log("gfx done", existsSync(roof) ? "(entry photo: supplied rooftop still)" : "(entry photo: Pexels 31661123 frame 0)");
