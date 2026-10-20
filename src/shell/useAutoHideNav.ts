import { useEffect, useState } from "react";

/** Always shown this close to the top of the page. */
const NEAR_TOP = 80;
/** Scrolling this far down in one go hides it; this far up shows it again. */
const HIDE_AFTER = 28;
const SHOW_AFTER = 14;
/** A jump bigger than this in one frame is the page moving by itself (scroll lock), not a scroll. */
const JUMP = 600;
/** Scrolling counts only this long after a touch, wheel or key (momentum included). */
const INPUT_MS = 1200;

/**
 * The phone tab bar on the Home feed: slides away while scrolling down through
 * posts and comes back on any deliberate scroll up, near the top, on leaving
 * or coming back to the feed, or when something in it gets keyboard focus.
 * Only scrolling the person does counts: the page moving by itself (the
 * position being restored on return, content loading above) never hides it.
 * Small movements and the page bouncing past its ends are ignored too.
 * Elsewhere it never hides.
 */
export function useAutoHideNav(enabled: boolean, visit: string) {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    setHidden(false);
    if (!enabled) return;
    let last = window.scrollY;
    let run = 0; // distance scrolled in the current direction
    let frame = 0;
    let input = -Infinity;
    const set = setHidden; // same value: React skips the render
    const check = () => {
      frame = 0;
      const y = window.scrollY;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const d = y - last;
      last = y;
      if (y <= NEAR_TOP) {
        run = 0;
        return set(false);
      }
      // Not the person scrolling, or a sheet / viewer has locked the page: leave the bar as it is.
      if (performance.now() - input > INPUT_MS || document.querySelector("dialog[open]")) return void (run = 0);
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
    const onInput = () => {
      input = performance.now();
    };
    const inputs = ["touchstart", "touchmove", "touchend", "wheel", "keydown"] as const;
    window.addEventListener("scroll", onScroll, { passive: true });
    for (const t of inputs) window.addEventListener(t, onInput, { passive: true, capture: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      for (const t of inputs) window.removeEventListener(t, onInput, { capture: true });
    };
  }, [enabled, visit]);

  return [hidden, () => setHidden(false)] as const;
}
