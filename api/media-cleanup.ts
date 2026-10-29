/**
 * GET /api/media-cleanup — the daily clean-up (vercel.json "crons"; Hobby: once a day,
 * within the scheduled hour). Releases what's due (taken-down photos past retention,
 * unused uploads over a day old) and deletes queued files from the bucket.
 *
 * - Only Vercel Cron gets in: it sends "Authorization: Bearer <CRON_SECRET>". Without
 *   CRON_SECRET (or the database link) this answers 503 and does nothing; a wrong or
 *   missing header gets 401.
 * - No user session: it connects to Postgres as media_janitor (CLEANUP_DATABASE_URL),
 *   a role that may run media_janitor_release / _take / _done and nothing else, over
 *   Neon's SQL-over-HTTP endpoint.
 * - Vercel doesn't retry a failed run and may occasionally run one twice or overlap
 *   them. Files are leased (shared with the upload route), so two runs never take the
 *   same file; a delete that fails isn't confirmed and comes back after the 10-minute
 *   lease (tomorrow, or with the next upload), up to 10 attempts.
 * - Answers counts only; never paths, links or credentials.
 */
import { deleteLeased, json, r2, type Leased } from "./_media";

export const config = { runtime: "edge" };

const ENV = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const BATCH = 20;
const MAX_BATCHES = 10;
const BUDGET_MS = 20_000;

/** Same length and same characters, compared without stopping at the first difference. */
function sameSecret(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** One statement over Neon's HTTP endpoint (what @neondatabase/serverless does), as the role in `conn`. */
async function sql<T>(conn: string, query: string, params: unknown[] = []): Promise<T[]> {
  const endpoint = ENV.CLEANUP_SQL_URL_OVERRIDE ?? `https://${new URL(conn).hostname.replace(/^[^.]+\./, "api.")}/sql`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "neon-connection-string": conn },
    body: JSON.stringify({ query, params }),
  });
  const body = (await res.json().catch(() => null)) as { rows?: T[]; code?: string } | null;
  // The status and Postgres error code only: the error text could echo the connection details.
  if (!res.ok || !body?.rows) throw new Error(`database ${res.status} ${body?.code ?? ""}`.trim());
  return body.rows;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "GET") return json(405, { error: "method" });
  const cron = ENV.CRON_SECRET;
  const conn = ENV.CLEANUP_DATABASE_URL;
  const store = r2();
  if (!cron || !conn || !store) return json(503, { error: "not-configured" });
  if (!sameSecret(req.headers.get("authorization") ?? "", `Bearer ${cron}`)) return json(401, { error: "unauthorized" });

  const until = Date.now() + BUDGET_MS;
  try {
    const [{ released }] = await sql<{ released: { takedown: number; stale: number } }>(conn, "select public.media_janitor_release() as released");
    let deleted = 0;
    let failed = 0;
    for (let i = 0; i < MAX_BATCHES && Date.now() < until; i++) {
      const items = await sql<Leased>(conn, "select item_id, item_path, claim from public.media_janitor_take($1)", [BATCH]);
      if (!items.length) break;
      const confirmed = await deleteLeased(store, items);
      if (confirmed.length) await sql(conn, "select public.media_janitor_done($1::jsonb) as n", [JSON.stringify(confirmed)]);
      deleted += confirmed.length;
      failed += items.length - confirmed.length;
      if (items.length < BATCH) break;
    }
    console.log(JSON.stringify({ at: "media-cleanup", released, deleted, failed }));
    return json(200, { released, deleted, failed });
  } catch (e) {
    const reason = e instanceof Error ? e.message : "error";
    console.warn(JSON.stringify({ at: "media-cleanup", outcome: "failed", reason }));
    return json(502, { error: "cleanup-failed" });
  }
}
