// Amigo World service worker — deliberately small.
//
// It never caches app data, API responses, messages or keys. It keeps:
//   * a tiny offline page, shown when a page load fails because the device is offline;
//   * a bounded cache of public-facing photos (post, avatar and Moment images),
//     so a photo seen before isn't downloaded again — see "photos" below.
// Everything else goes straight to the network, so a new deployment is picked
// up on the next load (hashed assets, index.html served no-cache).
// It also replaces the old cache-first worker: activation deletes every other cache.
const OFFLINE_CACHE = "amigo-offline-v1";
const OFFLINE_URL = "/offline.html";
const MEDIA_CACHE = "amigo-media-v1";
const KEEP = [OFFLINE_CACHE, MEDIA_CACHE];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(OFFLINE_CACHE).then((c) => c.add(new Request(OFFLINE_URL, { cache: "reload" }))));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (isCacheablePhoto(req)) return event.respondWith(photo(req));
  // Otherwise only full page loads; every other request is untouched.
  if (req.mode !== "navigate") return;
  event.respondWith(
    fetch(req).catch(async () => (await caches.match(OFFLINE_URL)) ?? new Response("You're offline.", { status: 503 })),
  );
});

// ---------------------------------------------------------------- photos
//
// Photo links are signed and change every 30 minutes, so the browser's own
// cache (keyed by the full link) misses a photo seen in an earlier window and
// downloads it again. Each stored photo's name is random and its bytes never
// change, so here a photo is cached by its location without the signature.
//
// Privacy and authorization:
//   * Only post, avatar and Moment photos. Message attachments (/dm/) are never
//     cached here (they're ciphertext; the decrypted photo only ever exists in
//     the page's memory).
//   * A cached photo is only served for a link the server signed for this
//     person just now (unexpired), so every use still went through the
//     server's visibility check (blocked, followers-only, deleted, expired Moment).
//   * The app empties this cache on sign-out and when someone else signs in.
// Limits: at most MAX_ENTRIES photos, MAX_ENTRY_BYTES each, oldest out first;
// Moment photos for a day, others for two weeks. The browser may evict it at
// any time (iOS does after a few weeks unused); then photos simply download.

const MAX_ENTRIES = 300;
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const DAY = 24 * 3600 * 1000;
const PHOTO_PATH = /^\/[^/]+\/(?:[0-9a-f-]{36}\/(avatar|post|moment)\/(?:[0-9a-f-]{36}\/)?|b\/[0-9a-f-]{36}\/business_(?:logo|cover|post)\/)[0-9a-f]{32}(?:-sm)?\.(jpg|png|webp|gif)$/;

function isCacheablePhoto(req) {
  if (req.method !== "GET") return false;
  const url = new URL(req.url);
  return url.hostname.endsWith(".r2.cloudflarestorage.com") && PHOTO_PATH.test(url.pathname) && url.searchParams.has("X-Amz-Signature");
}

/** The link is currently valid (signed recently for whoever is asking). */
function linkValid(url) {
  const date = url.searchParams.get("X-Amz-Date") || "";
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(date);
  if (!m) return false;
  const start = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const expires = Number(url.searchParams.get("X-Amz-Expires") || 0) * 1000;
  return Date.now() >= start - 5 * 60 * 1000 && Date.now() < start + expires;
}

async function photo(req) {
  const url = new URL(req.url);
  if (!linkValid(url)) return fetch(req);
  const key = url.origin + url.pathname;
  const maxAge = url.pathname.includes("/moment/") ? DAY : 14 * DAY;
  const cache = await caches.open(MEDIA_CACHE);
  const hit = await cache.match(key);
  if (hit && Date.now() - Number(hit.headers.get("x-amigo-at") || 0) < maxAge) return hit;
  // A readable (CORS) response, so it can be stored without the large size
  // padding browsers apply to opaque ones; <img> accepts it as well.
  const res = await fetch(url.href, { mode: "cors", credentials: "omit" }).catch(() => null);
  if (!res || !res.ok || res.type !== "cors" || !/^image\//.test(res.headers.get("content-type") || "")) return res ?? fetch(req);
  const bytes = await res.clone().arrayBuffer();
  if (bytes.byteLength <= MAX_ENTRY_BYTES) {
    const headers = new Headers(res.headers);
    headers.set("x-amigo-at", String(Date.now()));
    await cache.put(key, new Response(bytes, { status: 200, headers })).catch(() => undefined);
    await trim(cache);
  }
  return res;
}

let trimming = null;
function trim(cache) {
  // Oldest entries out first (Cache Storage keeps insertion order).
  return (trimming ??= (async () => {
    try {
      const keys = await cache.keys();
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) await cache.delete(k);
    } finally {
      trimming = null;
    }
  })());
}

// ------------------------------------------------------------------ push
//
// A push says that something happened and where, encrypted to this device.
// Message pushes never carry message text, names or keys, so their text is
// generic. Activity pushes (likes, replies, follows, support) carry the
// person's display name and a count — never post text. Nothing is shown
// when Amigo is already open and visible on this device.

const ICON = "/icons/icon-192.png";
const BADGE = "/icons/badge-72.png";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACTIONS = {
  like: (d) => (d.x ? "liked your reply" : "liked your post"),
  reply: () => "replied to your post",
  mention: () => "mentioned you",
  follow: () => "started following you",
  support: () => "supported your request",
};

/** "Ada liked your post" / "Ada and 3 others liked your post", where to open, and a tag (one notification per target). */
function activity(d) {
  const action = ACTIONS[d.k];
  if (!action) return null;
  const post = UUID.test(d.p || "") ? d.p : null;
  const request = UUID.test(d.r || "") ? d.r : null;
  const name = String(d.a || "Someone").slice(0, 40);
  const others = Math.max(0, Math.min(999, (Number(d.n) || 1) - 1));
  const who = others ? `${name} and ${others} ${others === 1 ? "other" : "others"}` : name;
  return {
    body: `${who} ${action(d)}.`,
    url: post ? `/post/${post}` : request ? `/support/${request}` : "/notifications",
    tag: `act-${d.k}-${post || request || "you"}`,
  };
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const isDm = data.t === "dm" && /^[0-9a-f-]{36}$/.test(data.c || "");
  const isTest = data.t === "test";
  const isWorld = data.t === "world" && /^[a-z0-9-]{3,60}$/.test(data.s || "");
  const act = data.t === "act" ? activity(data) : null;
  const url = isDm ? `/messages/${data.c}` : isTest ? "/settings" : isWorld ? `/worlds/${data.s}` : act ? act.url : "/notifications";
  const worldText =
    isWorld && data.k === "cancelled" ? `“${String(data.n || "A World")}” was cancelled.` : isWorld ? `“${String(data.n || "A World you joined")}” is live now — come join in.` : "";
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (!isTest && windows.some((w) => w.visibilityState === "visible" && w.focused)) return;
      await self.registration.showNotification("Amigo", {
        body: isDm ? "You have a new message on Amigo." : isTest ? "Notifications are working on this device." : isWorld ? worldText : act ? act.body : "You have new activity on Amigo.",
        tag: isDm ? `dm-${data.c}` : isTest ? "test" : isWorld ? `world-${data.s}` : act ? act.tag : "amigo",
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
