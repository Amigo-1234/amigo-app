/**
 * The last value of each list a screen subscribed to, kept in this tab's
 * memory only (never written to disk or shared), so going back to a screen
 * shows what was there at once while it refreshes in the background
 * (stale-while-revalidate). The server is asked again on every visit, so
 * nothing here decides what anyone may see. Cleared whenever the signed-in
 * person changes or signs out.
 */
const MAX_ENTRIES = 60;
const values = new Map<string, unknown>();
let owner: string | null | undefined;

/** The signed-in person (null when signed out); a change forgets everything. */
export function setCacheOwner(userId: string | null) {
  if (userId === owner) return;
  values.clear();
  owner = userId;
}

export const cached = <T>(key: string): T | undefined => values.get(key) as T | undefined;

export function remember(key: string, value: unknown) {
  values.delete(key);
  values.set(key, value);
  if (values.size > MAX_ENTRIES) values.delete(values.keys().next().value as string);
}

export const forgetAll = () => values.clear();
