import type { PushApi } from "../data";
import { isStandalone } from "./install";

/**
 * Turning notifications on for this device (standard Web Push). Always started
 * by a tap — browsers block permission prompts that appear on their own.
 *
 * iPhone and iPad: Web Push works only for Amigo added to the Home Screen
 * (iOS 16.4 or later), opened from there.
 */
export type PushStatus =
  | "unsupported" // this browser can't receive Web Push
  | "ios-home-screen" // iPhone/iPad: add to the Home Screen first
  | "not-configured" // this deployment has no push key
  | "denied" // blocked in browser or system settings
  | "off"
  | "on";

const appleMobile = () =>
  typeof navigator !== "undefined" &&
  (/iphone|ipad|ipod/i.test(navigator.userAgent) || (/macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1));

const supported = () => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

export async function pushStatus(api: PushApi): Promise<PushStatus> {
  if (!supported()) return appleMobile() && !isStandalone() ? "ios-home-screen" : "unsupported";
  if (appleMobile() && !isStandalone()) return "ios-home-screen";
  if (!(await api.publicKey())) return "not-configured";
  if (Notification.permission === "denied") return "denied";
  const sub = await (await registration())?.pushManager.getSubscription();
  if (!sub || Notification.permission !== "granted") return "off";
  // Removed from another device's list: this one is off too.
  if (!(await api.touch(sub.endpoint).catch(() => true))) {
    await sub.unsubscribe().catch(() => undefined);
    return "off";
  }
  return "on";
}

/** "iPhone · Safari", "Android · Chrome"… — so people can tell their devices apart. */
export function deviceLabel(ua = navigator.userAgent): string {
  const os = /iphone/i.test(ua)
    ? "iPhone"
    : /ipad/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1)
      ? "iPad"
      : /android/i.test(ua)
        ? "Android"
        : /windows/i.test(ua)
          ? "Windows"
          : /mac os/i.test(ua)
            ? "Mac"
            : /linux|cros/i.test(ua)
              ? "Linux"
              : "Device";
  const browser = /edg\//i.test(ua)
    ? "Edge"
    : /samsungbrowser/i.test(ua)
      ? "Samsung Internet"
      : /firefox|fxios/i.test(ua)
        ? "Firefox"
        : /chrome|crios/i.test(ua)
          ? "Chrome"
          : /safari/i.test(ua)
            ? "Safari"
            : "Browser";
  return `${os} · ${browser}${isStandalone() ? " (app)" : ""}`;
}

const keyBytes = (b64url: string) => {
  const s = atob(b64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64url.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

async function register(api: PushApi, sub: PushSubscription) {
  const json = sub.toJSON() as { endpoint: string; keys?: { p256dh?: string; auth?: string } };
  if (!json.keys?.p256dh || !json.keys.auth) throw new Error("This browser didn't provide push keys.");
  await api.subscribe({ endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth, label: deviceLabel() });
}

/** Asks for permission (call from a tap) and registers this device. */
export async function enablePush(api: PushApi): Promise<PushStatus> {
  const status = await pushStatus(api);
  if (status !== "off" && status !== "on") return status;
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";
  const reg = (await registration()) ?? (await navigator.serviceWorker.register("/sw.js"));
  await navigator.serviceWorker.ready;
  const key = await api.publicKey();
  if (!key) return "not-configured";
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) as BufferSource }));
  await register(api, sub);
  return "on";
}

export async function disablePush(api: PushApi): Promise<void> {
  const sub = await (await registration())?.pushManager.getSubscription();
  if (!sub) return;
  await api.unsubscribe(sub.endpoint).catch(() => undefined);
  await sub.unsubscribe();
}

/**
 * At startup: keeps this device registered to whoever is signed in now (and
 * re-subscribes if the server's key changed). Never prompts, and never brings
 * back a device that was removed from the device list.
 */
export async function refreshPush(api: PushApi): Promise<void> {
  if (!supported() || Notification.permission !== "granted") return;
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (!reg || !sub) return;
  const key = await api.publicKey();
  if (!key) return;
  const current = sub.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
  const wanted = keyBytes(key);
  if (current && (current.length !== wanted.length || current.some((b, i) => b !== wanted[i]))) {
    await api.unsubscribe(sub.endpoint).catch(() => undefined);
    await sub.unsubscribe();
    await register(api, await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: wanted as BufferSource }));
    return;
  }
  if (!(await api.touch(sub.endpoint).catch(() => true))) await sub.unsubscribe().catch(() => undefined);
}
