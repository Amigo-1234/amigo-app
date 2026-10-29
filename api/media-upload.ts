/**
 * POST /api/media-upload  { purpose, mime, size, conversationId? } or { variantOf, mime, size }  (Bearer JWT)
 * → { key, url }: a PUT link to the private bucket, valid 10 minutes, only for
 * the key, type and exact size Postgres approved (media_begin_upload).
 * Also deletes a few files queued for removal on each call (needs PUSH_SERVER_SECRET:
 * media_cleanup_take / media_cleanup_done refuse anyone without the server secret).
 */
import { deleteLeased, json, presign, r2, rpc, tokenFor, type Leased } from "./_media";

export const config = { runtime: "edge" };

const ENV = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "method" });
  const store = r2();
  if (!store) return json(503, { error: "storage-not-configured" });
  const token = await tokenFor(req);
  if (!token || !req.headers.get("authorization")) return json(401, { error: "sign-in" });
  const body = (await req.json().catch(() => null)) as {
    purpose?: string; mime?: string; size?: number; conversationId?: string | null; businessId?: string | null; variantOf?: string;
  } | null;
  if (!body?.mime || typeof body.size !== "number" || !(body.purpose || body.variantOf)) return json(400, { error: "bad-request" });

  // variantOf: the smaller copy of a photo this person just uploaded (media_begin_variant).
  const [fn, args] = body.variantOf
    ? (["media_begin_variant", { p_original: body.variantOf, p_mime: body.mime, p_size: body.size }] as const)
    : ([
        "media_begin_upload",
        { p_purpose: body.purpose, p_mime: body.mime, p_size: body.size, p_conversation: body.conversationId ?? null, ...(body.businessId ? { p_business: body.businessId } : {}) },
      ] as const);
  let begun = await rpc<string>(token, fn, args);
  // A token issued moments ago can be accepted by the Data API before Postgres
  // resolves its user (seen live right after sign-up): ask once more.
  if (!begun.ok && begun.code === "MD001" && begun.message === "sign in first") {
    await new Promise((r) => setTimeout(r, 600));
    begun = await rpc<string>(token, fn, args);
  }
  if (!begun.ok) return json(begun.status === 401 ? 401 : 403, { error: begun.code ?? "refused", message: begun.message });

  const key = begun.data;
  // Housekeeping without a scheduler, alongside signing (not after it): remove a few deleted files.
  // Files are leased, deleted, then confirmed: a failed or interrupted delete is retried later.
  const secret = ENV.PUSH_SERVER_SECRET;
  const housekeeping = body.variantOf || !secret ? Promise.resolve() : cleanUp(token, secret, store);
  const [url] = await Promise.all([presign(store, key, "PUT", 600, { type: body.mime, size: body.size }), housekeeping.catch(() => undefined)]);

  return json(200, { key, url });
}

/** Leases a few queued files, deletes them, and removes from the queue only those confirmed gone. */
async function cleanUp(token: string, secret: string, store: NonNullable<ReturnType<typeof r2>>) {
  const queued = await rpc<Leased[]>(token, "media_cleanup_take", { p_key: secret, p_limit: 5 });
  if (!queued.ok || !queued.data.length) return;
  const confirmed = await deleteLeased(store, queued.data);
  if (confirmed.length) await rpc(token, "media_cleanup_done", { p_key: secret, p_items: confirmed });
}
