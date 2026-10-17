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
  return {
    async upload(purpose, blob, opts = {}) {
      const type = purpose === "dm" ? "application/octet-stream" : blob.type;
      const res = await fetch("/api/media-upload", {
        method: "POST",
        headers: { ...(await auth()), "content-type": "application/json" },
        body: JSON.stringify({ purpose, mime: type, size: blob.size, conversationId: opts.conversationId ?? null }),
      }).catch(() => {
        throw new MediaError("network");
      });
      const body = (await res.json().catch(() => ({}))) as { key?: string; url?: string; error?: string; message?: string };
      if (res.status === 503) throw new MediaError("not-configured");
      if (!res.ok || !body.key || !body.url) throw new MediaError(REFUSALS[body.error ?? ""] ?? (res.status === 401 ? "sign-in" : "refused"), body.message);
      // One retry for a flaky connection; the link is valid for 10 minutes.
      await put(body.url, blob, type, opts.onProgress).catch(() => put(body.url!, blob, type, opts.onProgress));
      return body.key;
    },
    url: (key) => `/api/media/${key}`,
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
