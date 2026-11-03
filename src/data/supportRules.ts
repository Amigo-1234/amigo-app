/**
 * Support Hub rules shared by the UI and the demo source. The Supabase
 * migration (20261006170000_support_hub.sql) implements the same validation
 * and ranking in SQL — keep the two in step.
 */
import type { SupportAsk, SupportCategory, SupportConfig, SupportReaction } from "./types";
import { SUPPORT_LIMITS } from "./types";

export const SUPPORT_CATEGORIES: { id: SupportCategory; label: string }[] = [
  { id: "music", label: "Music" },
  { id: "video", label: "Video" },
  { id: "app", label: "App / project" },
  { id: "business", label: "Business" },
  { id: "design", label: "Design" },
  { id: "social", label: "Social page" },
  { id: "other", label: "Other" },
];

export const SUPPORT_ASKS: { id: SupportAsk; label: string; verb: string }[] = [
  { id: "listen", label: "Listen and give feedback", verb: "Listen" },
  { id: "watch", label: "Watch and give feedback", verb: "Watch" },
  { id: "try", label: "Try it and give feedback", verb: "Try it" },
  { id: "visit", label: "Visit and give feedback", verb: "Visit" },
  { id: "read", label: "Read and give feedback", verb: "Read" },
];

export const SUPPORT_REACTIONS: { id: SupportReaction; label: string }[] = [
  { id: "loved", label: "Loved it" },
  { id: "useful", label: "Useful" },
  { id: "nice", label: "Nice work" },
  { id: "keep_going", label: "Keep going" },
];

export const categoryLabel = (c: SupportCategory) => SUPPORT_CATEGORIES.find((x) => x.id === c)?.label ?? c;
export const askOf = (a: SupportAsk) => SUPPORT_ASKS.find((x) => x.id === a) ?? SUPPORT_ASKS[3];
export const reactionLabel = (r: SupportReaction) => SUPPORT_REACTIONS.find((x) => x.id === r)?.label ?? r;

/** Same defaults as the support_settings row in the Supabase migration. */
export const DEFAULT_SUPPORT_CONFIG: SupportConfig = {
  requestCost: 5,
  starterCredits: 5,
  supportCredits: 1,
  supportReputation: 2,
  feedbackCredits: 1,
  feedbackReputation: 1,
  defaultTarget: 10,
  minTarget: 3,
  maxTarget: 50,
  moderation: true,
  minVisitSeconds: 5,
};

/** Confirmations faster than this are listed for admins as "quick". */
export const QUICK_CONFIRM_SECONDS = 20;
/** More than this many supports within BURST_WINDOW_MIN minutes is listed as a burst. */
export const BURST_COUNT = 5;
export const BURST_WINDOW_MIN = 10;

/**
 * http(s) links only, with a real host. Returns the normalised URL or an error message.
 * Rejects javascript:/data: and anything without a dotted hostname.
 */
export function checkSupportUrl(raw: string): { ok: true; url: string; host: string } | { ok: false; error: string } {
  const value = raw.trim();
  if (!value) return { ok: false, error: "Add the link people should visit." };
  if (value.length > SUPPORT_LIMITS.urlMax) return { ok: false, error: "That link is too long." };
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return { ok: false, error: "That doesn't look like a link." };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, error: "Use a web link (https://…)." };
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(u.hostname) || u.username || u.password) return { ok: false, error: "That doesn't look like a link." };
  return { ok: true, url: u.toString(), host: u.hostname.replace(/^www\./, "") };
}

export const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** Deterministic 0–1 jitter per viewer, request and day, so "For you" rotates daily without being random on every load. */
export function dailyJitter(requestId: string, viewerId: string, day = new Date().toISOString().slice(0, 10)): number {
  let h = 2166136261;
  for (const c of `${requestId}:${viewerId}:${day}`) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h / 4294967296;
}

/**
 * "For you" score. No follower counts and no fake engagement: only freshness,
 * how much support is still needed, the viewer's own category history, whether
 * the viewer has opened it, the creator's earned reputation, and Amigo featuring.
 */
export function forYouScore(r: {
  ageHours: number;
  supporterCount: number;
  target: number;
  categoryMatch: boolean;
  seen: boolean;
  creatorReputation: number;
  featured: boolean;
  jitter: number;
}): number {
  const freshness = Math.exp(-r.ageHours / 48);
  const need = Math.max(0, 1 - r.supporterCount / r.target);
  const rep = Math.min(Math.log(1 + Math.max(0, r.creatorReputation)) / Math.log(101), 1);
  return (r.featured ? 3 : 0) + 2 * freshness + 2 * need + (r.categoryMatch ? 1 : 0) + (r.seen ? 0 : 1) + rep + 0.75 * r.jitter;
}
