/**
 * POST /api/media-sign  { keys: string[] }  (Bearer JWT)
 * → { links: { [key]: { url, small? } }, ttl }: signed read links for every
 * file in the list the caller may see (media_sign_set: the same rules as
 * media_can_read), one Postgres call for a whole screen of images instead of a
 * function call per image. `small` is the ~1080 px copy when one exists. Files
 * the caller may not see are simply missing from the answer.
 */
import { KEY, json, presignRead, r2, rpc } from "./_media";

export const config = { runtime: "edge" };
const MAX_KEYS = 60;

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "method" });
  const store = r2();
  if (!store) return json(503, { error: "storage-not-configured" });
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return json(401, { error: "sign-in" });
  const body = (await req.json().catch(() => null)) as { keys?: unknown } | null;
  const keys = Array.isArray(body?.keys) ? [...new Set(body.keys.filter((k): k is string => typeof k === "string" && KEY.test(k)))].slice(0, MAX_KEYS) : [];
  if (!keys.length) return json(400, { error: "bad-request" });

  const allowed = await rpc<{ path: string; small: string | null }[]>(auth.slice(7), "media_sign_set", { p_paths: keys });
  if (!allowed.ok) return json(allowed.status === 401 ? 401 : 502, { error: "refused" });

  const now = Date.now();
  let ttl = 0;
  const links: Record<string, { url: string; small?: string }> = {};
  await Promise.all(
    allowed.data.map(async (row) => {
      const full = await presignRead(store, row.path, now);
      ttl = full.remaining;
      links[row.path] = row.small ? { url: full.url, small: (await presignRead(store, row.small, now)).url } : { url: full.url };
    }),
  );
  return json(200, { links, ttl });
}
