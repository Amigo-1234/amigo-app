/**
 * Shared by api/media.ts and api/media-upload.ts (files starting with "_" are
 * not routes). The R2 credentials live only in Vercel environment variables
 * (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET), never in
 * the browser or the repository. Every decision about who may upload or read
 * a file is made by Postgres, asked as the signed-in person.
 */
import { AwsClient } from "aws4fetch";

const ENV = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
// Overrides exist for local tests only (scripts/test/media.test.mjs).
export const NEON_AUTH = ENV.NEON_AUTH_URL_OVERRIDE ?? "https://ep-dry-mode-zano9y8g.neonauth.c-2.eu-west-2.aws.neon.tech/neondb/auth";
export const NEON_REST = ENV.NEON_REST_URL_OVERRIDE ?? "https://ep-dry-mode-zano9y8g.apirest.c-2.eu-west-2.aws.neon.tech/neondb/rest/v1";

interface R2 {
  client: AwsClient;
  base: string;
}

export function r2(): R2 | null {
  const env = ENV;
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) return null;
  return {
    client: new AwsClient({ accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY, service: "s3", region: "auto" }),
    base: env.R2_ENDPOINT_OVERRIDE ?? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}`,
  };
}

/** Keys are made by media_begin_upload: "<uuid>/<purpose>/[<uuid>/]<hex>.<ext>" (smaller copies: "<hex>-sm.<ext>", media_begin_variant). */
export const KEY = /^[0-9a-f-]{36}\/(avatar|post|moment|dm)\/(?:[0-9a-f-]{36}\/)?[0-9a-f]{32}(?:-sm)?\.(jpg|png|webp|gif|mp4|webm|mov|bin)$/;

const objectUrl = (s: R2, key: string) => `${s.base}/${key.split("/").map(encodeURIComponent).join("/")}`;

/** A link valid for `seconds`; for PUT it only works with exactly this type and length. */
export async function presign(s: R2, key: string, method: "GET" | "PUT", seconds: number, put?: { type: string; size: number }) {
  const url = new URL(objectUrl(s, key));
  url.searchParams.set("X-Amz-Expires", String(seconds));
  const headers = put ? { "content-type": put.type, "content-length": String(put.size) } : undefined;
  const signed = await s.client.sign(url.toString(), { method, headers, aws: { signQuery: true, allHeaders: true } });
  return signed.url;
}

/** Read links are signed per window, so the same file gets the same URL for a while (browser cache hits). */
export const READ_WINDOW_S = 30 * 60;
const READ_VALID_S = 90 * 60;

/**
 * A read link for an object that never changes (keys are random and never
 * reused). Signed at the start of the current 30-minute window and valid 90
 * minutes from then, so it has 60–90 minutes left; R2 is asked to let the
 * browser keep the bytes privately for that long. Returns the link and how many
 * seconds of it remain.
 */
export async function presignRead(s: R2, key: string, now = Date.now()) {
  const start = Math.floor(now / 1000 / READ_WINDOW_S) * READ_WINDOW_S;
  const remaining = start + READ_VALID_S - Math.floor(now / 1000);
  const url = new URL(objectUrl(s, key));
  url.searchParams.set("X-Amz-Expires", String(READ_VALID_S));
  url.searchParams.set("response-cache-control", `private, max-age=${remaining - 120}, immutable`);
  const datetime = new Date(start * 1000).toISOString().replace(/[:-]|\.\d{3}/g, "");
  const signed = await s.client.sign(url.toString(), { method: "GET", aws: { signQuery: true, datetime } });
  return { url: signed.url, remaining };
}

export const remove = (s: R2, key: string) => s.client.fetch(objectUrl(s, key), { method: "DELETE" });

/** Calls a Postgres function through the Data API as the person holding `token`. */
export async function rpc<T>(token: string, fn: string, args: Record<string, unknown>): Promise<{ ok: true; data: T } | { ok: false; status: number; code?: string; message?: string }> {
  const res = await fetch(`${NEON_REST}/rpc/${fn}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, status: res.status, code: body?.code, message: body?.message };
  return { ok: true, data: body as T };
}

/** The caller's Neon Auth JWT: from the Authorization header, or (for <img> requests) from the session cookie. */
export async function tokenFor(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const cookie = req.headers.get("cookie");
  if (!cookie) return null;
  const res = await fetch(`${NEON_AUTH}/token`, { headers: { cookie, origin: new URL(req.url).origin } });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { token?: string } | null;
  return body?.token ?? null;
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
