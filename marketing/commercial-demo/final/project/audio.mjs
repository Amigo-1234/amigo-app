// Builds the three stems (VO, music, SFX; 48 kHz 24-bit stereo, 1:45) into ../stems/ and the mixes.
// Uses approved assets when they exist:
//   ../assets/drop-in/vo/vo-full.wav        narration, 1:45 long, aligned to 00:00 (otherwise: scratch macOS voice, TEMP)
//   ../assets/drop-in/music/music.wav        licensed music, 1:45, aligned to 00:00 (otherwise: synth temp bed, TEMP)
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
const P = new URL(".", import.meta.url).pathname, A = `${P}../assets/drop-in`, ST = `${P}../stems`, W = `${P}../stems/_work`;
mkdirSync(W, { recursive: true });
const ff = (a) => execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...a], { stdio: "inherit" });
const OUT = ["-ar", "48000", "-ac", "2", "-c:a", "pcm_s24le"];
const D = 105, BAR = 240 / 104, BEAT = 60 / 104;
const gen = (name, expr, d, af = "anull") => { ff(["-f", "lavfi", "-i", `aevalsrc='${expr}':s=48000:d=${d}`, "-af", af, "-ac", "1", `${W}/${name}.wav`]); return `${W}/${name}.wav`; };
// Places mono/stereo clips at times (s) with gains into one 1:45 stereo file.
function place(out, items) {
  const ins = [], f = [], l = [];
  items.forEach(([file, t, g, pan = 0], i) => {
    ins.push("-i", file);
    const L = (Math.min(1, 1 - pan)).toFixed(2), R = (Math.min(1, 1 + pan)).toFixed(2);
    f.push(`[${i}:a]aformat=sample_rates=48000:channel_layouts=mono,volume=${g},pan=stereo|c0=${L}*c0|c1=${R}*c0,adelay=${Math.round(t * 1000)}|${Math.round(t * 1000)}[a${i}]`); l.push(`[a${i}]`);
  });
  f.push(`${l.join("")}amix=inputs=${l.length}:normalize=0:duration=longest,apad,atrim=0:${D}[o]`);
  ff([...ins, "-filter_complex", f.join(";"), "-map", "[o]", ...OUT, out]);
}

// ---------- VO ----------
const LINES = [[5, "The world is full of people…"], [8, "with ideas waiting to be heard."], [12, "With work worth finding."], [17, "With friends a world away."],
  [22, "And people still looking for the ones who get them."], [27, "Imagine one place where all of it comes together."], [32, "Share the moments that matter."],
  [40, "Find the people who see the world the way you do."], [48, "Talk freely, in messages only you and the people you're talking to can read."],
  [56, "Show what your business does, so the people nearby can find you."], [64, "Ask your community for a hand, and give one back."],
  [73, "And when the moment comes…"], [76, "everyone shows up."], [79, "Live. Together. In the same World."], [87, "This is Amigo World."],
  [96, "Your world, together."], [100, "Reserve your username today."]];
// Approved human VO: either one full 1:45 track (vo-full.wav) or one file per line (line01.wav … line17.wav),
// each placed at its locked timecode. The scratch voice is used only when neither exists.
const lineFiles = LINES.map((_, i) => `${A}/vo/line${String(i + 1).padStart(2, "0")}.wav`);
const voLines = lineFiles.every((f) => existsSync(f));
const voFinal = existsSync(`${A}/vo/vo-full.wav`) || voLines;
if (existsSync(`${A}/vo/vo-full.wav`)) ff(["-i", `${A}/vo/vo-full.wav`, "-af", `apad,atrim=0:${D}`, ...OUT, `${ST}/VO.wav`]);
else if (voLines) {
  place(`${W}/vo_raw.wav`, LINES.map(([t], i) => [lineFiles[i], t, 1.0]));
  ff(["-i", `${W}/vo_raw.wav`, "-af", "highpass=f=70,acompressor=threshold=-18dB:ratio=2.5:attack=8:release=120", "-c:a", "pcm_f32le", `${W}/vo_c.wav`]);
  // Speech-gated loudness (EBU R128 gating ignores the gaps) brought to -18 LUFS, so dialogue sits clear of the bed.
  const i = parseFloat(execFileSync("sh", ["-c", `ffmpeg -i "${W}/vo_c.wav" -af ebur128 -f null - 2>&1 | grep -E "^ +I:" | tail -1`]).toString().match(/-?[\d.]+/)[0]);
  ff(["-i", `${W}/vo_c.wav`, "-af", `volume=${(-18 - i).toFixed(2)}dB,alimiter=limit=0.89:level=disabled`, ...OUT, `${ST}/VO.wav`]);
}
else {
  const items = LINES.map(([t, txt], i) => { const f = `${W}/vo${i}.aiff`; execFileSync("say", ["-v", "Daniel", "-r", "172", "-o", f, txt]); return [f, t, 1.0]; });
  place(`${W}/vo_raw.wav`, items);
  ff(["-i", `${W}/vo_raw.wav`, "-af", "highpass=f=90,acompressor=threshold=-20dB:ratio=3:attack=5:release=80,equalizer=f=3000:t=q:w=1:g=2", ...OUT, `${ST}/VO.wav`]);
}

