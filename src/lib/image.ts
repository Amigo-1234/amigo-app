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
  /** Longest edge after resizing. Sharp on any phone/laptop screen, ~4× smaller than a 12 MP photo. */
  maxEdge: 2048,
  /** Target ceiling for the processed upload. */
  maxOutputBytes: 3 * 1024 * 1024,
  quality: 0.85,
  minQuality: 0.6,
  maxGifBytes: 8 * 1024 * 1024,
} as const;

const DECODABLE = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/bmp"]);

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

async function decode(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new ImageError("We couldn't read that image. It may be damaged — try another one.");
  }
}

export async function processImage(file: File): Promise<ProcessedImage> {
  const type = (file.type || "").toLowerCase();
  const name = file.name || "That file";

  if (/heic|heif/.test(type) || /\.(heic|heif)$/i.test(file.name)) {
    throw new ImageError(`${name} is a HEIC photo, which browsers can't open yet. Export it as JPEG and try again.`);
  }
  if (!type.startsWith("image/") || (!DECODABLE.has(type) && type !== "image/gif")) {
    throw new ImageError(`${name} isn't a supported image. Use JPG, PNG, WebP or GIF.`);
  }
  if (file.size > IMAGE_LIMITS.maxInputBytes) {
    throw new ImageError(`${name} is ${mb(file.size)} — the limit is ${mb(IMAGE_LIMITS.maxInputBytes)}.`);
  }

  if (type === "image/gif") {
    if (file.size > IMAGE_LIMITS.maxGifBytes) {
      throw new ImageError(`${name} is a ${mb(file.size)} GIF — GIFs can be up to ${mb(IMAGE_LIMITS.maxGifBytes)}.`);
    }
    const bmp = await decode(file);
    const out = { blob: file.slice(0, file.size, "image/gif"), width: bmp.width, height: bmp.height, mimeType: "image/gif" };
    bmp.close();
    return out;
  }

  const bitmap = await decode(file);
  let scale = Math.min(1, IMAGE_LIMITS.maxEdge / Math.max(bitmap.width, bitmap.height));
  let quality: number = IMAGE_LIMITS.quality;
  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new ImageError("Image processing isn't supported in this browser.");
      // JPEG has no transparency: put transparent PNG/WebP areas on white, not black.
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, width, height);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, 0, 0, width, height);
      const blob = await canvasToBlob(canvas, "image/jpeg", quality);
      if (blob.size <= IMAGE_LIMITS.maxOutputBytes) return { blob, width, height, mimeType: "image/jpeg" };
      // Too big: lower quality first (cheap, invisible), then dimensions.
      if (quality > IMAGE_LIMITS.minQuality) quality = Math.max(IMAGE_LIMITS.minQuality, quality - 0.1);
      else scale *= 0.85;
    }
    throw new ImageError(`${name} is too detailed to upload. Try a smaller image.`);
  } finally {
    bitmap.close();
  }
}

/**
 * LEGACY (Firebase rollback path only): the old schema stores one image inline
 * as a data URL in a 1 MiB Firestore document. Not used by Supabase.
 */
export async function blobToLegacyDataUrl(blob: Blob, maxChars = 700_000): Promise<{ dataUrl: string; width: number; height: number }> {
  const bitmap = await decode(blob);
  let scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
      if (dataUrl.length <= maxChars) return { dataUrl, width: canvas.width, height: canvas.height };
      scale *= 0.8;
    }
  } finally {
    bitmap.close();
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
  if (!file.type.startsWith("image/") || /heic|heif/.test(file.type)) throw new ImageError("Use a JPG, PNG or WebP image.");
  if (file.size > IMAGE_LIMITS.maxInputBytes) throw new ImageError(`That image is over ${mb(IMAGE_LIMITS.maxInputBytes)}.`);
  const bitmap = await decode(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const size = Math.min(AVATAR_SIZE, side);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new ImageError("Image processing isn't supported in this browser.");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  bitmap.close();
  return { dataUrl: canvas.toDataURL("image/jpeg", 0.85), width: size, height: size };
}
