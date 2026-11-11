// Scene 6 graphic (2 s, 48 frames): the phone turns over, the thumb taps the Amigo World icon, the app opens.
// Same phone geometry as every app shot, so it cuts straight into the recorded splash. Output: gfx/s06/f0001.png …
import { createRequire } from "module";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
const req = createRequire("/Users/mac/amigo-world/package.json");
const { chromium } = req("playwright");
const P = new URL(".", import.meta.url).pathname, OUT = `${P}gfx/s06`;
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
const b64 = (f) => `data:image/png;base64,${readFileSync(f).toString("base64")}`;
const BG = b64(`${P}gfx/phone-bg.png`), TOP = b64(`${P}gfx/phone-top.png`);
const X = 748, Y = 52, W = 424, H = 976, R = 58, BEZ = 12;
const MARK = `<svg viewBox="0 0 32 32" width="100%" height="100%"><path d="M9 0h14a9 9 0 0 1 9 9v14a9 9 0 0 1-9 9H3a3 3 0 0 1-3-3V9a9 9 0 0 1 9-9z" fill="#ff5a3c"/><circle cx="14.6" cy="17.2" r="5.6" fill="none" stroke="#1d0a05" stroke-width="3.2"/><rect x="19.6" y="10" width="3.3" height="13" rx="1.65" fill="#1d0a05"/></svg>`;
// Generic home screen: muted tiles (no real apps or brands), one Amigo World icon (row 3, col 2).
const ICON = 64, MX = 30, GAP = (W - 2 * MX - 4 * ICON) / 3, TOP0 = 92, ROWG = 96;
let tiles = "";
const hues = [210, 260, 20, 160, 300, 45, 190, 340, 120, 230, 0, 280, 90, 200, 30, 170];
for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
  const x = MX + c * (ICON + GAP), y = TOP0 + r * ROWG;
  if (r === 2 && c === 1) continue;
  const h = hues[r * 4 + c];
  tiles += `<div style="position:absolute;left:${x}px;top:${y}px;width:${ICON}px;height:${ICON}px;border-radius:15px;background:linear-gradient(160deg,hsla(${h},35%,42%,.55),hsla(${h},30%,22%,.55));box-shadow:inset 0 0 0 1px rgba(255,255,255,.06)"></div>
    <div style="position:absolute;left:${x - 6}px;top:${y + ICON + 7}px;width:${ICON + 12}px;height:7px;border-radius:4px;background:rgba(255,255,255,.18)"></div>`;
}
const AX = MX + 1 * (ICON + GAP), AY = TOP0 + 2 * ROWG;
let dock = "";
for (let c = 0; c < 4; c++) dock += `<div style="position:absolute;left:${MX + c * (ICON + GAP)}px;top:${H - 112}px;width:${ICON}px;height:${ICON}px;border-radius:15px;background:linear-gradient(160deg,hsla(${hues[c + 8]},25%,45%,.5),hsla(${hues[c + 8]},25%,25%,.5))"></div>`;

