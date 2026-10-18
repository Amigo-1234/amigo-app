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
