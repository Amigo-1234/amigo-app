/**
 * Client-side image processing for uploads.
 *
 * Every photo is decoded and re-encoded through a canvas before upload, which:
 *   - applies EXIF orientation (so sideways phone photos come out upright),
 *   - strips all metadata (EXIF, GPS location, camera serials),
 *   - caps dimensions and file size so uploads are fast on mobile data.
 * Animated GIFs are the exception: re-encoding would freeze them, so they pass
 * through untouched within a smaller size limit.
 */

export const IMAGE_LIMITS = {
  /** Largest file someone can pick. Phones produce 3–12 MB; 25 MB leaves room for big DSLR JPEGs. */
  maxInputBytes: 25 * 1024 * 1024,
  /**
   * Longest edge after resizing: sharp when a photo is opened full screen on a
   * current phone (a portrait Moment fills ~2500 px of height). Feeds and grids
   * load the 1080 px copy (makeSmallCopy), so this size only downloads on open.
   */
  maxEdge: 2048,
  /** Size we aim for (quality drops a little before dimensions do). */
  targetBytes: 600 * 1024,
  /** Hard ceiling for the processed upload. */
  maxOutputBytes: 3 * 1024 * 1024,
  quality: 0.82,
  minQuality: 0.6,
  maxGifBytes: 8 * 1024 * 1024,
} as const;

const DECODABLE = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/bmp", "image/heic", "image/heif"]);
const isHeic = (type: string, name: string) => /heic|heif/.test(type) || /\.(heic|heif)$/i.test(name);

export class ImageError extends Error {}

export interface ProcessedImage {
  blob: Blob;
  width: number;
  height: number;
  mimeType: string;
}

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new ImageError("We couldn't process that image."))), type, quality),
  );
}

/**
 * iOS keeps canvas memory until garbage collection and caps it per page; past
 * the cap new canvases silently draw nothing. Shrinking a canvas we're done
 * with hands its memory back at once.
 */
export function releaseCanvas(canvas: HTMLCanvasElement) {
  canvas.width = 0;
  canvas.height = 0;
}

/** A decoded photo, upright (EXIF orientation applied), in one of two forms. */
type Source = { draw: CanvasImageSource; width: number; height: number; close: () => void };

