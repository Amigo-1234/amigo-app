import { useEffect, useReducer, useState, type ImgHTMLAttributes, type RefObject } from "react";

/**
 * Turning "/api/media/<key>" into a signed link to the private bucket.
 *
 * Without this, every <img> asks the media function on its own: one function
 * call, a session lookup and a Postgres check per image, then a redirect. Here
 * the images a screen shows are collected for a moment and checked together
 * (POST /api/media-sign, one Postgres call), and the links are kept in this
 * tab's memory until a few minutes before they expire. Links are signed per
 * 30-minute window, so the same photo keeps the same URL and the browser's
 * own cache serves it again without downloading. Nothing is stored on disk;
 * the list is forgotten when the signed-in person changes.
 *
 * Anything else (blob: previews, external avatars) passes through unchanged.
 * If signing fails, the image falls back to the media function itself.
 */
export type MediaSize = "full" | "sm";
type Signed = { links: Record<string, { url: string; small?: string }>; ttl: number };
type Signer = (keys: string[]) => Promise<Signed>;

const PREFIX = "/api/media/";
const BATCH = 60;
const MARGIN_S = 300;
const RETRY_MS = 30_000;

let signer: Signer | null = null;
const links = new Map<string, { url: string; small?: string; until: number }>();
const refused = new Map<string, number>();
const queued = new Set<string>();
const inFlight = new Set<string>();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

export function setMediaSigner(fn: Signer | null) {
  signer = fn;
  if (fn) preconnect(storedOrigin());
}

// The bucket's address, remembered between visits so the connection to it
// (DNS + TLS: about a second on 3G) is opened while the app starts, not when
// the first photo is requested. Only the host name is kept.
const ORIGIN_KEY = "amigo:media-origin";
function storedOrigin(): string | null {
  try {
    return localStorage.getItem(ORIGIN_KEY);
  } catch {
    return null;
  }
}
const preconnected = new Set<string>();
function preconnect(origin: string | null) {
  if (!origin || preconnected.has(origin) || typeof document === "undefined" || !/^https:\/\/[a-z0-9.-]+$/.test(origin)) return;
  preconnected.add(origin);
  const link = document.createElement("link");
  link.rel = "preconnect";
  link.href = origin;
  document.head.appendChild(link);
}
function rememberOrigin(url: string) {
  const origin = new URL(url).origin;
  preconnect(origin);
  try {
    if (localStorage.getItem(ORIGIN_KEY) !== origin) localStorage.setItem(ORIGIN_KEY, origin);
  } catch {
    /* storage unavailable */
  }
}

// ------------------------------------------------------- the photo cache
//
// The service worker keeps photos this browser was shown (public/sw.js,
// "photos"). It belongs to one person at a time: emptied on sign-out and when
// someone else signs in on this browser. Only the owner's id is remembered.
const MEDIA_CACHE = "amigo-media-v1";
const OWNER_KEY = "amigo:media-owner";

/** Empties this browser's photo cache (sign-out, account deleted). */
export async function clearMediaCache() {
  try {
    localStorage.removeItem(OWNER_KEY);
  } catch {
    /* storage unavailable */
  }
  if (typeof caches !== "undefined") await caches.delete(MEDIA_CACHE).catch(() => false);
}

/** Someone is signed in: if it isn't whoever the cached photos were shown to, empty the cache first. */
export function setMediaOwner(userId: string) {
  let previous: string | null = null;
  try {
    previous = localStorage.getItem(OWNER_KEY);
    if (previous !== userId) localStorage.setItem(OWNER_KEY, userId);
  } catch {
    /* storage unavailable: the cache still empties on sign-out */
  }
  if (previous && previous !== userId && typeof caches !== "undefined") void caches.delete(MEDIA_CACHE).catch(() => false);
}

/** The signed-in person changed: links signed for the previous one are dropped. */
export function forgetMediaLinks() {
  links.clear();
  refused.clear();
  queued.clear();
}

export const mediaKey = (src: string | null | undefined): string | null =>
  src && src.startsWith(PREFIX) ? src.slice(PREFIX.length).split("?")[0] : null;

/** The media function itself (checks on each request, by session cookie). */
const routed = (key: string, size: MediaSize) => `${PREFIX}${key}${size === "sm" ? "?size=sm" : ""}`;

