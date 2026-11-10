// Amigo World launch commercial: final timeline (1:45, 1920x1080, 24 fps).
// Built 1:1 from the approved animatic v1 (../../animatic). Frame-accurate: every shot boundary is rounded to
// whole frames and the total is exactly 2520 frames.
// Times: `in`/`out` = source seconds; `dur` = screen seconds. Masks/patches are in source pixels (1180x2556).
import { writeFileSync } from "node:fs";
export const FPS = 24;
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, ""); // marketing/commercial-demo
const R = `${ROOT}/raw`, AA = `${ROOT}/ada-atelier`, FA = `${ROOT}/final/assets`;
const BG = "0x0c0c0e", CARD = "0x1c1c20";
const SRC = {
  s06: `${R}/S06-app-open/S06_femi_app-open_take01_chromium-iphone15pro.mp4`,
  s07p: `${R}/S07-post-and-moment/S07_kemi_text-post_take02_chromium-iphone15pro.mp4`,
  s07m: `${R}/S07-post-and-moment/S07_kemi_text-moment_take02_chromium-iphone15pro.mp4`,
  s08: `${R}/S08-explore-follow/S08_femi_explore-follow_take01_chromium-iphone15pro.mp4`,
  bisi: `${R}/S09-encrypted-chat/S09_bisi_chat_take01_chromium-iphone15pro.mp4`,
  kemi: `${R}/S09-encrypted-chat/S09_kemi_chat_take01_chromium-iphone15pro.mp4`,
  femi11: `${R}/S11-help-hub/S11_femi_help-tobi_take01_chromium-iphone15pro.mp4`,
  ada11: `${R}/S11-help-hub/S11_ada_help-tobi_take01_chromium-iphone15pro.mp4`,
  tobi11: `${R}/S11-help-hub/S11_tobi_notification_take01_chromium-iphone15pro.mp4`,
  cd: `${R}/S12-world-live/S12_femi_countdown-to-live_take01_chromium-iphone15pro.mp4`,
  react: `${R}/S12-world-live/S12_femi_reactions-leaderboard_take01_chromium-iphone15pro.mp4`,
  chat: `${R}/S12-world-live/S12_femi_chat_take01_chromium-iphone15pro.mp4`,
  skyline: `${FA}/stock/pexels-28920105-lagos-dusk-aerial_vitalis-nwenyi.mp4`,
  rain: `${FA}/stock/pexels-35621441-rainy-window-night_emre-varisli.mp4`,
};
const m = (x, y, w, h, from = 0, to = 999, color = BG) => ({ x, y, w, h, from, to, color });
// C2 masks (verified frame by frame for the animatic).
const KEMI = [m(900, 1362, 112, 62, 0, 18.4), m(1030, 1362, 112, 62, 18.4), m(36, 1620, 116, 62, 0, 17.55), m(36, 1694, 116, 58), m(896, 2060, 118, 64, 18.3)];
const BISI = [m(36, 1362, 116, 62), m(896, 1620, 128, 62, 9.8)];
const CD = [m(36, 1056, 456, 64), m(584, 1446, 452, 46, 0, 40.35, CARD)];
const logo = (cx, cy, from = 0, to = 999, clipTop, clipBottom) => ({ cx, cy, from, to, clipTop, clipBottom });

const S = [];
// A live-action shot still to be filmed. Shown in the master as a clearly marked hold card; the same data
// drives FILMING-CHECKLIST.md. Drop the filmed clip into assets/drop-in/live-action/<file> and it replaces the card.
const pending = (scene, dur, action, framing, screen, cast, file) => ({ type: "pending", scene, dur, action, framing, screen, cast, file });
const clip = (scene, src, inp, out, dur, what, extra = {}) => ({ type: "clip", scene, src: SRC[src], in: inp, out, dur, what, ...extra });
const still = (scene, png, dur, push, what, extra = {}) => ({ type: "still", scene, png, dur, push, what, ...extra });

