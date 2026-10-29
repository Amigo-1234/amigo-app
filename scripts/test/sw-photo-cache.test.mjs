/**
 * The service worker's photo cache (public/sw.js, "photos"), run in a
 * simulated worker: which requests it may answer from the cache, what it
 * stores, and its limits. No network: R2 is simulated.
 *
 *   node scripts/test/sw-photo-cache.test.mjs
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

let failures = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};

// ---- a minimal Cache Storage + fetch
const stores = new Map();
const cacheFor = (name) => {
  if (!stores.has(name)) stores.set(name, new Map());
  const m = stores.get(name);
  const key = (r) => (typeof r === "string" ? r : r.url);
  return {
    match: async (r) => m.get(key(r))?.clone(),
    put: async (r, res) => void m.set(key(r), res),
    delete: async (r) => m.delete(key(r)),
    keys: async () => [...m.keys()].map((url) => ({ url })),
    add: async () => undefined,
  };
};
const caches = { open: async (n) => cacheFor(n), keys: async () => [...stores.keys()], delete: async (n) => stores.delete(n), match: async () => undefined };
const network = [];
let respond = () => new Response(new Uint8Array(1000), { status: 200, headers: { "content-type": "image/jpeg" } });
const fetchImpl = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  network.push({ url, mode: init.mode ?? input.mode });
  const res = respond(url);
  // What a CORS fetch looks like to the worker.
  Object.defineProperty(res, "type", { value: (init.mode ?? "no-cors") === "cors" ? "cors" : "opaque" });
  return res;
};

const listeners = {};
const self = {
  addEventListener: (t, fn) => (listeners[t] = fn),
  skipWaiting: () => undefined,
  clients: { claim: async () => undefined, matchAll: async () => [] },
  registration: { showNotification: async () => undefined },
  location: new URL("https://app.test/"),
};
vm.runInNewContext(readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8"), {
  self, caches, fetch: fetchImpl, Response, Headers, Request, URL, Date, Number, String, Math, Promise, setTimeout,
});

async function get(url, mode = "no-cors") {
  let responded = null;
  const event = { request: new Request(url, { mode: mode === "navigate" ? "same-origin" : mode }), respondWith: (p) => (responded = p) };
  Object.defineProperty(event.request, "mode", { value: mode });
  listeners.fetch(event);
  return responded ? { handled: true, res: await responded } : { handled: false };
}

const amz = (minutesAgo, expires = 5400) => {
  const d = new Date(Date.now() - minutesAgo * 60000).toISOString().replace(/[:-]|\.\d{3}/g, "");
  return `X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=${d}&X-Amz-Expires=${expires}&X-Amz-Signature=abc${minutesAgo}`;
};
const R2 = "https://acct.r2.cloudflarestorage.com/bucket";
const owner = "11111111-2222-3333-4444-555555555555";
const photo = (kind, name = "a".repeat(32), ext = "jpg") => `${R2}/${owner}/${kind}/${name}.${ext}`;

// ---- tests
let r = await get(`${photo("post")}?${amz(1)}`);
ok("a post photo is handled by the cache", r.handled && r.res.ok);
ok("…fetched once, with CORS (storable without opaque padding)", network.length === 1 && network[0].mode === "cors");
r = await get(`${photo("post")}?${amz(40)}`); // a newer window's link for the same photo: different signature
ok("the same photo with a newly signed link comes from the cache (no download)", r.handled && r.res.ok && network.length === 1, String(network.length));

network.length = 0;
r = await get(`${photo("post")}?${amz(200)}`); // signed 200 min ago, valid 90 min: expired
ok("an expired link is never answered from the cache", r.handled && network.length === 1 && network[0].mode !== "cors");

network.length = 0;
r = await get(`${R2}/${owner}/dm/${"b".repeat(32)}.bin?${amz(1)}`);
ok("message attachments (encrypted) are never handled or stored", !r.handled && network.length === 0);
r = await get(`${R2}/${owner}/dm/99999999-2222-3333-4444-555555555555/${"b".repeat(32)}.jpg?${amz(1)}`);
ok("…whatever their extension", !r.handled);
r = await get(`${photo("post")}`);
ok("unsigned requests aren't handled", !r.handled);
r = await get(`https://elsewhere.example.com/${owner}/post/${"c".repeat(32)}.jpg?${amz(1)}`);
ok("other hosts aren't handled", !r.handled);
network.length = 0;
for (const kind of ["business_logo", "business_cover", "business_post"]) {
  r = await get(`${R2}/b/${owner}/${kind}/${"7".repeat(32)}.webp?${amz(1)}`);
  ok(`business photos are handled (${kind})`, r.handled && r.res.ok);
}
r = await get(`${R2}/b/${owner}/business_other/${"7".repeat(32)}.webp?${amz(1)}`);
ok("…but not other business paths", !r.handled);
// Leave the cache as the tests below expect it.
await caches.open("amigo-media-v1").then(async (c) => { for (const k of await c.keys()) if (k.url.includes("/b/")) await c.delete(k); });
network.length = 0;

respond = () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } });
await get(`${photo("post", "d".repeat(32))}?${amz(1)}`);
respond = () => new Response("nope", { status: 403, headers: { "content-type": "application/xml" } });
await get(`${photo("post", "e".repeat(32))}?${amz(1)}`);
respond = () => new Response(new Uint8Array(5 * 1024 * 1024), { status: 200, headers: { "content-type": "image/jpeg" } });
await get(`${photo("post", "f".repeat(32))}?${amz(1)}`);
const stored = (await caches.open("amigo-media-v1").then((c) => c.keys())).map((k) => k.url);
ok("non-images, refusals and very large files aren't stored", stored.length === 1 && stored[0] === photo("post"), JSON.stringify(stored.map((u) => u.slice(-40))));
ok("stored by location only (no signature in the cache key)", !stored[0].includes("X-Amz"));

respond = () => new Response(new Uint8Array(1000), { status: 200, headers: { "content-type": "image/webp" } });
for (let i = 0; i < 320; i++) await get(`${photo("post", i.toString(16).padStart(32, "0"), "webp")}?${amz(1)}`);
await new Promise((r) => setTimeout(r, 50));
const all = (await caches.open("amigo-media-v1").then((c) => c.keys())).map((k) => k.url);
ok("at most 300 photos are kept", all.length <= 300, String(all.length));
ok("…the oldest go first", !all.includes(photo("post")) && all.includes(photo("post", (319).toString(16).padStart(32, "0"), "webp")));

// Moment photos are kept for a day only.
const m = photo("moment", "9".repeat(32));
await get(`${m}?${amz(1)}`);
const c = await caches.open("amigo-media-v1");
const old = await c.match(m);
const h = new Headers(old.headers);
h.set("x-amigo-at", String(Date.now() - 25 * 3600 * 1000));
await c.put(m, new Response(await old.arrayBuffer(), { headers: h }));
network.length = 0;
await get(`${m}?${amz(2)}`);
ok("a Moment photo older than a day is fetched again", network.length === 1);

// Page loads still use the network (offline page only on failure).
network.length = 0;
r = await get("https://app.test/", "navigate");
ok("page loads go to the network", r.handled && network.length === 1);

console.log(failures ? `${failures} FAILED` : "ALL PHOTO CACHE TESTS PASSED");
process.exit(failures ? 1 : 0);
