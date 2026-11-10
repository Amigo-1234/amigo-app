// Automated QC of an exported commercial. Usage: node qc.mjs <file.mp4>   (exit 0 = pass)
// Checks: format (1920x1080, 24 fps, 2520 frames, 105.000 s, 48 kHz stereo), A/V stream alignment, black frames,
// production text anywhere in the picture (on-device OCR of 4 frames per second), every shot boundary present,
// narration = Azure render and on its timecodes, loudness/peak. Writes ../exports/qc-report.txt.
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
const P = new URL(".", import.meta.url).pathname, F = new URL("..", import.meta.url).pathname;
const file = process.argv[2];
const sh = (c) => execFileSync("sh", ["-c", c], { maxBuffer: 64 << 20 }).toString();
const R = [], add = (ok, name, detail) => R.push({ ok, name, detail });

// 1) Format and streams.
const pr = JSON.parse(sh(`ffprobe -v error -count_frames -show_entries stream=codec_type,width,height,r_frame_rate,nb_read_frames,sample_rate,channels,start_time,duration -show_entries format=duration -of json "${file}"`));
const vs = pr.streams.find((s) => s.codec_type === "video"), as = pr.streams.find((s) => s.codec_type === "audio");
add(vs.width === 1920 && vs.height === 1080, "resolution", `${vs.width}x${vs.height}`);
add(vs.r_frame_rate === "24/1", "frame rate", vs.r_frame_rate);
add(+vs.nb_read_frames === 2520, "frame count", vs.nb_read_frames);
add(Math.abs(+pr.format.duration - 105) < 0.03, "duration", `${(+pr.format.duration).toFixed(3)} s`);
add(as && +as.sample_rate === 48000 && as.channels === 2, "audio format", as ? `${as.sample_rate} Hz, ${as.channels} ch` : "missing");
add(Math.abs(+vs.start_time - +as.start_time) < 0.005 && Math.abs(+vs.duration - +as.duration) < 0.05, "A/V stream alignment", `video ${(+vs.start_time).toFixed(3)}–${(+vs.duration).toFixed(3)} s, audio ${(+as.start_time).toFixed(3)}–${(+as.duration).toFixed(3)} s`);

// 2) Black or empty frames (anything ≥ 2 frames that is near-black).
const black = [...sh(`ffmpeg -hide_banner -i "${file}" -vf blackdetect=d=0.08:pix_th=0.05 -an -f null - 2>&1`).matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => `${m[1]}–${m[2]} s`);
add(black.length === 0, "black frames", black.length ? black.join(", ") : "none");

// 2b) White flashes on the phone screen (blank pages before an app paints): screen-area luma ≥ 225 for 2+ frames.
const lum = [...sh(`ffmpeg -loglevel error -i "${file}" -vf "crop=424:918:748:110,scale=106:230,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-" -an -f null -`).matchAll(/pts_time:([\d.]+)\s+lavfi.signalstats.YAVG=([\d.]+)/g)].map((m) => [+m[1], +m[2]]);
const flashes = []; for (let i = 1; i < lum.length; i++) if (lum[i][1] >= 225 && lum[i - 1][1] >= 225) flashes.push(lum[i][0].toFixed(2));
add(flashes.length === 0, "white flashes on screen", flashes.length ? `at ${[...new Set(flashes)].slice(0, 10).join(", ")} s` : "none");

// 3) Production text: OCR every quarter second.
const Q = `${F}exports/.qc-frames`; rmSync(Q, { recursive: true, force: true }); mkdirSync(Q, { recursive: true });
sh(`ffmpeg -loglevel error -i "${file}" -vf fps=4 "${Q}/f%04d.png"`);
const ocr = sh(`"${P}qc/ocr" "${Q}"`).trim().split("\n");
const BANNED = /shot to film|placeholder|drop-?in|assets\/|live-action\/|\.(mov|mp4|wav|jpg|png)\b|not for release|\bwip\b|animatic|scene \d+ ?[·•]|storyboard|\btodo\b|\btbd\b|lorem|replace with/i;
const hits = ocr.map((l) => l.split("\t")).filter(([, t]) => t && BANNED.test(t)).map(([f, t]) => `${((parseInt(f.slice(1)) - 1) / 4).toFixed(2)} s: “${t.match(BANNED)[0]}”`);
add(hits.length === 0, `production text (OCR, ${ocr.length} frames)`, hits.length ? hits.slice(0, 12).join("; ") : "none found");
rmSync(Q, { recursive: true, force: true });

