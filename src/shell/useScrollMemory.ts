import { useEffect, useLayoutEffect } from "react";
import { useLocation, useNavigationType } from "react-router";
import { pageScrollLocked } from "../lib/scrollLock";

/** Scroll position per history entry (this tab only). */
const positions = new Map<string, number>();

/**
 * Back/forward returns to where you were on that screen; new screens start at
 * the top. Content can arrive a moment after navigation (data, images), so the
 * restore retries for a short while until the page is tall enough.
 */
export function useScrollMemory() {
  const location = useLocation();
  const type = useNavigationType();

  useEffect(() => {
    const key = location.key;
    let frame = 0;
    const save = () => {
      cancelAnimationFrame(frame);
      // While an overlay pins the page (src/lib/scrollLock.ts) window.scrollY reads 0; the
      // real position comes back on release, and that is what Back must return to.
      frame = requestAnimationFrame(() => !pageScrollLocked() && positions.set(key, window.scrollY));
    };
    window.addEventListener("scroll", save, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", save);
    };
  }, [location.key]);

  useLayoutEffect(() => {
    const target = type === "POP" ? positions.get(location.key) : undefined;
    if (!target) {
      window.scrollTo(0, 0);
      return;
    }
    let tries = 0;
    let frame = 0;
    const restore = () => {
      const room = document.documentElement.scrollHeight - window.innerHeight;
      if (room >= target || tries++ > 60) window.scrollTo(0, Math.min(target, room));
      else frame = requestAnimationFrame(restore);
    };
    restore();
    // Someone scrolling by hand wins over a pending restore.
    const stop = () => cancelAnimationFrame(frame);
    window.addEventListener("touchstart", stop, { once: true, passive: true });
    window.addEventListener("wheel", stop, { once: true, passive: true });
    return () => {
      stop();
      window.removeEventListener("touchstart", stop);
      window.removeEventListener("wheel", stop);
    };
  }, [location.key, type]);
}
