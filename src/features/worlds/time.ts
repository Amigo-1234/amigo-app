import { useEffect, useState } from "react";
import type { World, WorldStatus } from "../../data";

/** Re-renders every `ms` so countdowns tick and Worlds flip live/finished on time. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function worldStatus(w: Pick<World, "startsAt" | "endsAt">, now = Date.now()): WorldStatus {
  if (now < w.startsAt.getTime()) return "upcoming";
  if (now < w.endsAt.getTime()) return "live";
  return "finished";
}

/** Entries are open while the World is live and before entriesCloseAt. */
export function entriesOpen(w: World, now = Date.now()): boolean {
  return !!w.competition && worldStatus(w, now) === "live" && now < w.competition.entriesCloseAt.getTime();
}

/** "2d 4h", "3h 12m", "12m 05s", "45s". */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

/** Spoken form for screen readers: "2 days 4 hours", "12 minutes". Coarser, so it isn't re-announced every second. */
export function countdownLong(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const plural = (n: number, u: string) => `${n} ${u}${n === 1 ? "" : "s"}`;
  if (d > 0) return `${plural(d, "day")}${h ? ` ${plural(h, "hour")}` : ""}`;
  if (h > 0) return `${plural(h, "hour")}${m ? ` ${plural(m, "minute")}` : ""}`;
  if (m > 0) return plural(m, "minute");
  return "less than a minute";
}

const when = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
export const formatWhen = (d: Date) => when.format(d);

/** One-line status label: "Live · ends in 1h 12m", "Starts in 3h 10m", "Ended Tue, Oct 5". */
export function statusLine(w: World, now: number): { status: WorldStatus; text: string; spoken: string } {
  const status = worldStatus(w, now);
  if (status === "upcoming") {
    const left = w.startsAt.getTime() - now;
    return { status, text: `Starts in ${countdown(left)}`, spoken: `Starts in ${countdownLong(left)}` };
  }
  if (status === "live") {
    const left = w.endsAt.getTime() - now;
    return { status, text: `Ends in ${countdown(left)}`, spoken: `Live now, ends in ${countdownLong(left)}` };
  }
  return { status, text: `Ended ${formatWhen(w.endsAt)}`, spoken: `Ended ${formatWhen(w.endsAt)}` };
}

const timeOnly = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
/** "Tue, Oct 6, 10:49 AM – 12:49 PM" (same day) or the full range across days. */
export function formatSpan(a: Date, b: Date): string {
  return a.toDateString() === b.toDateString() ? `${formatWhen(a)} – ${timeOnly.format(b)}` : `${formatWhen(a)} – ${formatWhen(b)}`;
}
