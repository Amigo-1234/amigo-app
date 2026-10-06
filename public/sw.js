// Kill-switch service worker.
// Earlier versions of Amigo World registered a cache-first worker that would
// keep serving the old UI forever. Browsers re-fetch /sw.js on navigation, pick
// up this version, and it clears every cache and unregisters itself.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: "window" });
      clients.forEach((c) => c.navigate(c.url));
    })()
  );
});
