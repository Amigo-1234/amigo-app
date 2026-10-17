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
