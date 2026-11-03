import { useEffect, useSyncExternalStore, type RefObject } from "react";
import { dataSource } from "../../data";

/**
 * Post view counts. A post counts as seen once at least half of it has been on screen for a
 * second; the server counts each account once per post and never the author. Seen posts go in
 * batches (at most 50, a few seconds apart, and when the tab is hidden); totals for the posts on
 * screen are asked for together. If counting is off — or the database doesn't have it yet — the
 * first answer says so and nothing more is sent this session.
 */
const api = dataSource.postViews ?? null;
let on: boolean | null = null;
const counts = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();
const emit = (id: string) => listeners.get(id)?.forEach((l) => l());
const emitAll = () => listeners.forEach((set) => set.forEach((l) => l()));

function subscribe(id: string, l: () => void) {
  let set = listeners.get(id);
  if (!set) listeners.set(id, (set = new Set()));
  set.add(l);
  return () => {
    set.delete(l);
    if (!set.size) listeners.delete(id);
  };
}

function stop() {
  on = false;
  emitAll();
}

// ------------------------------------------------------------------ totals

const TOTALS_FRESH_MS = 2 * 60_000;
const askedAt = new Map<string, number>();
const wanted = new Set<string>();
let totalsTimer: ReturnType<typeof setTimeout> | undefined;

function want(id: string) {
  if (!api || on === false) return;
  const at = askedAt.get(id);
  if (at && Date.now() - at < TOTALS_FRESH_MS) return;
  wanted.add(id);
  totalsTimer ??= setTimeout(fetchTotals, 80);
}

async function fetchTotals() {
  totalsTimer = undefined;
  const ids = [...wanted].slice(0, 100);
  ids.forEach((id) => {
    wanted.delete(id);
    askedAt.set(id, Date.now());
  });
  if (wanted.size) totalsTimer = setTimeout(fetchTotals, 0);
  try {
    const r = await api!.totals(ids);
    if (!r.on) return stop();
    on = true;
    for (const id of ids) {
      counts.set(id, Math.max(counts.get(id) ?? 0, r.counts.get(id) ?? 0));
      emit(id);
    }
  } catch {
    // Counts are a nice-to-have: never retry in a loop or bother the reader.
    stop();
  }
}

// ------------------------------------------------------------------ recording

const sent = new Set<string>();
let queue: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function markSeen(id: string) {
  if (!api || on === false || sent.has(id)) return;
  sent.add(id);
  queue.push(id);
  if (queue.length >= 50) void flush();
  else flushTimer ??= setTimeout(flush, 3000);
}

async function flush() {
  clearTimeout(flushTimer);
  flushTimer = undefined;
  if (!queue.length) return;
  if (on === false) return void (queue = []);
  const batch = queue.splice(0, 50);
  if (queue.length) flushTimer = setTimeout(flush, 3000);
  try {
    for (const id of await api!.record(batch)) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
      emit(id);
    }
  } catch {
    batch.forEach((id) => sent.delete(id));
  }
}

if (api && typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flush();
  });
}

// One observer for every post on screen.
const SEEN_AFTER_MS = 1000;
const watched = new Map<Element, { id: string; timer?: ReturnType<typeof setTimeout> }>();
let observer: IntersectionObserver | null = null;

function observe(el: Element, id: string) {
  if (typeof IntersectionObserver === "undefined") return () => {};
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const w = watched.get(e.target);
        if (!w) continue;
        if (e.isIntersecting && e.intersectionRatio >= 0.5) {
          w.timer ??= setTimeout(() => {
            markSeen(w.id);
            observer?.unobserve(e.target);
            watched.delete(e.target);
          }, SEEN_AFTER_MS);
        } else if (w.timer) {
          clearTimeout(w.timer);
          w.timer = undefined;
        }
      }
    },
    { threshold: [0, 0.5] },
  );
  watched.set(el, { id });
  observer.observe(el);
  return () => {
    clearTimeout(watched.get(el)?.timer);
    watched.delete(el);
    observer?.unobserve(el);
  };
}

/**
 * The post's view total (null while unknown or when counting is off), and — when `track` — counts
 * the post as seen once it has been on screen long enough.
 */
export function usePostViews(ref: RefObject<HTMLElement | null>, postId: string, track: boolean): number | null {
  const n = useSyncExternalStore(
    (l) => subscribe(postId, l),
    () => (on === true ? (counts.get(postId) ?? null) : null),
  );
  useEffect(() => {
    if (track) want(postId);
  }, [postId, track]);
  useEffect(() => {
    const el = ref.current;
    if (!track || !api || on === false || sent.has(postId) || !el) return;
    return observe(el, postId);
  }, [ref, postId, track]);
  return n;
}