/** A usable URL now, or undefined while its link is being signed. */
export function mediaSrc(src: string | null | undefined, size: MediaSize = "full"): string | undefined {
  const key = mediaKey(src);
  if (!key) return src ?? undefined;
  if (!signer || (refused.get(key) ?? 0) > Date.now()) return routed(key, size);
  const link = links.get(key);
  if (link && link.until > Date.now()) return size === "sm" ? (link.small ?? link.url) : link.url;
  request(key);
  return undefined;
}

/** Start signing these now (e.g. as soon as a list of posts arrives, before it renders). */
export function primeMedia(srcs: (string | null | undefined)[]) {
  for (const s of srcs) mediaSrc(s);
}

function request(key: string) {
  if (inFlight.has(key) || queued.has(key)) return;
  queued.add(key);
  timer ??= setTimeout(flush, 0);
}

async function flush() {
  timer = null;
  const keys = [...queued].slice(0, BATCH);
  keys.forEach((k) => (queued.delete(k), inFlight.add(k)));
  if (queued.size) timer = setTimeout(flush, 0);
  try {
    const { links: got, ttl } = await signer!(keys);
    const until = Date.now() + Math.max(0, ttl - MARGIN_S) * 1000;
    const first = Object.values(got)[0];
    if (first) rememberOrigin(first.url);
    for (const k of keys) {
      if (got[k]) links.set(k, { ...got[k], until });
      // Not visible to this person (or gone): the media function answers the same way.
      else refused.set(k, Date.now() + RETRY_MS);
    }
  } catch {
    for (const k of keys) refused.set(k, Date.now() + RETRY_MS);
  } finally {
    keys.forEach((k) => inFlight.delete(k));
    listeners.forEach((l) => l());
  }
  // Keep the map small: drop expired links.
  if (links.size > 2000) for (const [k, v] of links) if (v.until < Date.now()) links.delete(k);
}

export function useMediaSrc(src: string | null | undefined, size: MediaSize = "full"): string | undefined {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const value = mediaSrc(src, size);
  useEffect(() => {
    if (value !== undefined) return;
    listeners.add(rerender);
    return () => void listeners.delete(rerender);
  }, [value]);
  return value;
}

type ImgProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & { src: string | null | undefined; size?: MediaSize };

/**
 * <img> for app media. If the small copy fails it shows the full photo; if a
 * signed link fails it asks the media function directly; only then onError.
 */
export function MediaImg({ src, size = "full", onError, style, ...rest }: ImgProps) {
  const [step, setStep] = useState(0);
  const [from, setFrom] = useState(src);
  if (from !== src) {
    setFrom(src);
    setStep(0);
  }
  const key = mediaKey(src);
  const signed = useMediaSrc(src, step === 0 ? size : "full");
  const url = !key ? (src ?? undefined) : step >= 2 ? routed(key, size) : signed;
  const lastStep = !key ? 0 : 2;
  return (
    <img
      {...rest}
      src={url}
      style={url ? style : { ...style, visibility: "hidden" }}
      onError={(e) => {
        if (!url) return;
        if (step < lastStep) setStep(step === 0 && size === "full" ? 2 : step + 1);
        else onError?.(e);
      }}
    />
  );
}

// ----------------------------------------------------------- preloading
//
// The browser's own lazy loading starts an image only when it's almost on
// screen (on iPhone, very close). Photos about one screen ahead start loading
// a little earlier, so they're usually ready when scrolled to — a few posts
// ahead, never the whole feed. Off when the phone asks to save data or is on 2G.
const saveData = () => {
  const c = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  return !!c?.saveData || /(^|-)2g$/.test(c?.effectiveType ?? "");
};
let nearObserver: IntersectionObserver | null = null;
const nearCallbacks = new WeakMap<Element, () => void>();
function observeNear(el: Element, onNear: () => void): () => void {
  if (typeof IntersectionObserver === "undefined" || saveData()) return () => {};
  nearObserver ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        nearCallbacks.get(e.target)?.();
        nearObserver?.unobserve(e.target);
      }
    },
    { rootMargin: "0px 0px 100% 0px" },
  );
  nearCallbacks.set(el, onNear);
  nearObserver.observe(el);
  return () => nearObserver?.unobserve(el);
}

/** True once the element is within about a screen below the viewport (then stays true). */
export function useNearScreen(ref: RefObject<Element | null>): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    return observeNear(el, () => setNear(true));
  }, [ref, near]);
  return near;
}
