// Checks the narration in the current build: every line fits its locked window, dialogue sits clearly above the bed,
// and the master meets -14 LUFS / -1 dBTP (±1 LU). Exits non-zero on failure.
import { execFileSync } from "node:child_process";
const F = new URL("..", import.meta.url).pathname;
const T = [5, 8, 12, 17, 22, 27, 32, 40, 48, 56, 64, 73, 76, 79, 87, 96, 100, 104.5];
const sh = (c) => execFileSync("sh", ["-c", c]).toString();
const dur = (f) => parseFloat(sh(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${f}"`));
const lufs = (f, ss, t, pre = "") => parseFloat(sh(`ffmpeg ${ss != null ? `-ss ${ss} -t ${t}` : ""} -i "${f}" -af "${pre}ebur128=peak=true" -f null - 2>&1 | grep -E "^ +I:" | tail -1`).match(/-?[\d.]+/)?.[0] ?? "-70");
const peak = (f) => parseFloat(sh(`ffmpeg -i "${f}" -af ebur128=peak=true -f null - 2>&1 | grep -E "^ +Peak:" | tail -1`).match(/-?[\d.]+/)[0]);
let ok = true;
console.log("line  len    window  VO-vs-bed");
for (let i = 0; i < 17; i++) {
  const n = String(i + 1).padStart(2, "0"), d = dur(`${F}assets/drop-in/vo/line${n}.wav`), w = T[i + 1] - T[i] - 0.2;
  const vo = lufs(`${F}stems/VO.wav`, T[i], Math.max(0.6, d - 0.25)), bed = lufs(`${F}stems/MUSIC.wav`, T[i], Math.max(0.6, d - 0.25), "volume=0.5,");
  const fit = d <= w, clear = vo - bed >= 6;
  ok &&= fit && clear;
  console.log(`${n}   ${d.toFixed(2)}s  ${w.toFixed(1)}s   ${(vo - bed).toFixed(1)} dB ${fit ? "" : " ← too long"}${clear ? "" : " ← not clear of the bed"}`);
}
const master = sh(`ls "${F}exports/"*.mp4`).trim().split("\n")[0];
const I = lufs(master), TP = peak(master), D = dur(master);
console.log(`master: ${master.split("/").pop()}  ${D.toFixed(3)} s  ${I} LUFS  ${TP} dBTP`);
ok &&= Math.abs(D - 105) < 0.01 && Math.abs(I + 14) <= 1 && TP <= -1;
console.log(ok ? "PASS" : "FAIL"); process.exit(ok ? 0 : 1);
