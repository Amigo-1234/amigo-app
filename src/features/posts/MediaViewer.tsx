import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import type { MediaItem } from "../../data";
import "./MediaViewer.css";

type Open = (items: MediaItem[], index?: number) => void;
const ViewerContext = createContext<Open>(() => {});

/**
 * One full-screen media viewer for the whole app. Posts call
 * useMediaViewer()(post.media, index). Navigate with the arrow buttons, the
 * ← / → keys, or by swiping; Esc or the close button (or tapping the
 * backdrop) closes it and returns focus to where it was.
 */
export function MediaViewerProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ items: MediaItem[]; index: number } | null>(null);
  const ref = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const touchX = useRef<number | null>(null);

  const open = useCallback<Open>((items, index = 0) => {
    if (!items.length) return;
    returnFocus.current = document.activeElement as HTMLElement | null;
    setState({ items, index: Math.min(Math.max(index, 0), items.length - 1) });
  }, []);
  const close = useCallback(() => setState(null), []);
  const go = useCallback((delta: number) => {
    setState((s) => (s ? { ...s, index: Math.min(Math.max(s.index + delta, 0), s.items.length - 1) } : s));
  }, []);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (state && !d.open) d.showModal();
    if (!state && d.open) {
      d.close();
      returnFocus.current?.focus?.();
    }
  }, [state]);

  const item = state?.items[state.index];
  const many = (state?.items.length ?? 0) > 1;

  return (
    <ViewerContext.Provider value={open}>
      {children}
      <dialog
        ref={ref}
        className="media-viewer"
        aria-label="Media viewer"
        aria-roledescription="carousel"
        onCancel={(e) => {
          e.preventDefault();
          close();
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") go(1);
          if (e.key === "ArrowLeft") go(-1);
        }}
        onClick={(e) => e.target === e.currentTarget && close()}
        onTouchStart={(e) => (touchX.current = e.touches[0].clientX)}
        onTouchEnd={(e) => {
          if (touchX.current === null) return;
          const dx = e.changedTouches[0].clientX - touchX.current;
          if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
          touchX.current = null;
        }}
      >
        <button className="media-viewer__btn media-viewer__close" onClick={close} aria-label="Close" autoFocus>
          <X size={22} />
        </button>

        {item && (
          <figure className="media-viewer__stage" onClick={(e) => e.target === e.currentTarget && close()}>
            {item.type === "video" ? (
              <video key={item.url} src={item.url} poster={item.posterUrl} controls autoPlay playsInline />
            ) : (
              <img key={item.url} src={item.url} alt={item.alt ?? ""} />
            )}
          </figure>
        )}

        {many && state && (
          <>
            <button className="media-viewer__btn media-viewer__prev" onClick={() => go(-1)} disabled={state.index === 0} aria-label="Previous image">
              <ChevronLeft size={26} />
            </button>
            <button
              className="media-viewer__btn media-viewer__next"
              onClick={() => go(1)}
              disabled={state.index === state.items.length - 1}
              aria-label="Next image"
            >
              <ChevronRight size={26} />
            </button>
            <p className="media-viewer__count" aria-live="polite">
              {state.index + 1} / {state.items.length}
            </p>
          </>
        )}
      </dialog>
    </ViewerContext.Provider>
  );
}

export const useMediaViewer = () => useContext(ViewerContext);