S.push({ type: "stock", scene: 1, src: SRC.skyline, in: 0.5, dur: 5, what: "Lagos at dusk, slow push-in (stock)", grade: "bluehour", push: 0.04 });
S.push(pending(2, 6, "Tobi in his bedroom studio, headphones on; his phone lies face down beside the keyboard.", "Medium-wide, slow push-in; warm practical light", "Phone face down (screen not seen)", "Tobi", "S02_tobi-studio.mov"));
S.push(pending(3, 5, "Ada folds coral fabric, seen from the street through her shop window in Yaba.", "Exterior through the glass, medium; shop name visible", "None", "Ada", "S03_ada-shop-window.mov"));
S.push({ type: "split", scene: 4, dur: 5,
  left: pending(4, 5, "Kemi on a Lagos bus at dusk, looking out of the window.", "LEFT half of a split screen: frame for 960×1080 (centre-weighted), medium close", "None (phone in hand, screen not seen)", "Kemi", "S04_kemi-bus.mov"),
  right: { type: "stock", src: SRC.rain, in: 1.0, dur: 5, what: "Rainy window abroad, night (stock; Bisi's side)", grade: "coolnight" } });
S.push(pending(5, 5, "Femi photographs a street corner, alone.", "Medium, handheld; Femi slightly off-centre", "Camera, not phone", "Femi", "S05_femi-street.mov"));
S.push(pending(6, 2, "Macro: a hand turns a phone over; the thumb taps the Amigo World icon.", "Macro, top-down, shallow focus", "iPhone Home Screen with the Amigo World icon (Add to Home Screen from the recording Preview); dark mode, 9:41", "Femi's hand", "S06_macro-icon-tap.mov"));
S.push({ type: "group", xf: 10, items: [
  clip(6, "s06", 0.1, 1.5, 1.4, "App opens: splash"), // starts 0.1 s in: the recording's first 2 frames are a blank white page
  still(6, `${AA}/composite-home-feed-femi.png`, 2.0, 0.02, "Home feed (composited still, C1)"),
] });
S.push(pending(7, 3, "Golden hour on a Lagos rooftop: Kemi and friends, suya on the table; Kemi types her caption.", "Wide establishing → over-the-shoulder on Kemi's phone", "Kemi's New post composer: \"Rooftop, suya and my people. Lagos sunsets never miss. 🧡\"", "Kemi + 3–4 friends", "S07_rooftop-kemi-types.mov"));
S.push(clip(7, "s07p", 3.0, 8.5, 4.0, "New post lands in the feed", { patches: [logo(108, 1284, 7.62), logo(108, 1824, 7.62), logo(110, 2370, 7.62, 999, 2322, 2380)] }));
S.push(clip(7, "s07m", 9.7, 11.7, 2.0, "Her Moment, viewed"));
S.push(pending(8, 2, "Femi at a café, scrolling on his phone.", "Medium close, window light", "Femi's Explore page (search field)", "Femi", "S08_femi-cafe.mov"));
S.push(clip(8, "s08", 1.0, 8.5, 6.0, "Explore → search → Seyi → Follow Back", { patches: [logo(108, 1976, 0, 3.3)] }));
S.push(pending(9, 1, "Night, abroad: Bisi sends a message.", "Close-up, face lit by the phone; rain on the window behind", "Bisi's chat with Kemi, sending \"Found a Nigerian shop by the station. PLANTAIN. I almost cried 😭\"", "Bisi", "S09_bisi-sends.mov"));
S.push(clip(9, "bisi", 7.0, 10.5, 1.5, "Bisi sends", { masks: BISI }));
S.push(clip(9, "kemi", 10.0, 19.5, 4.5, "Kemi: message arrives → ❤️ → swipe-reply", { masks: KEMI }));
S.push(pending(9, 1, "Kemi laughs on the bus as it passes Ada's shop.", "Through the bus window; Ada's shop sign passes behind Kemi", "Kemi's chat with Bisi (not readable)", "Kemi (Ada's shop in background)", "S09_kemi-laughs-bus.mov"));
S.push(pending(10, 4, "Ada and a customer hold up a phone at the shop counter.", "Medium two-shot across the counter; phone toward camera", "Ada's Atelier business page (show composite-frame-1.png full screen on the phone)", "Ada + customer", "S10_ada-customer.mov"));
S.push({ type: "group", xf: 10, items: [
  still(10, "ADA_T1", 2.2, 0.08, "Ada's Atelier: business page"),
  still(10, "ADA_T2", 2.2, 0, "Ada's Atelier: posts"),
] });
S.push(pending(11, 1, "Tobi posts his request from the studio.", "Close on Tobi's hands and screen", "Help Hub: \"Listen to my new song — does the chorus land?\" request", "Tobi", "S11_tobi-posts.mov"));
S.push(clip(11, "femi11", 2.5, 4.7, 2.2, "Femi: Help out"));
S.push(clip(11, "ada11", 5.0, 10.5, 2.2, "Ada: confirms she helped"));
S.push(clip(11, "tobi11", 1.5, 7.0, 3.6, "Tobi: notification → 2 helpers + feedback"));
S.push(clip(12, "cd", 36.5, 37.5, 1.0, "World countdown", { masks: CD }));
S.push(pending(12, 0.5, "Kemi, Ada, Tobi and Bisi glance down at their phones (quick cuts).", "Four tight singles, 12 frames each are enough", "Golden Hour Lagos World countdown", "Kemi, Ada, Tobi, Bisi", "S12_glances.mov"));
S.push(clip(12, "cd", 38.0, 39.5, 1.5, "World countdown", { masks: CD }));
S.push(pending(12, 0.5, "Phones light up in four places at once.", "Inserts of phone screens in hand, four locations", "Golden Hour Lagos World going LIVE", "Hands only", "S12_phones-light-up.mov"));
S.push(clip(12, "cd", 40.0, 41.5, 1.5, "LIVE", { masks: CD }));
S.push(still(12, "ENTRY", 1.5, 0.02, "Femi's entry with his photo (C3c)", { placeholderTag: true }));
S.push(clip(12, "react", 9.0, 11.6, 1.3, "Live reaction banners", { frame: "wide", crop: [0, 0, 1180, 700] }));
S.push(clip(12, "chat", 12.0, 20.0, 3.2, "Live room chat"));
S.push(pending(13, 3.5, "Match cut from Femi's entry photo: the same rooftop at sunset; crane up over the friends together.", "Wide, crane/drone rising; same angle as Femi's photo", "None", "Whole cast", "S13_rooftop-crane.mov"));
S.push(clip(13, "kemi", 20.0, 23.0, 3.0, "Kemi's phone: Bisi's message", { masks: KEMI }));
S.push(pending(13, 2.5, "Wide: the group laughing, Lagos glowing behind them.", "Wide, golden-hour backlight", "None", "Whole cast", "S13_rooftop-wide.mov"));
S.push({ type: "group", xf: 10, items: [{ type: "card", png: "end0", dur: 3.2 }, { type: "card", png: "end1", dur: 3.4 }, { type: "card", png: "end2", dur: 6.2 }] });

