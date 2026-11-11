// Renders approved narration lines with Azure AI Speech (paid S0 resource; key read from the git-ignored secrets file,
// never printed). Voice settings live in VOICES below.
//
//   node azure-tts.mjs <voice>                         dry run: SSML for line 1 + billable characters. No network call.
//   node azure-tts.mjs <voice> --test --render          renders lines 6, 9, 14 only → voiceover/azure-<voice>/test/ (+ in-context test reel)
//   node azure-tts.mjs <voice> --render                 renders all 17 → voiceover/azure-<voice>/raw/, polishes them into
//                                                      assets/drop-in/vo/ (previous lines are backed up first; nothing is deleted)
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
const F = new URL("..", import.meta.url).pathname;
const SECRETS = "/Users/mac/amigo-world/secrets/azure-speech.env";
const VOICES = {
  // Approved 4 Nov 2026 (current backup in voiceover/azure-abeo/approved-lines/).
  abeo: { name: "en-NG-AbeoNeural", lang: "en-NG", rate: "-10%", pitch: "-6Hz" },
  // American direction: warm, confident, deep, unhurried.
  andrew: { name: "en-US-AndrewMultilingualNeural", lang: "en-US", rate: "-6%", pitch: "-4%" },
  "andrew-warm": { name: "en-US-AndrewMultilingualNeural", lang: "en-US", rate: "-6%", pitch: "-4%", style: "empathetic", degree: "1.2" },
};
const LINES = ["The world is full of people…", "with ideas waiting to be heard.", "With work worth finding.", "With friends a world away.",
  "And people still looking for the ones who get them.", "Imagine one place where all of it comes together.", "Share the moments that matter.",
  "Find the people who see the world the way you do.", "Talk freely, in messages only you and the people you're talking to can read.",
  "Show what your business does, so the people nearby can find you.", "Ask your community for a hand, and give one back.",
  "And when the moment comes…", "everyone shows up.", "Live. Together. In the same World.", "This is Amigo World.",
  "Your world, together.", "Reserve your username today."];
