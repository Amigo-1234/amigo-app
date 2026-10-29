import type { PushStatus } from "../../lib/push";

/** What each push state means for this device (Settings → Notifications, and the opt-in prompt). */
export const PUSH_DETAIL: Record<PushStatus, string> = {
  on: "On. You'll be told about new messages even when Amigo is closed or your phone is locked.",
  off: "Get told about new messages even when Amigo is closed or your phone is locked.",
  "ios-home-screen": "On iPhone and iPad, notifications work once Amigo is on your Home Screen: in Safari tap Share → Add to Home Screen, open Amigo from there, then turn them on here.",
  denied: "Notifications are blocked for Amigo. Allow them in your browser's site settings (or your phone's Settings → Notifications), then come back here.",
  unsupported: "This browser can't show notifications from websites. Try Chrome, Edge, Firefox or Safari.",
  "not-configured": "Notifications aren't available on this version of Amigo yet.",
};

/** A failed attempt to turn notifications on, in words (the reason only; never keys or endpoints). */
export function pushErrorText(e: unknown): string {
  const reason = e instanceof Error ? e.message : String(e);
  // Chrome refuses push in private/incognito windows with this error, after permission was granted.
  return /Registration failed - permission denied/i.test(reason)
    ? "This window can't receive notifications. Private or incognito windows don't support them — try a normal window."
    : "Couldn't change notifications. Try again.";
}
