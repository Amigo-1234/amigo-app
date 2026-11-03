/**
 * @mentions — the same rule as public.mentioned_usernames() in
 * supabase/migrations/20261006150000_notifications.sql, so what renders as a
 * mention is exactly what notifies: "@" + 3–24 of [a-z0-9_], not preceded by a
 * word character, "@" or "." (so emails aren't mentions). Case-insensitive.
 */
export const MENTION_RE = /(^|[^A-Za-z0-9_@.])@([A-Za-z0-9_]{3,24})(?![A-Za-z0-9_])/g;

/** Lower-cased, distinct, in order of first appearance, at most 10. */
export function mentionedHandles(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    const h = m[2].toLowerCase();
    if (!out.includes(h)) out.push(h);
    if (out.length === 10) break;
  }
  return out;
}
