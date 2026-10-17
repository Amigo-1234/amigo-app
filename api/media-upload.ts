/**
 * POST /api/media-upload  { purpose, mime, size, conversationId? }  (Bearer JWT)
 * → { key, url }: a PUT link to the private bucket, valid 10 minutes, only for
 * the key, type and exact size Postgres approved (media_begin_upload).
 * Also deletes a few files queued for removal on each call.
 */
import { json, presign, r2, remove, rpc, tokenFor } from "./_media";

export const config = { runtime: "edge" };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "method" });
  const store = r2();
  if (!store) return json(503, { error: "storage-not-configured" });
  const token = await tokenFor(req);
  if (!token || !req.headers.get("authorization")) return json(401, { error: "sign-in" });
  const body = (await req.json().catch(() => null)) as { purpose?: string; mime?: string; size?: number; conversationId?: string | null } | null;
  if (!body?.purpose || !body.mime || typeof body.size !== "number") return json(400, { error: "bad-request" });

  const begun = await rpc<string>(token, "media_begin_upload", {
    p_purpose: body.purpose,
    p_mime: body.mime,
    p_size: body.size,
    p_conversation: body.conversationId ?? null,
  });
  if (!begun.ok) return json(begun.status === 401 ? 401 : 403, { error: begun.code ?? "refused", message: begun.message });

  const key = begun.data;
  const url = await presign(store, key, "PUT", 600, { type: body.mime, size: body.size });

  // Housekeeping without a scheduler: remove a few deleted files.
  const queued = await rpc<string[]>(token, "media_cleanup_take", { p_limit: 5 });
  if (queued.ok) await Promise.all(queued.data.map((k) => remove(store, k).catch(() => undefined)));

  return json(200, { key, url });
}