const html = `<!doctype html><html><head><style>html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:#000}
#bg{position:absolute;inset:0;background:radial-gradient(ellipse 60% 70% at 50% 45%, #1d1419 0%, #0d0b10 55%, #070609 100%)}
#phone{position:absolute;left:${X - BEZ}px;top:${Y - BEZ}px;width:${W + 2 * BEZ}px;height:${H + 2 * BEZ}px;transform-origin:50% 50%}
.face{position:absolute;inset:0;border-radius:${R + BEZ}px;backface-visibility:hidden;box-shadow:0 40px 90px rgba(0,0,0,.65),0 0 0 1px rgba(255,255,255,.04),0 0 140px rgba(255,90,60,.10)}
#back{background:linear-gradient(150deg,#3a3940,#1c1b20 55%,#2c2b31);box-shadow:inset 0 0 0 3px #55535b}
#cam{position:absolute;left:22px;top:22px;width:150px;height:150px;border-radius:40px;background:#26252b;box-shadow:inset 0 0 0 2px #4a4850}
#cam i{position:absolute;width:52px;height:52px;border-radius:50%;background:radial-gradient(circle,#0b0b0e 45%,#3b3a42 48%,#18171c 70%)}
#front{background:#000}
#screen{position:absolute;left:${BEZ}px;top:${BEZ}px;width:${W}px;height:${H}px;border-radius:${R}px;overflow:hidden;
  background:radial-gradient(ellipse 90% 60% at 30% 20%,#5b2a3a 0%,transparent 60%),radial-gradient(ellipse 80% 60% at 80% 85%,#2a2f6b 0%,transparent 60%),#121018}
#amigo{position:absolute;left:${AX}px;top:${AY}px;width:${ICON}px;height:${ICON}px;transform-origin:50% 50%;border-radius:15px;overflow:hidden}
#lbl{position:absolute;left:${AX - 14}px;top:${AY + ICON + 4}px;width:${ICON + 28}px;text-align:center;font:500 12.5px -apple-system,system-ui;color:#fff}
#touch{position:absolute;left:${AX + ICON / 2 - 26}px;top:${AY + ICON / 2 - 26}px;width:52px;height:52px;border-radius:50%;background:rgba(255,255,255,.35);opacity:0}
#open{position:absolute;left:${AX}px;top:${AY}px;width:${ICON}px;height:${ICON}px;border-radius:15px;background:#0c0c0e;opacity:0;display:grid;place-items:center}
#open div{width:38%;height:38%}
#top{position:absolute;inset:0;background:url(${TOP});opacity:0}
</style></head><body><div id="bg"></div>
<div id="phone"><div class="face" id="back"><div id="cam"><i style="left:14px;top:14px"></i><i style="left:84px;top:14px"></i><i style="left:14px;top:84px"></i></div></div>
<div class="face" id="front"><div id="screen">${tiles}${dock}<div id="amigo">${MARK}</div><div id="lbl">Amigo World</div><div id="touch"></div><div id="open"><div>${MARK}</div></div></div></div></div>
<div id="top"></div></body></html>`;

const ease = (x) => (x < 0 ? 0 : x > 1 ? 1 : x * x * (3 - 2 * x));
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
await p.setContent(html);
for (let f = 0; f < 48; f++) {
  const t = f / 24;
  await p.evaluate(({ t, W: Wd, H: Hd, AX: ax, AY: ay, ICON: ic, ease: _ }) => {
    const e = (x) => (x < 0 ? 0 : x > 1 ? 1 : x * x * (3 - 2 * x));
    const flip = e(t / 0.6);                                     // 0–0.6 s: turn over (back → front)
    const ang = 180 * (1 - flip), front = ang < 90;
    const ph = document.getElementById("phone");
    ph.style.transform = `perspective(2400px) rotateY(${ang}deg) scale(${0.96 + 0.04 * flip})`;
    document.getElementById("back").style.backfaceVisibility = "visible";
    document.getElementById("back").style.display = front ? "none" : "block";
    document.getElementById("front").style.display = front ? "block" : "none";
    document.getElementById("top").style.opacity = flip >= 1 ? 1 : 0;   // bezel + 9:41 status bar once facing us
    const tap = t - 1.0;                                           // 1.0 s: thumb taps the icon
    document.getElementById("touch").style.opacity = tap > 0 && tap < 0.35 ? (0.9 - tap * 2.2) : 0;
    document.getElementById("touch").style.transform = `scale(${0.7 + Math.max(0, tap) * 1.4})`;
    document.getElementById("amigo").style.transform = `scale(${tap > 0 && tap < 0.18 ? 0.88 : 1})`;
    const o = e((t - 1.25) / 0.6);                                 // 1.25–1.85 s: app opens from the icon
    const op = document.getElementById("open");
    op.style.opacity = o > 0 ? 1 : 0;
    op.style.left = `${ax * (1 - o)}px`; op.style.top = `${ay * (1 - o)}px`;
    op.style.width = `${ic + (Wd - ic) * o}px`; op.style.height = `${ic + (Hd - ic) * o}px`;
    op.style.borderRadius = `${15 + 43 * o}px`;
    op.firstElementChild.style.width = op.firstElementChild.style.height = `${38 - 23 * o}%`;
    op.firstElementChild.style.transform = `translateY(${29 * o}px)`; // lands where the recorded splash logo sits
  }, { t, W, H, AX, AY, ICON });
  await p.screenshot({ path: `${OUT}/f${String(f + 1).padStart(4, "0")}.png` });
}
await b.close();
console.log("s06 graphic: 48 frames");
