import { useEffect, useRef } from "react";

/**
 * "Something changed, look again": sent by the data layer's change checks
 * (supabaseSource, app pulse) with what changed — "n" notifications, "f" your
 * follower counts, "p" new posts, "mo" Moments — or "all" when the app comes
 * back on screen or back online. Screens that load once (a profile) refresh
 * on it; live lists refresh by themselves.
 */
export const SYNC_EVENT = "amigo:sync";

export function announceSync(keys: string[]) {
  window.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail: { keys } }));
}

/** Calls onSync when any of `keys` (or "all") changed. */
export function useSync(keys: string[], onSync: () => void) {
  const fn = useRef(onSync);
  fn.current = onSync;
  const want = keys.join(",");
  useEffect(() => {
    const list = want.split(",");
    const handler = (e: Event) => {
      const got = (e as CustomEvent<{ keys: string[] }>).detail?.keys ?? [];
      if (got.includes("all") || got.some((k) => list.includes(k))) fn.current();
    };
    window.addEventListener(SYNC_EVENT, handler);
    return () => window.removeEventListener(SYNC_EVENT, handler);
  }, [want]);
}
