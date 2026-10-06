/**
 * A lightweight local draft of the post being written: text only. Photos are
 * never persisted (they can be large and private); the draft just remembers
 * how many there were so we can say so when offering to restore.
 */
export interface Draft {
  text: string;
  mediaCount: number;
  savedAt: number;
}

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const key = (viewerId: string) => `amigo:draft:${viewerId}`;

export function loadDraft(viewerId: string): Draft | null {
  try {
    const d = JSON.parse(localStorage.getItem(key(viewerId)) ?? "null") as Draft | null;
    if (!d || typeof d.text !== "string" || !d.text.trim()) return null;
    if (Date.now() - d.savedAt > MAX_AGE_MS) {
      clearDraft(viewerId);
      return null;
    }
    return d;
  } catch {
    return null;
  }
}

export function saveDraft(viewerId: string, text: string, mediaCount: number) {
  try {
    if (!text.trim()) return clearDraft(viewerId);
    localStorage.setItem(key(viewerId), JSON.stringify({ text: text.slice(0, 2000), mediaCount, savedAt: Date.now() }));
  } catch {
    /* storage unavailable — drafts are a convenience */
  }
}

export function clearDraft(viewerId: string) {
  try {
    localStorage.removeItem(key(viewerId));
  } catch {
    /* ignore */
  }
}
