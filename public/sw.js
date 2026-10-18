// Amigo World service worker — deliberately minimal.
//
// It never caches app data, API responses, messages or keys: only a tiny
// offline page, shown when a page load fails because the device is offline.
// Everything else goes straight to the network, so a new deployment is picked
// up on the next load (hashed assets, index.html served no-cache).
// It also replaces the old cache-first worker: activation deletes every other cache.
const OFFLINE_CACHE = "amigo-offline-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(OFFLINE_CACHE).then((c) => c.add(new Request(OFFLINE_URL, { cache: "reload" }))));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== OFFLINE_CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Only full page loads; every other request is untouched.
  if (req.mode !== "navigate") return;
  event.respondWith(
    fetch(req).catch(async () => (await caches.match(OFFLINE_URL)) ?? new Response("You're offline.", { status: 503 })),
  );
});

// ------------------------------------------------------------------ push
//
// A push only says that something happened and where (e.g. a new message in a
// conversation), encrypted to this device. It never carries message text,
// names or keys, so the notification text is generic. Nothing is shown when
// Amigo is already open and visible on this device.

const ICON = "/icons/icon-192.png";
const BADGE = "/icons/badge-72.png";

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const isDm = data.t === "dm" && /^[0-9a-f-]{36}$/.test(data.c || "");
  const isTest = data.t === "test";
  const url = isDm ? `/messages/${data.c}` : isTest ? "/settings" : "/notifications";
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (!isTest && windows.some((w) => w.visibilityState === "visible" && w.focused)) return;
      await self.registration.showNotification("Amigo", {
        body: isDm ? "You have a new message on Amigo." : isTest ? "Notifications are working on this device." : "You have new activity on Amigo.",
        tag: isDm ? `dm-${data.c}` : isTest ? "test" : "amigo",
        renotify: true,
        icon: ICON,
        badge: BADGE,
        data: { url },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        // Same-origin navigation inside the open app (keeps the session).
        if ("navigate" in open) return void (await open.navigate(url).catch(() => open.postMessage({ type: "amigo:navigate", url })));
        open.postMessage({ type: "amigo:navigate", url });
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