async function viaBitmap(file: Blob): Promise<Source> {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  return { draw: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
}

/** The <img> decoder: on iOS it downsamples very large photos instead of running out of memory. */
async function viaElement(file: Blob): Promise<Source> {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  try {
    await img.decode();
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  if (!img.naturalWidth || !img.naturalHeight) {
    URL.revokeObjectURL(url);
    throw new Error("empty image");
  }
  return { draw: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
}

/**
 * Whether a drawn canvas holds a picture: a decoder that ran out of memory
 * hands back a blank (all one colour, usually black) image instead of failing.
 */
export function looksBlank(canvas: HTMLCanvasElement): boolean {
  const probe = document.createElement("canvas");
  probe.width = 16;
  probe.height = 16;
  try {
    const ctx = probe.getContext("2d", { willReadFrequently: true });
    if (!ctx) return false;
    ctx.drawImage(canvas, 0, 0, 16, 16);
    const d = ctx.getImageData(0, 0, 16, 16).data;
    let min = 765;
    let max = 0;
    for (let i = 0; i < d.length; i += 4) {
      const v = d[i] + d[i + 1] + d[i + 2];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return max - min < 6;
  } catch {
    return false;
  } finally {
    releaseCanvas(probe);
  }
}

/**
 * Draws a photo upright at most maxEdge on its longest side (never enlarged),
 * on white (JPEG has no transparency). Tries the fast decoder first and checks
 * the result: if it came out blank, the other decoder gets a turn, so a photo
 * is never silently replaced by a black rectangle. Only when both fail (or
 * both agree the photo is a single colour) is that the answer.
 */
async function rasterize(file: Blob, maxEdge: number, crop?: "square"): Promise<HTMLCanvasElement> {
  const decoders = typeof createImageBitmap === "function" ? [viaBitmap, viaElement] : [viaElement];
  let lastBlank: HTMLCanvasElement | null = null;
  let decoded = false;
  for (const decoder of decoders) {
    let src: Source;
    try {
      src = await decoder(file);
    } catch {
      continue;
    }
    decoded = true;
    try {
      const side = Math.min(src.width, src.height);
      const sw = crop ? side : src.width;
      const sh = crop ? side : src.height;
      const scale = Math.min(1, maxEdge / Math.max(sw, sh));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(sw * scale));
      canvas.height = Math.max(1, Math.round(sh * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        releaseCanvas(canvas);
        continue;
      }
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(src.draw, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, 0, 0, canvas.width, canvas.height);
      if (!looksBlank(canvas)) {
        if (lastBlank) releaseCanvas(lastBlank);
        return canvas;
      }
      if (lastBlank) releaseCanvas(lastBlank);
      lastBlank = canvas;
    } finally {
      src.close();
    }
  }
  if (lastBlank) return lastBlank; // both decoders agree: the photo really is one colour
  throw new ImageError(
    decoded ? "We couldn't process that image on this device." : "We couldn't read that image. It may be damaged or in a format this browser can't open — try another one.",
  );
}

/** Encodes as WebP where the browser can (smaller at the same quality), else JPEG. */
async function encode(canvas: HTMLCanvasElement, quality: number): Promise<{ blob: Blob; mimeType: string }> {
  let blob = await canvasToBlob(canvas, "image/webp", quality);
  if (blob.type !== "image/webp") blob = await canvasToBlob(canvas, "image/jpeg", quality);
  return { blob, mimeType: blob.type === "image/webp" ? "image/webp" : "image/jpeg" };
}

/** Width and height of an image file (GIFs pass through, so only their size is needed). */
async function measure(file: Blob): Promise<{ width: number; height: number }> {
  for (const decoder of [viaBitmap, viaElement]) {
    try {
      const s = await decoder(file);
      s.close();
      return { width: s.width, height: s.height };
    } catch {
      /* try the next */
    }
  }
  throw new ImageError("We couldn't read that image. It may be damaged — try another one.");
}

export async function processImage(file: File): Promise<ProcessedImage> {
  const type = (file.type || "").toLowerCase();
  const name = file.name || "That file";
  const heic = isHeic(type, name);

  if (!heic && (!type.startsWith("image/") || (!DECODABLE.has(type) && type !== "image/gif"))) {
    throw new ImageError(`${name} isn't a supported image. Use JPG, PNG, WebP, HEIC or GIF.`);
  }
  if (file.size > IMAGE_LIMITS.maxInputBytes) {
    throw new ImageError(`${name} is ${mb(file.size)} — the limit is ${mb(IMAGE_LIMITS.maxInputBytes)}.`);
  }

  if (type === "image/gif") {
    if (file.size > IMAGE_LIMITS.maxGifBytes) {
      throw new ImageError(`${name} is a ${mb(file.size)} GIF — GIFs can be up to ${mb(IMAGE_LIMITS.maxGifBytes)}.`);
    }
    const { width, height } = await measure(file);
    return { blob: file.slice(0, file.size, "image/gif"), width, height, mimeType: "image/gif" };
  }

  let canvas: HTMLCanvasElement;
  try {
    canvas = await rasterize(file, IMAGE_LIMITS.maxEdge);
  } catch (e) {
    // Safari opens HEIC; other browsers can't.
    if (heic) throw new ImageError(`${name} is a HEIC photo, which this browser can't open. Choose it from your Photos library (it's converted automatically) or export it as JPEG.`);
    throw e;
  }
  let quality: number = IMAGE_LIMITS.quality;
  let best: ProcessedImage | null = null;
  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      const { blob, mimeType } = await encode(canvas, quality);
      const out = { blob, width: canvas.width, height: canvas.height, mimeType };
      if (blob.size <= IMAGE_LIMITS.targetBytes) return out;
      if (blob.size <= IMAGE_LIMITS.maxOutputBytes && (!best || blob.size < best.blob.size)) best = out;
      // Too big: lower quality first (cheap, invisible), then dimensions.
      if (quality > IMAGE_LIMITS.minQuality) quality = Math.max(IMAGE_LIMITS.minQuality, quality - 0.08);
      else {
        const smaller = document.createElement("canvas");
        smaller.width = Math.max(1, Math.round(canvas.width * 0.85));
        smaller.height = Math.max(1, Math.round(canvas.height * 0.85));
        const ctx = smaller.getContext("2d");
        if (!ctx) break;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(canvas, 0, 0, smaller.width, smaller.height);
        releaseCanvas(canvas);
        canvas = smaller;
      }
    }
    // Couldn't reach the target (very detailed photo): the smallest acceptable version.
    if (best) return best;
    throw new ImageError(`${name} is too detailed to upload. Try a smaller image.`);
  } finally {
    releaseCanvas(canvas);
  }
}

/** Feeds and grids show this copy: sharp across a phone screen (1080 px ≈ 360 pt × 3), a fraction of the bytes. */
export const SMALL_EDGE = 1080;
const SMALL_TARGET = 160 * 1024;

/**
 * The smaller copy of an already-processed photo, or null when the photo is
 * small enough already (or animated). Same encoder rules as processImage.
 */
export async function makeSmallCopy(blob: Blob): Promise<Blob | null> {
  if (!/^image\/(jpeg|png|webp)$/.test(blob.type)) return null;
  const { width, height } = await measure(blob);
  if (SMALL_EDGE / Math.max(width, height) > 0.85) return null; // within ~15 %: not worth a second file
  const canvas = await rasterize(blob, SMALL_EDGE);
  try {
    let quality = 0.8;
    for (;;) {
      const { blob: out } = await encode(canvas, quality);
      if (out.size <= SMALL_TARGET || quality <= 0.6) return out.size < blob.size ? out : null;
      quality -= 0.1;
    }
  } finally {
    releaseCanvas(canvas);
  }
}

/**
 * A ~24 px version of a processed photo as a data: URL (a few hundred bytes),
 * stored with the post and shown blurred while the real image loads.
 */
export async function makePreview(blob: Blob): Promise<string | null> {
  if (!/^image\/(jpeg|png|webp|gif)$/.test(blob.type)) return null;
  const canvas = await rasterize(blob, 24);
  try {
    const webp = canvas.toDataURL("image/webp", 0.5);
    const url = webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/jpeg", 0.5);
    return url.length <= 2000 ? url : null;
  } finally {
    releaseCanvas(canvas);
  }
}

/**
 * LEGACY (Firebase rollback path only): the old schema stores one image inline
 * as a data URL in a 1 MiB Firestore document. Not used by Supabase.
 */
export async function blobToLegacyDataUrl(blob: Blob, maxChars = 700_000): Promise<{ dataUrl: string; width: number; height: number }> {
  const full = await rasterize(blob, 1600);
  let scale = 1;
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(full.width * scale);
      canvas.height = Math.round(full.height * scale);
      canvas.getContext("2d")!.drawImage(full, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
      releaseCanvas(canvas);
      if (dataUrl.length <= maxChars) return { dataUrl, width: Math.round(full.width * scale), height: Math.round(full.height * scale) };
      scale *= 0.8;
    }
  } finally {
    releaseCanvas(full);
  }
  throw new ImageError("That image is too large for this server.");
}

// ------------------------------------------------------------------ avatars

export interface PreparedImage {
  dataUrl: string;
  width: number;
  height: number;
}

const AVATAR_SIZE = 512;

/** Centre-crop to a square and downscale for profile pictures (also strips metadata). */
export async function prepareAvatar(file: File): Promise<PreparedImage> {
  if (!file.type.startsWith("image/") && !isHeic(file.type, file.name)) throw new ImageError("Use a JPG, PNG, WebP or HEIC image.");
  if (file.size > IMAGE_LIMITS.maxInputBytes) throw new ImageError(`That image is over ${mb(IMAGE_LIMITS.maxInputBytes)}.`);
  const canvas = await rasterize(file, AVATAR_SIZE, "square").catch((e) => {
    throw isHeic(file.type, file.name) ? new ImageError("This browser can't open HEIC photos. Choose the photo from your Photos library or use a JPG.") : e;
  });
  try {
    // WebP where the browser can encode it (about a third smaller); older Safari hands back PNG, so JPEG there.
    const webp = canvas.toDataURL("image/webp", 0.85);
    return { dataUrl: webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/jpeg", 0.85), width: canvas.width, height: canvas.height };
  } finally {
    releaseCanvas(canvas);
  }
}
