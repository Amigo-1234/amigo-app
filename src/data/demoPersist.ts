/**
 * Demo-only persistence: the whole demo state is saved to this browser's
 * IndexedDB after every change and restored on load, so edits (a new
 * username, posts, follows, Worlds, Support Hub, messages…) survive a refresh.
 * IndexedDB keeps Dates, Sets, Maps and image Blobs as they are.
 *
 * Never used by Firebase or Supabase builds (this module is only imported by
 * the demo source). Reset: Settings → "Reset demo data", or open ?demo=reset.
 */
const DB_NAME = "amigo-demo";
const STORE = "state";
/** Bump when the saved shape changes; older saves are then ignored. */
const KEY = "v1";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** The saved state, or null (nothing saved, private mode, or IndexedDB unavailable). */
export async function loadDemoState<T>(): Promise<T | null> {
  try {
    return ((await run("readonly", (s) => s.get(KEY))) as T | undefined) ?? null;
  } catch {
    return null;
  }
}

let pending: ReturnType<typeof setTimeout> | undefined;
let latest: (() => unknown) | null = null;
/** Set by a reset, so nothing is saved again before the page reloads. */
let stopped = false;

async function writeNow() {
  if (!latest) return;
  const snapshot = latest();
  latest = null;
  try {
    await run("readwrite", (s) => s.put(snapshot, KEY));
  } catch (e) {
    console.warn("Demo state couldn't be saved", e);
  }
}

/** Debounced save. `snapshot` is called when the write happens, so it captures the latest state. */
export function saveDemoState(snapshot: () => unknown) {
  if (stopped) return;
  latest = snapshot;
  clearTimeout(pending);
  pending = setTimeout(() => void writeNow(), 300);
}

if (typeof window !== "undefined") {
  // Don't lose the last change when the tab is closed or reloaded right after it.
  window.addEventListener("pagehide", () => {
    clearTimeout(pending);
    void writeNow();
  });
}

/** Deletes the saved state. With `stop`, nothing more is saved in this page (the caller reloads). */
export async function clearDemoState({ stop = false } = {}) {
  if (stop) stopped = true;
  clearTimeout(pending);
  latest = null;
  try {
    await run("readwrite", (s) => s.delete(KEY));
  } catch {
    /* nothing saved */
  }
}
