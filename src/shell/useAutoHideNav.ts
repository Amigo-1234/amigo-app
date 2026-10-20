import { useEffect, useState } from "react";

/** Always shown this close to the top of the page. */
const NEAR_TOP = 80;
/** Scrolling this far down in one go hides it; this far up shows it again. */
const HIDE_AFTER = 28;
const SHOW_AFTER = 14;
/** A jump bigger than this in one frame is the page moving by itself (restore, scroll lock), not a scroll. */
const JUMP = 600;
/** After arriving on the feed, the page may still be put back where you were (useScrollMemory): not a scroll. */
const SETTLE_MS = 1200;

/**
 * The phone tab bar on the Home feed: slides away while scrolling down through
 * posts and comes back on any deliberate scroll up, near the top, on leaving
 * or coming back to the feed (where the page being put back to where you were
 * isn't a scroll), or when something in it gets keyboard focus. Small movements and
 * the page bouncing past its ends are ignored. Elsewhere it never hides.
 */
export function useAutoHideNav(enabled: boolean, visit: string) {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    setHidden(false);
    if (!enabled) return;
    let last = window.scrollY;
    let run = 0; // distance scrolled in the current direction
    let frame = 0;
    const settleUntil = performance.now() + SETTLE_MS;
    const set = setHidden; // same value: React skips the render
    const check = () => {
      frame = 0;
      const y = window.scrollY;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const d = y - last;
      last = y;
      if (performance.now() < settleUntil) return void (run = 0);
      // A sheet or viewer locks the page (and may move it): leave the bar as it is until it closes.
      if (document.querySelector("dialog[open]")) return void (run = 0);
      if (y <= NEAR_TOP) {
        run = 0;
        return set(false);
      }
      // Rubber-banding past the bottom, or a jump the page made by itself.
      if (y > max || Math.abs(d) > JUMP) return void (run = 0);
      if (!d) return;
      run = Math.sign(d) === Math.sign(run) ? run + d : d;
      if (run > HIDE_AFTER) set(true);
      else if (run < -SHOW_AFTER) set(false);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
    };
  }, [enabled, visit]);

  return [hidden, () => setHidden(false)] as const;
}
