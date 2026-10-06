const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "narrow" });
const shortDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const longDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const full = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Compact relative label used in feeds: "now", "4m", "3h", "2d", "Mar 4". */
export function timeAgo(date: Date | null, now = Date.now()): string {
  if (!date) return "now";
  const s = Math.round((now - date.getTime()) / 1000);
  if (s < 45) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return (sameYear ? shortDate : longDate).format(date);
}

/** Screen-reader friendly relative label: "4 minutes ago". */
export function timeAgoLong(date: Date | null): string {
  if (!date) return "just now";
  const s = Math.round((date.getTime() - Date.now()) / 1000);
  const abs = Math.abs(s);
  if (abs < 60) return rtf.format(Math.round(s), "second");
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(s / 3600), "hour");
  return rtf.format(Math.round(s / 86400), "day");
}

export function fullTimestamp(date: Date | null): string {
  return date ? full.format(date) : "Just now";
}
