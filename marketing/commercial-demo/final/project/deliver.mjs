// Writes the editable FCPXML (Final Cut Pro / DaVinci Resolve / Premiere via import), the filming checklist,
// and muxes the master. Run after build.mjs and audio.mjs.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
const P = new URL(".", import.meta.url).pathname, F = new URL("..", import.meta.url).pathname;
const TL = JSON.parse(readFileSync(`${P}timeline.json`, "utf8"));
const SH = JSON.parse(readFileSync(`${F}shots/_shots.json`, "utf8"));
const x = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const tc = (f) => `${Math.floor(f / 24 / 60)}:${String(Math.floor(f / 24) % 60).padStart(2, "0")}`;
const url = (p) => "file://" + encodeURI(p);

// ---- FCPXML: one clip per shot on the spine (cross-dissolves are baked into their shot files), stems below.
let res = `<format id="r0" name="FFVideoFormat1080p24" frameDuration="1/24s" width="1920" height="1080" colorSpace="1-1-1 (Rec. 709)"/>\n`;
let spine = "";
SH.forEach((s, i) => {
  const name = s.file.split("/").pop().replace(".mp4", "");
  res += `<asset id="v${i}" name="${x(name)}" start="0s" duration="${s.frames}/24s" hasVideo="1" videoSources="1" format="r0"><media-rep kind="original-media" src="${x(url(s.file))}"/></asset>\n`;
  const conn = i === 0 ? ["VO", "MUSIC", "SFX"].map((st, k) => `<asset-clip ref="s${k}" lane="-${k + 1}" offset="0s" name="${st} stem" duration="2520/24s" start="0s" audioRole="${st === "VO" ? "dialogue" : st === "MUSIC" ? "music" : "effects"}"/>`).join("") : "";
  spine += `<asset-clip ref="v${i}" offset="${s.f0}/24s" name="S${String(s.scene).padStart(2, "0")} · ${x(name)}" duration="${s.frames}/24s" start="0s" format="r0" tcFormat="NDF">${conn}</asset-clip>\n`;
});
["VO", "MUSIC", "SFX"].forEach((st, k) => { res += `<asset id="s${k}" name="${st}" start="0s" duration="2520/24s" hasAudio="1" audioSources="1" audioChannels="2" audioRate="48000"><media-rep kind="original-media" src="${x(url(`${F}stems/${st}.wav`))}"/></asset>\n`; });
writeFileSync(`${P}AmigoWorld_Launch_1m45_v1.fcpxml`, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1.9">\n<resources>\n${res}</resources>\n<library><event name="Amigo World launch commercial"><project name="AmigoWorld_Launch_1m45_v1">
<sequence format="r0" duration="2520/24s" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k"><spine>\n${spine}</spine></sequence></project></event></library>\n</fcpxml>\n`);

// ---- Filming checklist (from the timeline's pending shots).
const rows = [];
for (const s of TL) for (const it of s.type === "split" ? [{ ...s.left, f0: s.f0, frames: s.frames }] : s.type === "pending" ? [s] : []) rows.push(it);
const md = `# Filming checklist: Amigo World launch commercial (1:45)

Live-action shots with our cast, in story order. In the current cut each slot is covered by licensed stock or a graphic (see assets/stock/STOCK-CREDITS.json); filming them is optional and replaces the fill; drop the clip into \`final/assets/drop-in/live-action/\` under the file name given and run \`final/project/rebuild.sh\`. The clip replaces the card automatically, trimmed from its first frame to the length shown, filled to 1920×1080. Shoot 4K 24 fps (or 25) and give 2 s of handles at each end.

Phone screens: use the recording Preview and the cast accounts (see \`raw/README.md\`): dark mode, Do Not Disturb, status bar 9:41.

| # | Time | Len | Scene | Action | Framing | Phone screen | Cast | Drop-in file |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows.map((r, i) => `| ${i + 1} | ${tc(r.f0)} | ${(r.frames / 24).toFixed(1)} s | ${r.scene} | ${r.action} | ${r.framing} | ${r.screen} | ${r.cast} | \`${r.file}\` |`).join("\n")}

**Also needed from the shoot**

