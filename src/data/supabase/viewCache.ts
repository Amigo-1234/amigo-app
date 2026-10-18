/**
 * The last value of each list a screen subscribed to, kept in this tab's
 * memory only (never written to disk or shared), so going back to a screen
 * shows what was there at once while it refreshes in the background
 * (stale-while-revalidate). The server is asked again on every visit, so
 * nothing here decides what anyone may see. Cleared whenever the signed-in
 * person changes or signs out.
 */
import { forgetMediaLinks, setMediaOwner } from "../../lib/mediaLinks";

const MAX_ENTRIES = 60;
const values = new Map<string, unknown>();
let owner: string | null | undefined;

/** The signed-in person (null when signed out); a change forgets everything. */
export function setCacheOwner(userId: string | null) {
  if (userId === owner) return;
  forgetMediaLinks();
  if (userId) setMediaOwner(userId);
  values.clear();
  inflight.clear();
  owner = userId;
}

/**
 * Requests started early (right after the session is known, in parallel with
 * loading the profile) and handed to the first screen that asks for the same
 * thing within a few seconds — the same request, just sooner.
 */
const PREFETCH_TTL_MS = 15_000;
const inflight = new Map<string, { at: number; promise: Promise<unknown> }>();

export function prefetch(key: string, fn: () => Promise<unknown>) {
  if (values.has(key) || inflight.has(key)) return;
  inflight.set(key, { at: Date.now(), promise: fn().catch(() => undefined) });
}

/** After any write: an early answer may now be out of date. */
export const dropPrefetches = () => inflight.clear();

/** The early request for `key`, if one is still fresh (resolves to undefined if it failed). */
export function takePrefetch<T>(key: string): Promise<T | undefined> | undefined {
  const entry = inflight.get(key);
  inflight.delete(key);
  return entry && Date.now() - entry.at < PREFETCH_TTL_MS ? (entry.promise as Promise<T | undefined>) : undefined;
}

export const cached = <T>(key: string): T | undefined => values.get(key) as T | undefined;

export function remember(key: string, value: unknown) {
  values.delete(key);
  values.set(key, value);
  if (values.size > MAX_ENTRIES) values.delete(values.keys().next().value as string);
}

export const forgetAll = () => {
  forgetMediaLinks();
  values.clear();
  inflight.clear();
};
