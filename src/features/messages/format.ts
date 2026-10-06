import type { MessageStatus } from "../../data";

const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" });
const dayMonth = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
const dayMonthYear = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

export const clockTime = (d: Date) => clock.format(d);

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Day separator label: "Today", "Yesterday", "Monday", "Tue, Mar 4", "Mar 4, 2025". */
export function dayLabel(d: Date, now = new Date()): string {
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return weekday.format(d);
  return (d.getFullYear() === now.getFullYear() ? dayMonth : dayMonthYear).format(d);
}

export const sameDay = (a: Date, b: Date) => startOfDay(a) === startOfDay(b);

export const STATUS_LABEL: Record<MessageStatus, string> = {
  sending: "Sending…",
  failed: "Not sent",
  sent: "Sent",
  delivered: "Delivered",
  read: "Read",
};