const T = [5, 8, 12, 17, 22, 27, 32, 40, 48, 56, 64, 73, 76, 79, 87, 96, 100];
const TEST = [6, 9, 14];
const key = process.argv[2], V = VOICES[key];
if (!V) { console.error(`usage: node azure-tts.mjs <${Object.keys(VOICES).join("|")}> [--test] [--render]`); process.exit(2); }
const test = process.argv.includes("--test"), render = process.argv.includes("--render");
const which = test ? TEST : LINES.map((_, i) => i + 1);
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&apos;");
const ssml = (t) => {
  const pro = `<prosody rate="${V.rate}" pitch="${V.pitch}">${esc(t)}</prosody>`;
  const body = V.style ? `<mstts:express-as style="${V.style}" styledegree="${V.degree ?? 1}">${pro}</mstts:express-as>` : pro;
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${V.lang}"><voice name="${V.name}">${body}</voice></speak>`;
};
// Same polish as the approved narration (trim, warmth, presence, soft top, small room, 0.25 s tail).
const POL = "silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse,highpass=f=70,equalizer=f=170:t=q:w=1:g=2.5,equalizer=f=3200:t=q:w=1.2:g=1.5,equalizer=f=7500:t=q:w=1:g=-2,aecho=0.85:0.3:22|37:0.10|0.06,apad=pad_dur=0.25,aresample=48000";
const chars = which.reduce((a, n) => a + LINES[n - 1].length, 0);
if (!render) {
  console.log(`Dry run: ${V.name}${V.style ? ` (style ${V.style})` : ""}, rate ${V.rate}, pitch ${V.pitch}. Lines ${test ? TEST.join(", ") : "1–17"}: ${chars} billable characters ≈ US$${(chars * 15 / 1e6).toFixed(4)} at $15/1M.`);
  console.log(ssml(LINES[which[0] - 1]));
  process.exit(0);
}
const env = Object.fromEntries(readFileSync(SECRETS, "utf8").split("\n").filter((l) => /^\s*AZURE_SPEECH_(KEY|REGION)\s*=/.test(l))
  .map((l) => { const [k, ...v] = l.split("="); return [k.trim(), v.join("=").trim().replace(/^["']|["']$/g, "")]; }));
const DIR = `${F}voiceover/azure-${key}`, RAW = `${DIR}/${test ? "test" : "raw"}`, DROP = `${F}assets/drop-in/vo`;
mkdirSync(RAW, { recursive: true });
if (!test) { // back up whatever narration is in place before replacing it (never deleted)
  const bk = `${F}voiceover/backup-before-${key}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}`;
  mkdirSync(bk, { recursive: true });
  for (const f of readdirSync(DROP).filter((f) => /^line\d\d\.wav$/.test(f))) copyFileSync(`${DROP}/${f}`, `${bk}/${f}`);
  console.log(`previous lines backed up to ${bk.replace(F, "final/")}`);
}
const log = [];
for (const n of which) {
  const id = String(n).padStart(2, "0");
  const r = await fetch(`https://${env.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: { "Ocp-Apim-Subscription-Key": env.AZURE_SPEECH_KEY, "Content-Type": "application/ssml+xml", "X-Microsoft-OutputFormat": "riff-48khz-16bit-mono-pcm", "User-Agent": "amigo-world-commercial" },
    body: ssml(LINES[n - 1]),
  });
  if (!r.ok) throw new Error(`Azure returned ${r.status} for line ${id}: ${(await r.text()).slice(0, 200)}`);
  writeFileSync(`${RAW}/line${id}.wav`, Buffer.from(await r.arrayBuffer()));
  const out = test ? `${RAW}/line${id}_polished.wav` : `${DROP}/line${id}.wav`;
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", `${RAW}/line${id}.wav`, "-af", POL, "-ac", "1", "-c:a", "pcm_s24le", out]);
  log.push({ line: n, text: LINES[n - 1], date: r.headers.get("date") });
}
writeFileSync(`${DIR}/PROVENANCE${test ? "-test" : ""}.json`, JSON.stringify({ service: "Azure AI Speech (text to speech, REST)", region: env.AZURE_SPEECH_REGION,
  voice: V.name, style: V.style ?? null, prosody: { rate: V.rate, pitch: V.pitch }, outputFormat: "riff-48khz-16bit-mono-pcm", characters: chars, renderedAt: new Date().toISOString(), lines: log }, null, 1));
if (!test) { // record exactly which files are the live narration, so QC can prove they're this Azure render
  const md5 = (f) => execFileSync("md5", ["-q", f]).toString().trim();
  writeFileSync(`${DROP}/NARRATION.json`, JSON.stringify({ service: "Azure AI Speech", voice: V.name, style: V.style ?? null, prosody: { rate: V.rate, pitch: V.pitch },
    region: env.AZURE_SPEECH_REGION, provenance: `voiceover/azure-${key}/PROVENANCE.json`, renderedAt: new Date().toISOString(),
    lines: Object.fromEntries(which.map((n) => { const id = String(n).padStart(2, "0"); return [`line${id}.wav`, md5(`${DROP}/line${id}.wav`)]; })) }, null, 1));
}
if (test) { // in-context reel: the three lines at their real timecodes over the commercial's music and effects
  const S = `${F}stems`, d = (n) => T[n - 1];
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", `${S}/MUSIC.wav`, "-i", `${S}/SFX.wav`, ...TEST.flatMap((n) => ["-i", `${RAW}/line${String(n).padStart(2, "0")}_polished.wav`]), "-filter_complex",
    `${TEST.map((n, i) => `[${i + 2}]volume=1.6,adelay=${d(n) * 1000}:all=1[v${i}]`).join(";")};${TEST.map((_, i) => `[v${i}]`).join("")}amix=inputs=3:normalize=0,pan=stereo|c0=c0|c1=c0,apad[vo];[vo]asplit[v1][sc];[0]volume=0.5[mu];[mu][sc]sidechaincompress=threshold=0.04:ratio=4:attack=30:release=400[dk];[v1][dk][1]amix=inputs=3:normalize=0,atrim=0:105[m];` +
    `[m]asplit=3[a][b][c];[a]atrim=25.5:33,asetpts=N/SR/TB,afade=t=in:d=0.3,afade=t=out:st=7.2:d=0.3[x];[b]atrim=46.5:54,asetpts=N/SR/TB,afade=t=in:d=0.3,afade=t=out:st=7.2:d=0.3[y];[c]atrim=77.5:85.5,asetpts=N/SR/TB,afade=t=in:d=0.3,afade=t=out:st=7.7:d=0.3[z];[x][y][z]concat=n=3:v=0:a=1,alimiter=limit=0.89[o]`,
    "-map", "[o]", "-c:a", "pcm_s24le", `${F}voiceover/test_${key}.wav`]);
  console.log(`test reel: final/voiceover/test_${key}.wav`);
}
console.log(`Rendered ${which.length} line(s) with ${V.name} (${chars} characters).`);
