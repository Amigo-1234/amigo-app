import { useEffect, useRef } from "react";

/**
 * Keeps a full-screen view (an open chat on a phone) exactly the size and
 * position of the visible area, which is what sits above the on-screen keyboard.
 *
 * `100dvh` doesn't shrink for the keyboard on iPhone: Safari instead scrolls the
 * page to reveal the focused field, so a bottom-anchored composer jumps, the
 * header slides away and the home-indicator padding leaves a gap above the
 * keyboard. The visual viewport is the area actually on screen, so this sets
 * on <html>:
 *   --vvh / --vvt   its height and offset (for `position: fixed` sizing),
 *   .vv-fit         while active,
 *   .vv-lock        also, with `lock` (the view fills the screen, so the page mustn't scroll),
 *   .kb-open        while an on-screen keyboard covers part of the screen.
 * `onChange` runs after each change (e.g. to stay pinned to the newest message).
 */
export function useVisualViewportFit(active: boolean, onChange?: () => void, { lock = false }: { lock?: boolean } = {}) {
  const changed = useRef(onChange);
  changed.current = onChange;

  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!active || !vv) return;
    const root = document.documentElement;
    let frame = 0;
    const apply = () => {
      frame = 0;
      root.style.setProperty("--vvh", `${Math.round(vv.height)}px`);
      root.style.setProperty("--vvt", `${Math.round(vv.offsetTop)}px`);
      // A keyboard (not pinch-zoom) is covering the bottom of the screen.
      root.classList.toggle("kb-open", vv.scale < 1.05 && window.innerHeight - vv.height > 150);
      changed.current?.();
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(apply);
    };
    root.classList.add("vv-fit");
    if (lock) root.classList.add("vv-lock");
    apply();
    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
    return () => {
      cancelAnimationFrame(frame);
      vv.removeEventListener("resize", schedule);
      vv.removeEventListener("scroll", schedule);
      root.classList.remove("vv-fit", "vv-lock", "kb-open");
      root.style.removeProperty("--vvh");
      root.style.removeProperty("--vvt");
    };
  }, [active, lock]);
}