// Licensed fills for shots not yet filmed with our cast (approved 4 Nov 2026: stock or graphic treatments that keep the
// story and timing). Stock shows places, hands and silhouettes only: never presented as our cast, no identifiable
// faces (Pexels licence: no implied endorsement by people shown). A filmed clip in assets/drop-in/live-action/ still
// takes priority. Credits: assets/stock/STOCK-CREDITS.json.
const ST = `${FA}/stock`;
const v = (file, inp, extra = {}) => ({ kind: "video", src: `${ST}/${file}`, in: inp, grade: "natural", ...extra });
const FILL = {
  "S02_tobi-studio.mov": v("pexels-31050551-studio-producer_somogro-bangladesh.mp4", 0.0, { grade: "night" }),
  "S03_ada-shop-window.mov": v("pexels-6841969-hands-folding-cloth_teona-swift.mp4", 1.5, { vcrop: 0.5, grade: "golden" }),
  "S04_kemi-bus.mov": v("pexels-27706413-lagos-danfo-sunset_shedrack-salami.mp4", 0.0, { hcrop: 0.32, grade: "golden" }),
  "S05_femi-street.mov": v("pexels-32896750-photographer-hands-city_ahmed.mp4", 0.8, { vcrop: 0.55 }),
  "S06_macro-icon-tap.mov": { kind: "gfx", name: "s06-home-tap" },
  "S07_rooftop-kemi-types.mov": v("pexels-39416582-friends-rooftop-sunset_dara-visuals.mp4", 24.0, { grade: "golden" }),
  "S08_femi-cafe.mov": v("pexels-5075206-cafe-phone-hands_cottonbro.mp4", 3.0),
  "S09_bisi-sends.mov": v("pexels-33942937-hands-phone-dark_ozgur-surmeli.mp4", 2.0, { grade: "night" }),
  "S09_kemi-laughs-bus.mov": v("pexels-27706275-lagos-road-danfos_shedrack-salami.mp4", 6.0, { grade: "golden" }),
  "S10_ada-customer.mov": { kind: "photo", src: `${ST}/pexels-30698866-fabric-shop_mohamed-hamdi.jpg`, push: 0.06 },
  "S11_tobi-posts.mov": v("pexels-31050551-studio-producer_somogro-bangladesh.mp4", 12.0, { grade: "night" }),
  "S12_glances.mov": v("pexels-6940967-hands-phone-night_cottonbro.mp4", 3.0, { grade: "night" }),
  "S12_phones-light-up.mov": v("pexels-33942937-hands-phone-dark_ozgur-surmeli.mp4", 9.0, { grade: "night" }),
  "S13_rooftop-crane.mov": v("pexels-31661123-lagos-sunset-aerial_vitalis-nwenyi.mp4", 0.0, { grade: "golden" }),
  "S13_rooftop-wide.mov": v("pexels-31948670-friends-sparklers-sunset_vitaly-gariev.mp4", 2.0, { grade: "golden" }),
};
for (const s of S) for (const p of s.type === "split" ? [s.left] : s.type === "pending" ? [s] : []) p.fill = FILL[p.file] ?? null;

// Frame-accurate layout.
let t = 0, n = 0;
for (const s of S) {
  const len = s.type === "group" ? s.items.reduce((a, i) => a + i.dur, 0) - 0.4 * (s.items.length - 1) : s.dur;
  s.f0 = Math.round(t * FPS); s.f1 = Math.round((t + len) * FPS); s.frames = s.f1 - s.f0; t += len;
  const items = s.type === "group" ? s.items : [s];
  for (const i of items) { i.id = `${String(n++).padStart(2, "0")}_s${String(i.scene ?? 14).padStart(2, "0")}_${i.type}`; i.frames = Math.round(i.dur * FPS); }
  if (s.type === "group") { // last item absorbs rounding so group length == f1-f0
    const sum = s.items.reduce((a, i) => a + i.frames, 0) - s.xf * (s.items.length - 1);
    s.items.at(-1).frames += s.frames - sum;
  }
}
if (S.at(-1).f1 !== 2520) throw new Error(`total ${S.at(-1).f1} frames, expected 2520`);
writeFileSync(new URL("./timeline.json", import.meta.url), JSON.stringify(S, null, 1));
console.log(`timeline: ${S.length} events, ${S.at(-1).f1} frames (${S.at(-1).f1 / FPS}s)`);
