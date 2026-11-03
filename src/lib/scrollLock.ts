/**
 * Keeps the page behind a full-screen overlay (a Moment, a photo) exactly
 * where it is while the overlay is open, and puts it back on close.
 *
 * `overflow: hidden` alone doesn't stop touch scrolling on iOS Safari (and a
 * <dialog> doesn't either: a drag on it scrolls the document underneath), so:
 *   - the body is pinned with `position: fixed` at the current offset;
 *   - <html> gets `.scroll-locked` (overflow hidden, no overscroll bounce);
 *   - touchmove is cancelled unless it scrolls something inside the overlay
 *     that can still scroll that way (a "Seen by" list, a long sheet);
 *   - `--viewport-h` holds the height of the area actually on screen (the
 *     visual viewport: below Safari's bars, above the keyboard), for sizing.
 *
 * Locks nest (a sheet over a Moment, a photo over a sheet): the page is only
 * released when the last one is. Each release function works once, so a
 * close that runs twice (a gesture and a route change) can't unbalance it.
 */
let depth = 0;
let release: (() => void) | null = null;

export function lockPageScroll(): () => void {
  if (typeof document === "undefined") return () => undefined;
  depth++;
  if (depth === 1) release = pin();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    depth--;
    if (depth === 0) {
      const r = release;
      release = null;
      r?.();
    }
  };
}

/** Whether the page is locked now (for tests). */
export const pageScrollLocked = () => depth > 0;

type Style = "position" | "top" | "left" | "right" | "width" | "overflow";
const PINNED: Record<Style, string> = { position: "fixed", top: "", left: "0", right: "0", width: "100%", overflow: "hidden" };

function pin(): () => void {
  const root = document.documentElement;
  const body = document.body;
  const x = window.scrollX;
  const y = window.scrollY;
  const prev = {} as Record<Style, string>;
  for (const k of Object.keys(PINNED) as Style[]) prev[k] = body.style[k];
  Object.assign(body.style, { ...PINNED, top: `-${y}px` });
  root.classList.add("scroll-locked");

  const vv = window.visualViewport;
  const measure = () => root.style.setProperty("--viewport-h", `${Math.round(vv?.height ?? window.innerHeight)}px`);
  measure();
  vv?.addEventListener("resize", measure);
  window.addEventListener("resize", measure);

  let lastY = 0;
  const onStart = (e: TouchEvent) => {
    lastY = e.touches[0]?.clientY ?? 0;
  };
  const onMove = (e: TouchEvent) => {
    if (e.touches.length !== 1) return; // pinches are the overlay's (it handles or blocks them)
    const y1 = e.touches[0].clientY;
    const dy = lastY - y1; // > 0: content would move up (scrolling down)
    lastY = y1;
    if (!canScroll(e.target, dy) && e.cancelable) e.preventDefault();
  };
  document.addEventListener("touchstart", onStart, { passive: true, capture: true });
  document.addEventListener("touchmove", onMove, { passive: false, capture: true });

  return () => {
    document.removeEventListener("touchstart", onStart, { capture: true });
    document.removeEventListener("touchmove", onMove, { capture: true });
    vv?.removeEventListener("resize", measure);
    window.removeEventListener("resize", measure);
    root.style.removeProperty("--viewport-h");
    root.classList.remove("scroll-locked");
    Object.assign(body.style, prev);
    window.scrollTo({ left: x, top: y, behavior: "instant" as ScrollBehavior });
  };
}

/** Some element from the touch target up (stopping at the page) can scroll by dy vertically. */
function canScroll(target: EventTarget | null, dy: number): boolean {
  let el = target instanceof Element ? target : null;
  while (el && el !== document.body && el !== document.documentElement) {
    if (el instanceof HTMLElement && el.scrollHeight > el.clientHeight + 1) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === "auto" || oy === "scroll") {
        if (dy > 0 && el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true;
        if (dy < 0 && el.scrollTop > 0) return true;
        if (dy === 0) return true;
      }
    }
    el = el.parentElement;
  }
  return false;
}
