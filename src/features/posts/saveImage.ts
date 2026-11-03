import { dataSource } from "../../data";
import { mediaKey } from "../../lib/mediaLinks";

const TYPES: [string, string][] = [
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["image/avif", "avif"],
  ["image/heic", "heic"],
];

/** The real format from the file's first bytes (the stored type can be generic). */
async function sniff(blob: Blob): Promise<string> {
  const b = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const at = (i: number, s: string) => [...s].every((c, j) => b[i + j] === c.charCodeAt(0));
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x89 && at(1, "PNG")) return "image/png";
  if (at(0, "RIFF") && at(8, "WEBP")) return "image/webp";
  if (at(0, "GIF8")) return "image/gif";
  if (at(4, "ftypavif")) return "image/avif";
  if (at(4, "ftyphei") || at(4, "ftypmif1")) return "image/heic";
  return blob.type || "image/jpeg";
}

/**
 * The best copy this person is allowed to have:
 * - stored photos: the original, through a freshly signed, permission-checked link
 *   (the same path the app uses to show it; an expired link is simply re-signed);
 * - message photos: the copy already decrypted on this device (they exist
 *   unencrypted nowhere else; nothing is sent anywhere to save them).
 */
async function imageBlob(url: string): Promise<Blob> {
  if (url.startsWith("blob:") || url.startsWith("data:")) return (await fetch(url)).blob();
  if (mediaKey(url) && dataSource.mediaBytes) return dataSource.mediaBytes(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

export type SaveResult = "shared" | "downloaded" | "cancelled";

/**
 * Save a photo: the share sheet where the device offers it for files (iPhone,
 * Android — "Save Image" / "Save to Photos" lives there), otherwise a normal
 * download. The result says what happened as far as the browser can know;
 * whether it reached Photos is up to the share sheet.
 */
export async function saveImage(url: string): Promise<SaveResult> {
  const raw = await imageBlob(url);
  const type = await sniff(raw);
  const ext = TYPES.find(([t]) => t === type)?.[1] ?? "jpg";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  const name = `amigo-${stamp}.${ext}`;
  const file = new File([raw], name, { type });

  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  if (coarse && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return "shared";
    } catch (e) {
      if ((e as Error).name === "AbortError") return "cancelled";
      // Share refused (e.g. not from a tap): fall back to a download.
    }
  }
  const href = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
  return "downloaded";
}