// ---------- Music ----------
const musicFinal = existsSync(`${A}/music/music.wav`);
if (musicFinal) ff(["-i", `${A}/music/music.wav`, "-af", `apad,atrim=0:${D}`, ...OUT, `${ST}/MUSIC.wav`]);
else {
  // TEMP bed in G major, 104 BPM: G–Em–C–D, one chord per bar, soft attack per bar; rhythm from 0:26; one bar of
  // silence before LIVE (74.05–76.35); opens out 1:27; G–B–D–G motif on the end card.
  const ch = (i) => [`if(eq(${i},0),196,if(eq(${i},1),164.81,if(eq(${i},2),130.81,146.83)))`, `if(eq(${i},0),246.94,if(eq(${i},1),196,if(eq(${i},2),164.81,185)))`, `if(eq(${i},0),293.66,if(eq(${i},1),246.94,if(eq(${i},2),196,220)))`];
  const idx = `mod(floor(t/${BAR}),4)`, x = `mod(t,${BAR})`, env = `min(1,${x}/0.35)*min(1,(${BAR}-${x})/0.25)`;
  const [a, b, c] = ch(idx);
  const pad = gen("pad", `(0.05*sin(2*PI*(${a})*t)+0.04*sin(2*PI*(${b})*t)+0.04*sin(2*PI*(${c})*t)+0.035*sin(2*PI*(${a})/2*t)+0.012*sin(2*PI*(${a})*2.003*t))*${env}*(0.85+0.15*sin(2*PI*0.2*t))`, D,
    `aecho=0.6:0.5:180|370:0.25|0.15,lowpass=f=3500,volume='min(t/3,1)*if(between(t,74.05,76.35),0,1)*if(gte(t,103),(105-t)/2,1)*if(between(t,87,93),1.35,1)':eval=frame`);
  const bass = gen("bass", `0.09*sin(2*PI*(${a})/2*t)*exp(-2.2*mod(t,${BEAT * 2}))`, D, `lowpass=f=400,volume='if(between(t,26,93)*not(between(t,74.05,76.35)),1,0)':eval=frame`);
  const tb = `mod(t,${BEAT})`;
  const kick = gen("kick", `0.5*sin(2*PI*(45*${tb}+(90/28)*(1-exp(-28*${tb}))))*exp(-9*${tb})`, D, `volume='if(between(t,26,93)*not(between(t,74.05,76.35)),1,0)':eval=frame`);
  const hat = gen("hat", `0.12*(random(0)*2-1)*exp(-70*mod(t+${BEAT / 2},${BEAT}))`, D, `highpass=f=7000,volume='if(between(t,26,93)*not(between(t,74.05,76.35)),1,0)':eval=frame`);
  const bright = gen("bright", `0.035*(sin(2*PI*392*t)+sin(2*PI*587.33*t)+0.6*sin(2*PI*783.99*t))*(0.8+0.2*sin(2*PI*0.5*t))`, 18, "aecho=0.6:0.5:240:0.3,volume='min(t/2,1)*if(gte(t,16),(18-t)/2,1)':eval=frame");
  const motif = gen("motif", `0.22*(sin(2*PI*392*t)*exp(-2*t)+gte(t,0.35)*sin(2*PI*493.88*(t-0.35))*exp(-2*(t-0.35))+gte(t,0.7)*sin(2*PI*587.33*(t-0.7))*exp(-2*(t-0.7))+gte(t,1.05)*sin(2*PI*783.99*(t-1.05))*exp(-1.3*(t-1.05)))`, 4, "aecho=0.7:0.6:300|600:0.3|0.2");
  place(`${ST}/MUSIC.wav`, [[pad, 0, 1, -0.15], [pad, 0.012, 1, 0.15], [bass, 0, 1], [kick, 0, 0.8], [hat, 0, 0.6, 0.25], [bright, 87, 0.9], [motif, 101, 1]]);
}

