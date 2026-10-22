import { makeSmallCopy } from "../../lib/image";
import { track } from "../../lib/perf";
/**
 * Client side of the media service (api/media-upload.ts, api/media.ts):
 * files go straight from the browser to the private bucket with a short-lived
 * link the server signs for one key, type and size; reads go through
 * /api/media/<key>, which checks visibility before every signed link.
 */
export type MediaPurpose = "avatar" | "post" | "moment" | "dm";

export interface MediaStore {
  /** Uploads and returns the object key Postgres assigned. */
  upload(purpose: MediaPurpose, blob: Blob, opts?: { conversationId?: string; onProgress?: (fraction: number) => void }): Promise<string>;
  /** Same-origin URL for <img>/<video> (authorized per request by the session cookie). */
  url(key: string): string;
  /** Raw bytes (encrypted message attachments), authorized by the Bearer token. */
  bytes(key: string): Promise<Uint8Array>;
  /** Signed read links for the files among `keys` the caller may see (api/media-sign.ts). */
  sign(keys: string[]): Promise<{ links: Record<string, { url: string; small?: string }>; ttl: number }>;
}

export class MediaError extends Error {
  constructor(
    public code: "not-configured" | "refused" | "too-large" | "quota" | "network" | "sign-in",
    message?: string,
  ) {
    super(message ?? code);
  }
}

const REFUSALS: Record<string, MediaError["code"]> = { MD002: "too-large", MD003: "quota" };

function put(url: string, blob: Blob, type: string, onProgress?: (f: number) => void): Promise<void> {
  // XHR rather than fetch: upload progress.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("content-type", type);
    // A stalled upload (lost signal) fails instead of spinning forever; the post stays saved with Retry.
    xhr.timeout = 180_000;
    xhr.ontimeout = () => reject(new MediaError("network", "upload timed out"));
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new MediaError("network", `upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new MediaError("network"));
    xhr.send(blob);
  });
}

export function createMediaStore(token: () => Promise<string | null>): MediaStore {
  const auth = async () => {
    const t = await token();
    if (!t) throw new MediaError("sign-in");
    return { authorization: `Bearer ${t}` };
  };
  async function begin(request: Record<string, unknown>) {
    const res = await fetch("/api/media-upload", {
      method: "POST",
      headers: { ...(await auth()), "content-type": "application/json" },
      body: JSON.stringify(request),
    }).catch(() => {
      throw new MediaError("network");
    });
    const body = (await res.json().catch(() => ({}))) as { key?: string; url?: string; error?: string; message?: string };
    if (res.status === 503) throw new MediaError("not-configured");
    if (!res.ok || !body.key || !body.url) throw new MediaError(REFUSALS[body.error ?? ""] ?? (res.status === 401 ? "sign-in" : "refused"), body.message);
    return { key: body.key, url: body.url };
  }

  /** The ~1080 px copy feeds show. Best effort: without it the full photo is shown. */
  async function uploadSmall(original: string, small: Promise<Blob | null>) {
    const blob = await small;
    if (!blob) return;
    const { url } = await begin({ variantOf: original, mime: blob.type, size: blob.size });
    await put(url, blob, blob.type);
  }

  return {
    async upload(purpose, blob, opts = {}) {
      const type = purpose === "dm" ? "application/octet-stream" : blob.type;
      // Made while the original is being signed and sent.
      const small = purpose === "post" || purpose === "moment" ? makeSmallCopy(blob).catch(() => null) : null;
      const { key, url } = await begin({ purpose, mime: type, size: blob.size, conversationId: opts.conversationId ?? null });
      const smallDone = small ? uploadSmall(key, small).catch(() => track("upload_small_fail", 1)) : null;
      // One retry for a flaky connection; the link is valid for 10 minutes.
      const t0 = performance.now();
      try {
        await put(url, blob, type, opts.onProgress).catch(() => put(url, blob, type, opts.onProgress));
      } catch (e) {
        track("upload_fail", 1);
        throw e;
      }
      const seconds = (performance.now() - t0) / 1000;
      if (seconds > 0) track("upload_kbps", blob.size / 1024 / seconds);
      // The small copy is ~5× smaller and usually done by now; don't hold the post for long if not.
      if (smallDone) await Promise.race([smallDone, new Promise((r) => setTimeout(r, 15_000))]);
      return key;
    },
    url: (key) => `/api/media/${key}`,
    async sign(keys) {
      const res = await fetch("/api/media-sign", {
        method: "POST",
        headers: { ...(await auth()), "content-type": "application/json" },
        body: JSON.stringify({ keys }),
      });
      if (!res.ok) throw new MediaError(res.status === 401 ? "sign-in" : "refused");
      return res.json();
    },
    async bytes(key) {
      const res = await fetch(`/api/media/${key}?json=1`, { headers: await auth() });
      if (!res.ok) throw new MediaError(res.status === 401 ? "sign-in" : "refused");
      const { url } = (await res.json()) as { url: string };
      const file = await fetch(url);
      if (!file.ok) throw new MediaError("network");
      return new Uint8Array(await file.arrayBuffer());
    },
  };
}