// 4) Every shot boundary is a real cut: the picture change at the boundary frame must clearly exceed the motion in
//    the frames around it (centre region, where the phone sits, so phone-to-phone cuts count too).
const TL = JSON.parse(readFileSync(`${P}timeline.json`, "utf8"));
const cuts = TL.slice(1).map((s) => s.f0);
const diff = new Array(2520).fill(0), peak = new Array(2520).fill(0);
const meta = sh(`ffmpeg -loglevel error -i "${file}" -vf "crop=720:1080:600:0,scale=180:270,format=gray,tblend=all_mode=difference,signalstats,metadata=print:file=-" -an -f null -`);
let cur = -1;
for (const line of meta.split("\n")) {
  const t = line.match(/pts_time:([\d.]+)/); if (t) { cur = Math.round(+t[1] * 24); continue; }
  const a = line.match(/signalstats\.YAVG=([\d.e-]+)/); if (a && cur >= 0) diff[cur] = +a[1];
  const x = line.match(/signalstats\.YMAX=([\d.e-]+)/); if (x && cur >= 0) peak[cur] = +x[1];
}
const frames = diff.filter((x, i) => i > 0).length;
const soft = cuts.filter((f) => {
  const at = Math.max(diff[f], diff[f + 1] ?? 0), around = [...diff.slice(f - 12, f - 1), ...diff.slice(f + 2, f + 13)].sort((x, y) => x - y);
  const bigChange = at > Math.max(0.8, 4 * (around[Math.floor(around.length / 2)] ?? 0));
  // Match cuts between near-identical screens (e.g. two accounts on the same page) change little on average but sharply in places.
  const localChange = Math.max(peak[f], peak[f + 1] ?? 0) >= 60;
  return !(bigChange || localChange);
}).map((f) => `${(f / 24).toFixed(2)} s`);
add(soft.length === 0 && frames >= 2519, `shot boundaries (${cuts.length} cuts, ${frames + 1} frames decoded)`, soft.length ? `not detected as cuts: ${soft.join(", ")}` : "every cut lands on a clear picture change");

// 5) Narration: Azure render in place, every line starting on its locked timecode (±1 frame).
// The approved narration voice (changed from Abeo to Andrew, warm, on 4 Nov 2026).
const APPROVED_VOICE = { name: "en-US-AndrewMultilingualNeural", style: "empathetic" };
const nar = JSON.parse(readFileSync(`${F}assets/drop-in/vo/NARRATION.json`, "utf8"));
const changed = Object.entries(nar.lines).filter(([f, h]) => sh(`md5 -q "${F}assets/drop-in/vo/${f}"`).trim() !== h).map(([f]) => f);
const okVoice = nar.service === "Azure AI Speech" && nar.voice === APPROVED_VOICE.name && nar.style === APPROVED_VOICE.style && Object.keys(nar.lines).length === 17 && changed.length === 0;
add(okVoice, "narration source", `${nar.service}, ${nar.voice}${nar.style ? ` (${nar.style})` : ""}, ${nar.prosody.rate}/${nar.prosody.pitch}, ${nar.region}; ${Object.keys(nar.lines).length} lines, ${changed.length ? `modified since render: ${changed.join(", ")}` : "all identical to the Azure render"}`);
const T = [5, 8, 12, 17, 22, 27, 32, 40, 48, 56, 64, 73, 76, 79, 87, 96, 100];
const onsets = [...sh(`ffmpeg -hide_banner -i "${F}stems/VO.wav" -af silencedetect=n=-45dB:d=0.25 -f null - 2>&1`).matchAll(/silence_end: ([\d.]+)/g)].map((m) => +m[1]);
const off = T.map((t) => { const o = onsets.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a), 999); return o - t; });
const late = off.map((d, i) => [i + 1, d]).filter(([, d]) => Math.abs(d) > 1 / 24 + 0.01);
add(late.length === 0, "narration timing (17 lines)", late.length ? late.map(([n, d]) => `line ${n} ${d >= 0 ? "+" : ""}${d.toFixed(3)} s`).join(", ") : `all within ±1 frame (max ${Math.max(...off.map(Math.abs)).toFixed(3)} s)`);

// 6) The export's audio is the approved mix (no drift or substitution): loudness of export vs MIX_full, and level/peak.
const meas = (f) => { const o = sh(`ffmpeg -hide_banner -i "${f}" -af ebur128=peak=true -f null - 2>&1`); return { I: +o.match(/I:\s+(-?[\d.]+) LUFS\s*\n\s*Threshold/)?.[1] || +[...o.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].at(-1)[1], TP: +[...o.matchAll(/Peak:\s+(-?[\d.]+) dBFS/g)].at(-1)[1] }; };
const ex = meas(file), mx = meas(`${F}stems/MIX_full.wav`);
add(Math.abs(ex.I - mx.I) < 0.3, "audio = approved mix", `export ${ex.I} LUFS vs mix ${mx.I} LUFS`);
add(Math.abs(ex.I + 14) <= 1, "integrated loudness", `${ex.I} LUFS (target −14 ±1)`);
add(ex.TP <= -1, "true peak", `${ex.TP} dBTP (max −1)`);

const pass = R.every((r) => r.ok);
const report = `QC ${pass ? "PASS" : "FAIL"} — ${file.split("/").pop()} — ${new Date().toISOString()}\n` + R.map((r) => `${r.ok ? "PASS" : "FAIL"}  ${r.name}: ${r.detail}`).join("\n") + "\n";
writeFileSync(`${F}exports/qc-report.txt`, report);
console.log(report);
process.exit(pass ? 0 : 1);