- **Femi's rooftop photograph** (scene 12 entry; it must match the scene 13 rooftop for the match cut): landscape JPG, at least 1600 px wide, golden hour, no identifiable faces required. Save it as \`final/assets/drop-in/rooftop-still.jpg\`; it replaces the stock frame in the entry (the scene 13 aerial would then need a matching rooftop shot for the match cut).
- **Optional:** Bisi at her rainy window, to replace the stock window plate on the right of the scene 4 split (currently Pexels footage, no person in shot).

**Audio still to supply**

- **Final narration:** the 17 lines and timecodes in \`final/project/audio.mjs\` (LINES). Deliver one 1:45 WAV aligned to 00:00 as \`final/assets/drop-in/vo/vo-full.wav\`.
- **Final music:** licensed or commissioned track, 1:45, aligned to 00:00, as \`final/assets/drop-in/music/music.wav\`. If it includes Tobi's chorus, written permission for that recording and song is required before release; none is on file.
`;
writeFileSync(`${F}FILMING-CHECKLIST.md`, md);

// ---- Master + release gate. The export's name comes from what the picture actually used (shots/_sources.json,
// written by build.mjs), never from a manual rename:
//   any placeholder card, or a WIP build            → …_WIP-internal-not-for-release.mp4
//   picture clean, temp music still in the mix       → AmigoWorld_Launch_1m45_FINAL_REVIEW.mp4 (for approval, not publication)
//   picture clean, licensed music, Azure narration   → AmigoWorld_Launch_1m45_RELEASE.mp4
// Every review/release export must then pass qc.mjs (OCR for production text, black frames, duration, frames, sync,
// loudness); a failing file is renamed …_QC-FAILED.mp4 and the run exits non-zero.
const D = `${F}assets/drop-in`;
const SRC = JSON.parse(readFileSync(`${F}shots/_sources.json`, "utf8"));
const cards = SRC.slots.filter((x) => x.source === "PLACEHOLDER-CARD");
const azure = existsSync(`${D}/vo/NARRATION.json`) && Array.from({ length: 17 }, (_, i) => `${D}/vo/line${String(i + 1).padStart(2, "0")}.wav`).every(existsSync);
const music = existsSync(`${D}/music/music.wav`);
const clean = SRC.mode !== "wip" && cards.length === 0;
const master = !clean ? "AmigoWorld_Launch_1m45_1080p24_WIP-internal-not-for-release.mp4" : music && azure ? "AmigoWorld_Launch_1m45_RELEASE.mp4" : "AmigoWorld_Launch_1m45_FINAL_REVIEW.mp4";
const tmp = `${F}exports/_candidate.mp4`;
execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", `${F}shots/_picture.mp4`, "-i", `${F}stems/MIX_full.wav`, "-map", "0:v", "-map", "1:a", "-c:v", "copy",
  "-c:a", "aac", "-b:a", "320k", "-ar", "48000", "-movflags", "+faststart", "-metadata", "title=Amigo World — launch commercial (1:45)", tmp], { stdio: "inherit" });
const open = [
  ...cards.map((c) => `scene ${c.scene}: placeholder card (${c.file})`),
  ...(music ? [] : ["final music: temporary synth bed in the mix (licensed or commissioned track needed for release)"]),
  ...(azure ? [] : ["narration: Azure-rendered Abeo lines missing"]),
];
let ok = true;
if (clean) {
  try { execFileSync("node", [`${P}qc.mjs`, tmp], { stdio: "inherit" }); } catch { ok = false; }
}
const final = ok ? master : master.replace(".mp4", "_QC-FAILED.mp4");
execFileSync("mv", ["-f", tmp, `${F}exports/${final}`]);
writeFileSync(`${F}exports/STATUS.txt`, `${final}\n${!clean ? "NOT CLEAN: placeholder visuals present." : ok ? "Visual QC passed: no placeholders or production text." : "QC FAILED: see qc-report.txt."}\n${music && azure ? "Release requirements met." : "Not for publication yet:"}\n${open.map((x) => `- ${x}`).join("\n")}\n`);
console.log(`delivered: FCPXML (${SH.length} shots + 3 stems), checklist (${rows.length} shots), ${final}`);
if (!ok) process.exit(1);
