/**
 * Downscale + re-encode an image picked by the user before upload.
 * Posts currently store images inline in the Firestore doc (prototype schema),
 * which has a hard 1 MiB document limit, so we keep the payload well under it.
 */
export interface PreparedImage {
  dataUrl: string;
  width: number;
  height: number;
}

const MAX_EDGE = 1600;
const MAX_BYTES = 700_000; // base64 chars ≈ bytes in the doc

export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!file.type.startsWith("image/")) throw new Error("That file isn't an image.");
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("We couldn't read that image. Try a JPG or PNG.");
  });

  let scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  for (let attempt = 0; attempt < 6; attempt++) {
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Image processing isn't supported in this browser.");
    ctx.drawImage(bitmap, 0, 0, width, height);
    const quality = attempt < 3 ? 0.85 - attempt * 0.1 : 0.6;
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    if (dataUrl.length <= MAX_BYTES) {
      bitmap.close();
      return { dataUrl, width, height };
    }
    if (attempt >= 2) scale *= 0.8;
  }
  bitmap.close();
  throw new Error("That image is too large. Try a smaller one.");
}

const AVATAR_SIZE = 512;

/** Centre-crop to a square and downscale for profile pictures. */
export async function prepareAvatar(file: File): Promise<PreparedImage> {
  if (!file.type.startsWith("image/")) throw new Error("That file isn't an image.");
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("We couldn't read that image. Try a JPG or PNG.");
  });
  const side = Math.min(bitmap.width, bitmap.height);
  const size = Math.min(AVATAR_SIZE, side);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Image processing isn't supported in this browser.");
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  bitmap.close();
  return { dataUrl: canvas.toDataURL("image/jpeg", 0.85), width: size, height: size };
}
