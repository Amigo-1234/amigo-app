import type { PushStatus } from "../../lib/push";

/**
 * The opt-in prompt on Home, and when it shows. One decision per device and account:
 *
 *   ask     notifications are off and this browser was never asked (permission "default")
 *   denied  blocked in the browser: how to allow them (the browser won't ask again)
 *   ios     iPhone/iPad in Safari: add Amigo to the Home Screen first
 *   null    nothing to say: already on, decided before (permission "granted" but turned off
 *           in Settings), unsupported, not set up on this deployment, still checking, or dismissed
 *
 * Once dismissed ("Maybe later", "Got it", or turning them on) it doesn't come back on this
 * device; Settings → Notifications stays the place to change it.
 */
export type PromptView = "ask" | "denied" | "ios" | null;

export function promptView(status: PushStatus | null, permission: NotificationPermission | null, dismissed: boolean): PromptView {
  if (dismissed || status === null) return null;
  if (status === "ios-home-screen") return "ios";
  if (status === "denied") return "denied";
  if (status === "off" && permission === "default") return "ask";
  return null;
}

const key = (viewerId: string) => `amigo:push-prompt:${viewerId}`;

export function promptDismissed(viewerId: string): boolean {
  try {
    return localStorage.getItem(key(viewerId)) === "dismissed";
  } catch {
    return false;
  }
}

export function dismissPrompt(viewerId: string) {
  try {
    localStorage.setItem(key(viewerId), "dismissed");
  } catch {
    /* private mode: it may show again next visit */
  }
}

/** The browser's notification permission, or null where there's no Notification API. */
export const notificationPermission = (): NotificationPermission | null =>
  typeof Notification === "undefined" ? null : Notification.permission;