// ---------- SFX (designed here; no third-party audio) ----------
const social = gen("social", "0.35*sin(2*PI*987.77*t)*exp(-5*t)+0.12*sin(2*PI*1975.5*t)*exp(-9*t)", 1.2);
const message = gen("message", "0.3*(sin(2*PI*783.99*t)*exp(-9*t)+gte(t,0.12)*sin(2*PI*1174.66*(t-0.12))*exp(-5*(t-0.12)))", 1.3);
const whoosh = gen("whoosh", "0.5*(random(0)*2-1)*sin(PI*t/0.6)^2", 0.6, "bandpass=f=1200:w=900,volume=1.2");
const swish = gen("swish", "0.4*(random(0)*2-1)*sin(PI*t/0.35)^3", 0.35, "highpass=f=1500,lowpass=f=6000");
const boom = gen("boom", "0.9*sin(2*PI*(38*t+40*(1-exp(-8*t))/8))*exp(-3.2*t)", 2.2, "lowpass=f=180");
const city = gen("city", "0.25*(random(0)*2-1)", 6.5, "lowpass=f=500,highpass=f=40,volume='min(t/0.8,1)*if(gte(t,5.2),(6.5-t)/1.3,1)':eval=frame,aecho=0.8:0.6:400:0.3");
const rain = gen("rain", "0.3*(random(0)*2-1)*(0.7+0.3*gt(random(1),0.995))", 5.6, "highpass=f=1800,lowpass=f=9000,volume='min(t/0.3,1)*if(gte(t,5.1),(5.6-t)/0.5,1)':eval=frame");
const room = gen("room", "0.12*(random(0)*2-1)", 2, "lowpass=f=1200,volume='min(t/0.2,1)*if(gte(t,1.6),(2-t)/0.4,1)':eval=frame");
place(`${ST}/SFX.wav`, [
  [city, 0, 0.7], [rain, 16, 0.3, 0.6],                      // S1 city air; S4 rain on Bisi's window (right side of split)
  [whoosh, 25.75, 0.5], [swish, 28.0, 0.35],                  // S6 phone turn; splash → feed
  [social, 37.37, 0.75],                                      // S7 post lands
  [swish, 49.43, 0.3], [message, 50.5, 0.8],                  // S9 Bisi sends; arrives on Kemi's phone
  [social, 69.5, 0.7],                                        // S11 Tobi's notification
  [boom, 76.35, 0.75],                                        // S12 LIVE (after the one-bar drop)
  [social, 79.55, 0.6, -0.2], [social, 80.0, 0.6, 0.2],       // S12 reaction banners
  [whoosh, 92.6, 0.45],                                       // into the end card
]);

// ---------- Mixes ----------
// Full mix (VO + music ducked under VO + SFX), loudness-normalised for online/social: -14 LUFS, -1 dBTP.
// Static gain to the target (keeps the mix's dynamics), then a true-peak-safe limiter at -1 dBTP.
const mix = (out, withVo, target) => {
  ff(["-i", `${ST}/VO.wav`, "-i", `${ST}/MUSIC.wav`, "-i", `${ST}/SFX.wav`, "-filter_complex",
    withVo
      ? "[0:a]asplit[vo][sc];[1:a]volume=0.5[mu];[mu][sc]sidechaincompress=threshold=0.04:ratio=4:attack=30:release=400[duck];[vo][duck][2:a]amix=inputs=3:normalize=0[o]"
      : "[1:a]volume=0.5[mu];[mu][2:a]amix=inputs=2:normalize=0[o]",
    "-map", "[o]", "-ar", "48000", "-c:a", "pcm_f32le", `${W}/pre.wav`]);
  const i = parseFloat(execFileSync("sh", ["-c", `ffmpeg -i "${W}/pre.wav" -af ebur128 -f null - 2>&1 | grep -E "^ +I:" | tail -1`]).toString().match(/-?[\d.]+/)[0]);
  ff(["-i", `${W}/pre.wav`, "-af", `volume=${(target - i).toFixed(2)}dB,aresample=192000,alimiter=limit=0.85:attack=1:release=60:level=disabled,aresample=48000`, ...OUT, out]);
};
mix(`${ST}/MIX_full.wav`, true, -14);
mix(`${ST}/MIX_music-and-effects.wav`, false, -16);
console.log(`audio done — VO: ${voFinal ? "final" : "SCRATCH (temp)"}, music: ${musicFinal ? "final" : "TEMP bed"}`);
