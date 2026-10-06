import { useSyncExternalStore } from "react";

/**
 * Recent searches, kept only in this browser (localStorage). A convenience:
 * if storage is unavailable (private mode, blocked), the list is just empty.
 */
const KEY = "amigo:recent-searches";
const MAX = 8;
const listeners = new Set<() => void>();
let cache: string[] | null = null;

function read(): string[] {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    cache = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string").slice(0, MAX) : [];
  } catch {
    cache = [];
  }
  return cache;
}

function write(list: string[]) {
  cache = list;
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable — keep the in-memory list for this session */
  }
  listeners.forEach((l) => l());
}

export function addRecentSearch(query: string) {
  const q = query.trim();
  if (!q) return;
  write([q, ...read().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, MAX));
}

export function removeRecentSearch(query: string) {
  write(read().filter((x) => x !== query));
}

export function clearRecentSearches() {
  write([]);
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  // Other tabs.
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) {
      cache = null;
      cb();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

export function useRecentSearches(): string[] {
  return useSyncExternalStore(subscribe, read, () => []);
}
