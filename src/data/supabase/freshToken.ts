/**
 * Database requests made with a sign-in token the Data API may not honour yet.
 * Used as the Neon client's fetch (neonClient.ts); tested by scripts/test/fresh-token.test.mjs.
 */
/**
 * A sign-in token is sometimes not honoured by the Data API for a moment after
 * it is issued (measured on production: refused at +0 ms, honoured at +250 ms).
 * Neon Auth issues a new token on every page load and every 15 minutes, so a
 * like, reply or post sent right then ran as signed out: refused ("not signed
 * in"), or for an unlike, silently deleting nothing; reads came back without
 * the person's own likes.
 *
 * Changes wait until the token is FRESH_TOKEN_GRACE_MS old and are retried if
 * still refused as signed out shortly after a new token (a refused change did
 * nothing, so a retry can't double it). Reads go out at once, and if any used a
 * brand-new token the open views are read again once it is honoured.
 */
const FRESH_TOKEN_GRACE_MS = 500;
const FRESH_TOKEN_RETRY_WINDOW_MS = 5_000;
const firstSeen = new Map<string, number>();
const READ_RPCS = new Set([
  "feed_posts", "moments_feed", "unread_notification_count", "dm_inbox", "dm_thread", "dm_pulse",
  "dm_peer_typing_ms", "e2e_sync_state", "e2e_query_keys", "e2e_my_devices", "is_admin", "server_now",
  "suggested_profiles", "support_config", "support_discover", "support_feedback", "support_profile_stats",
  "support_wallet", "world_leaderboard", "log_client_perf",
]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let rereadTimer: ReturnType<typeof setTimeout> | undefined;
let lastReread = 0;
/** However often tokens change, the views are re-read at most this often. */
const REREAD_MIN_INTERVAL_MS = 10_000;
/** Fired (once per new token) when reads went out before the token was honoured. */
export const FRESH_TOKEN_REREAD_EVENT = "amigo:fresh-token-reread";

export async function dataFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const token = new Headers(init?.headers).get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!token) return globalThis.fetch(input, init);
  let seenAt = firstSeen.get(token);
  if (seenAt === undefined) {
    seenAt = Date.now();
    firstSeen.set(token, seenAt);
    if (firstSeen.size > 8) firstSeen.delete(firstSeen.keys().next().value as string);
  }
  const method = (init?.method ?? "GET").toUpperCase();
  const rpc = /\/rpc\/([a-z0-9_]+)/.exec(String(input instanceof Request ? input.url : input))?.[1];
  const isRead = method === "GET" || method === "HEAD" || (rpc !== undefined && READ_RPCS.has(rpc));
  const age = () => Date.now() - seenAt;

  if (isRead) {
    if (age() < FRESH_TOKEN_GRACE_MS && !rereadTimer && Date.now() - lastReread > REREAD_MIN_INTERVAL_MS) {
      rereadTimer = setTimeout(() => {
        rereadTimer = undefined;
        lastReread = Date.now();
        window.dispatchEvent(new Event(FRESH_TOKEN_REREAD_EVENT));
      }, FRESH_TOKEN_GRACE_MS + 500);
    }
    return globalThis.fetch(input, init);
  }

  if (age() < FRESH_TOKEN_GRACE_MS) await sleep(FRESH_TOKEN_GRACE_MS - age());
  for (let attempt = 0; ; attempt++) {
    const res = await globalThis.fetch(input, init);
    if ((res.status !== 401 && res.status !== 403) || attempt >= 3 || age() > FRESH_TOKEN_RETRY_WINDOW_MS) return res;
    const body = (await res.clone().json().catch(() => null)) as { code?: string; message?: string } | null;
    const signedOut = body?.code === "42501" && /not signed in|row-level security/i.test(body.message ?? "");
    if (!signedOut) return res;
    await sleep(300 * (attempt + 1));
  }
}

