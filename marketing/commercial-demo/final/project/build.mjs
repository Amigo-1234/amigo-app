// Renders every shot of the timeline to ../shots/ (1920x1080, 24 fps, H.264 High, frame-exact), then joins them
// into ../shots/_picture.mp4. Usage: node build.mjs [shot-id-prefix]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
const P = new URL(".", import.meta.url).pathname, G = `${P}gfx`, O = `${P}../shots`, ROOT = new URL("../..", import.meta.url).pathname;
const LIVE = `${ROOT}final/assets/drop-in/live-action`;
mkdirSync(O, { recursive: true });
const TL = JSON.parse(readFileSync(`${P}timeline.json`, "utf8"));
const only = process.argv[2];
const PH = { x: 748, y: 52, w: 424, band: 58, foot: 918 };
const WIDE = { x: 370, y: 64, band: Math.round(54 * 1180 / 393) };
const ff = (a) => execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...a], { stdio: "inherit" });
const ENC = ["-c:v", "libx264", "-profile:v", "high", "-preset", "slow", "-crf", "14", "-pix_fmt", "yuv420p", "-r", "24", "-g", "24", "-an", "-movflags", "+faststart"];
const fit = (n) => `fps=24,tpad=stop_mode=clone:stop_duration=3,trim=end_frame=${n},setpts=PTS-STARTPTS`;
const GRADE = {
  bluehour: "eq=brightness=-0.035:contrast=1.07:saturation=0.9:gamma=0.97,colorbalance=rs=-0.04:bs=0.10:rm=-0.03:bm=0.06:rh=0.04:gh=0.01:bh=-0.03,vignette=angle=PI/5",
  coolnight: "eq=contrast=1.05:saturation=0.95,colorbalance=bs=0.06:bm=0.03,vignette=angle=PI/4",
  natural: "eq=contrast=1.04:saturation=1.04,vignette=angle=PI/5",
  golden: "eq=contrast=1.05:saturation=1.08,colorbalance=rm=0.02:rh=0.03:bh=-0.03,vignette=angle=PI/5",
  night: "eq=contrast=1.06:saturation=0.96:gamma=0.97,colorbalance=bs=0.05:bm=0.02,vignette=angle=PI/4",
};
// WIP builds may show marked "shot to film" cards; review/release builds may not (they throw instead).
const MODE = process.env.BUILD_MODE ?? "wip";
export const USED = []; // what each shot actually used, for the release gate
const hexAt = (file, t, x = 590, y = 3) => "0x" + execFileSync("ffmpeg", ["-loglevel", "error", "-ss", String(t), "-i", file, "-frames:v", "1",
  "-vf", `format=rgb24,crop=2:2:${x}:${y},scale=1:1`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).toString("hex");

// Screen content chain for a recorded clip: trim → masks → logo patches → retime. Returns [inputs, filters, label].
function screenChain(s, scale) {
  const inputs = ["-i", s.src], f = [];
  const chain = [`trim=start=${s.in}:end=${s.out}`, "setpts=PTS-STARTPTS"];
  for (const k of s.masks ?? []) {
    const a = Math.max(0, k.from - s.in), b = Math.min(s.out, k.to) - s.in;
    if (b <= 0 || a >= s.out - s.in) continue;
    chain.push(`drawbox=x=${k.x}:y=${k.y}:w=${k.w}:h=${k.h}:color=${k.color}@1:t=fill:enable='between(t,${a.toFixed(3)},${b.toFixed(3)})'`);
  }
  f.push(`[0:v]${chain.join(",")}[v0]`);
  let cur = "v0";
  (s.patches ?? []).forEach((p, i) => {
    inputs.push("-loop", "1", "-i", `${G}/logo128.png`);
    const a = Math.max(0, p.from - s.in), b = Math.min(s.out, p.to) - s.in;
    const top = p.clipTop ?? p.cy - 64, bot = p.clipBottom ?? p.cy + 64;
    f.push(`[${i + 1}:v]format=rgba,crop=128:${bot - top}:0:${top - (p.cy - 64)}[l${i}]`);
    f.push(`[${cur}][l${i}]overlay=${p.cx - 64}:${top}:enable='between(t,${a.toFixed(3)},${b.toFixed(3)})':shortest=1[p${i}]`);
    cur = `p${i}`;
  });
  f.push(`[${cur}]setpts=PTS/${((s.out - s.in) / s.dur).toFixed(5)},${scale},${fit(s.frames)}[scr]`);
  return [inputs, f];
}

function phoneCompose(inputs, f, band, extraOverlay) {
  const n = inputs.filter((x) => x === "-i").length;
  inputs.push("-loop", "1", "-i", `${G}/phone-bg.png`, "-loop", "1", "-i", `${G}/phone-top.png`);
  f.push(`[${n}:v]drawbox=x=${PH.x}:y=${PH.y}:w=${PH.w}:h=${PH.band}:color=${band}@1:t=fill[bg]`,
    `[bg][scr]overlay=${PH.x}:${PH.y + PH.band}:shortest=1[a]`, `[a][${n + 1}:v]overlay=0:0:shortest=1[b]`);
  if (extraOverlay) { inputs.push("-loop", "1", "-i", extraOverlay); f.push(`[b][${n + 2}:v]overlay=0:0:shortest=1[out]`); } else f.push("[b]null[out]");
}

// Priority for a live-action slot: filmed clip (drop-in) → licensed fill (stock/graphic) → marked card (WIP only).
function liveOrCard(s, w = 1920) {
  const file = `${LIVE}/${s.file}`, fit_ = fit(s.frames);
  if (existsSync(file)) { USED.push({ id: s.id, scene: s.scene, source: "filmed", file: s.file }); return [["-i", file], `[0:v]scale=${w}:1080:force_original_aspect_ratio=increase,crop=${w}:1080,setsar=1,${fit_}`]; }
  const F = s.fill;
  if (F?.kind === "video") {
    USED.push({ id: s.id, scene: s.scene, source: "stock", file: F.src.split("/").pop() });
    const pre = F.vcrop != null ? `crop=iw:trunc(iw*9/16/2)*2:0:(ih-iw*9/16)*${F.vcrop},` : "";
    return [["-ss", String(F.in), "-i", F.src], `[0:v]fps=24,${pre}scale=${w}:1080:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:1080:(iw-${w})*${F.hcrop ?? 0.5}:(ih-1080)/2,setsar=1,${GRADE[F.grade]},${fit_}`];
  }
  if (F?.kind === "photo") {
    USED.push({ id: s.id, scene: s.scene, source: "stock", file: F.src.split("/").pop() });
    return [["-loop", "1", "-framerate", "24", "-i", F.src], `[0:v]scale=${w * 2}:2160:force_original_aspect_ratio=increase,crop=${w * 2}:2160,setsar=1,zoompan=z='1+${F.push}*on/${s.frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${w}x1080:fps=24,${GRADE.golden},${fit_}`];
  }
  if (F?.kind === "gfx") {
    USED.push({ id: s.id, scene: s.scene, source: "graphic", file: F.name });
    return [["-framerate", "24", "-i", `${G}/s06/f%04d.png`], `[0:v]scale=${w}:1080,setsar=1,${fit_}`];
  }
  if (MODE !== "wip") throw new Error(`${MODE} build refused: scene ${s.scene} (${s.file}) has no footage and no approved fill; it would show a placeholder card`);
  USED.push({ id: s.id, scene: s.scene, source: "PLACEHOLDER-CARD", file: s.file });
  return [["-loop", "1", "-framerate", "24", "-i", `${G}/pending-${s.id}${w < 1920 ? "-left" : ""}.png`], `[0:v]scale=${w}:1080,setsar=1,${fit_}`];
}

function build(s) {
  const out = `${O}/${s.id}.mp4`;
  if (only && !s.id.startsWith(only)) return out;
  let inputs = [], f = [];
  if (s.type === "card") {
    inputs = ["-loop", "1", "-framerate", "24", "-i", `${G}/${s.png}.png`]; f = [`[0:v]setsar=1,${fit(s.frames)}[out]`];
  } else if (s.type === "pending") {
    const [i, chain] = liveOrCard(s); inputs = i; f = [`${chain}[out]`];
  } else if (s.type === "stock") {
    const z = s.push ?? 0;
    inputs = ["-ss", String(s.in), "-i", s.src];
    f = [`[0:v]fps=24,scale=w='trunc(1920*(1+${z}*t/${s.dur})/2)*2':h=-2:eval=frame:flags=bicubic,crop=1920:1080,setsar=1,${GRADE[s.grade]},${fit(s.frames)}[out]`];
  } else if (s.type === "split") {
    const [i, chain] = liveOrCard({ ...s.left, id: s.id, frames: s.frames }, 960);
    inputs = [...i, "-ss", String(s.right.in), "-i", s.right.src];
    f = [`${chain}[l]`, `[1:v]fps=24,scale=960:-2,crop=960:1080,setsar=1,${GRADE[s.right.grade]},${fit(s.frames)}[r]`,
      "[l][r]hstack,drawbox=x=958:y=0:w=4:h=1080:color=0x08070b@1:t=fill[out]"];
  } else if (s.type === "clip" && s.frame === "wide") {
    [inputs, f] = screenChain(s, "crop=1180:700:0:0");
    inputs.push("-loop", "1", "-i", `${G}/wide-bg.png`, "-loop", "1", "-i", `${G}/wide-top.png`);
    const n = inputs.filter((x) => x === "-i").length - 2;
    f.push(`[${n}:v]drawbox=x=${WIDE.x}:y=${WIDE.y}:w=1180:h=${WIDE.band}:color=${hexAt(s.src, (s.in + s.out) / 2)}@1:t=fill[bg]`,
      `[bg][scr]overlay=${WIDE.x}:${WIDE.y + WIDE.band}:shortest=1[a]`, `[a][${n + 1}:v]overlay=0:0:shortest=1[out]`);
  } else if (s.type === "clip") {
    [inputs, f] = screenChain(s, `scale=${PH.w}:${PH.foot}:flags=lanczos`);
    phoneCompose(inputs, f, hexAt(s.src, (s.in + s.out) / 2));
  } else if (s.type === "still") {
    const png = s.png === "ENTRY" ? `${G}/entry-composite.png` : s.png === "ADA_T1" ? `${G}/ada-T1.png` : s.png === "ADA_T2" ? `${G}/ada-T2.png` : s.png;
    inputs = ["-loop", "1", "-framerate", "24", "-i", png];
    f = [`[0:v]scale=${PH.w * 2}:${PH.foot * 2}:flags=lanczos,setsar=1,zoompan=z='1+${s.push}*on/${s.frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${PH.w}x${PH.foot}:fps=24,${fit(s.frames)}[scr]`];
    phoneCompose(inputs, f, "0x0c0c0e", null);
  }
  ff([...inputs, "-filter_complex", f.join(";"), "-map", "[out]", "-frames:v", String(s.frames), ...ENC, out]);
  return out;
}

const parts = [];
for (const s of TL) {
  if (s.type !== "group") { parts.push(build(s)); continue; }
  const files = s.items.map(build);
  const out = `${O}/${s.items[0].id}+xfade.mp4`;
  if (!only || s.items.some((i) => i.id.startsWith(only))) {
    const f = []; let cur = "0:v", off = 0;
    s.items.forEach((it, i) => {
      if (i === 0) { off = (it.frames - s.xf) / 24; return; }
      f.push(`[${cur}][${i}:v]xfade=transition=fade:duration=${(s.xf / 24).toFixed(4)}:offset=${off.toFixed(4)}[x${i}]`);
      cur = `x${i}`; off += (it.frames - s.xf) / 24;
    });
    ff([...files.flatMap((x) => ["-i", x]), "-filter_complex", f.join(";"), "-map", `[${cur}]`, "-frames:v", String(s.frames), ...ENC, out]);
  }
  parts.push(out);
}
if (only) process.exit(0);
writeFileSync(`${O}/_list.txt`, parts.map((p) => `file '${p}'`).join("\n"));
// Join as ONE uniform stream (re-encoded, Rec. 709 tagged): stream-copying shots from different sources leaves
// parameter changes at the joins, which make decoders reset mid-file.
ff(["-f", "concat", "-safe", "0", "-i", `${O}/_list.txt`, "-vf", "setsar=1,format=yuv420p", "-c:v", "libx264", "-profile:v", "high", "-preset", "slow", "-crf", "14",
  "-r", "24", "-g", "48", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv", "-frames:v", "2520", "-an", "-movflags", "+faststart", `${O}/_picture.mp4`]);
writeFileSync(`${O}/_sources.json`, JSON.stringify({ mode: MODE, slots: USED }, null, 1));
writeFileSync(`${O}/_shots.json`, JSON.stringify(TL.map((s, i) => ({ file: parts[i], f0: s.f0, frames: s.frames, scene: s.scene ?? s.items?.[0]?.scene ?? 14, type: s.type })), null, 1));
console.log("picture done");
