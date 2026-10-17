/**
 * GET /api/media/<key>  → 302 to a signed link (1 hour) if Postgres says the
 * caller may see it (media_can_read: post visibility, Moment audience and
 * expiry, conversation membership); 404 otherwise — the same answer whether
 * the file doesn't exist or isn't yours to see.
 * Works for <img src> (session cookie) and fetch (Bearer). `?json=1` returns
 * { url } instead of redirecting (used for encrypted message attachments).
 */
import { KEY, json, presign, r2, rpc, tokenFor } from "./_media";

export const config = { runtime: "edge" };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "GET") return json(405, { error: "method" });
  const store = r2();
  if (!store) return json(503, { error: "storage-not-configured" });
  const url = new URL(req.url);
  const key = url.searchParams.get("path") ?? "";
  if (!KEY.test(key)) return json(404, { error: "not-found" });
  const token = await tokenFor(req);
  if (!token) return json(401, { error: "sign-in" });

  const allowed = await rpc<boolean>(token, "media_can_read", { p_path: key });
  if (!allowed.ok || allowed.data !== true) return json(404, { error: "not-found" });

  const signed = await presign(store, key, "GET", 3600);
  // Private: browsers may reuse it for 50 minutes; shared caches never store it.
  const cache = { "cache-control": "private, max-age=3000" };
  if (url.searchParams.get("json") === "1") return json(200, { url: signed }, cache);
  return new Response(null, { status: 302, headers: { location: signed, ...cache } });
}
