import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Download, X, ZoomIn, ZoomOut } from "lucide-react";
import { useToast } from "../../state/toast";
import { saveImage } from "./saveImage";
import type { MediaItem } from "../../data";
import "./MediaViewer.css";
import { MediaImg, mediaSrc } from "../../lib/mediaLinks";
import { capturePointer, swallowClicks } from "../../lib/visualViewport";

type Open = (items: MediaItem[], index?: number) => void;
const ViewerContext = createContext<Open>(() => {});

const MAX_ZOOM = 4;
const DOUBLE_TAP_ZOOM = 2.5;

/**
 * One full-screen media viewer for the whole app. Posts call
 * useMediaViewer()(post.media, index).
 *
 * - The page behind is locked in place (also on iPhone, where a modal dialog
 *   alone lets touch scrolling reach the page) and comes back exactly where it
 *   was; focus returns to the photo that was tapped.
 * - Pinch or double-tap to zoom, drag to pan when zoomed; at normal size swipe
 *   sideways for the next photo and down to close. Keyboard: ← / →, + / − / 0, Esc.
 * - The feed-sized copy shows at once (usually already downloaded); the full
 *   photo is fetched only here and fades in over it. The next one is preloaded.
 */
export function MediaViewerProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ items: MediaItem[]; index: number } | null>(null);
  const ref = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const open = useCallback<Open>((items, index = 0) => {
    if (!items.length) return;
    returnFocus.current = document.activeElement as HTMLElement | null;
    setState({ items, index: Math.min(Math.max(index, 0), items.length - 1) });
  }, []);
  const close = useCallback(() => setState(null), []);
  const go = useCallback((delta: number) => {
    setState((s) => (s ? { ...s, index: Math.min(Math.max(s.index + delta, 0), s.items.length - 1) } : s));
  }, []);

  const isOpen = !!state;
  useEffect(() => {
    const d = ref.current;
    if (!d || !isOpen) return;
    const unlock = lockPageScroll();
    if (!d.open) d.showModal();
    // iOS Safari: a pinch anywhere would zoom the whole page; the viewer zooms the photo instead.
    const stop = (e: Event) => e.preventDefault();
    d.addEventListener("gesturestart", stop);
    d.addEventListener("gesturechange", stop);
    return () => {
      d.removeEventListener("gesturestart", stop);
      d.removeEventListener("gesturechange", stop);
      // A swipe-down's or a tap's click may still be on its way: it mustn't land on the feed now underneath.
      swallowClicks();
      if (d.open) d.close();
      unlock();
      returnFocus.current?.focus?.({ preventScroll: true });
    };
  }, [isOpen]);

  // The next photo (full size) starts downloading while this one is viewed.
  useEffect(() => {
    const next = state?.items[state.index + 1];
    if (next?.type !== "image") return;
    const url = mediaSrc(next.url, "full");
    if (url) new Image().src = url;
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
      >
        {item && state && (
          <Stage
            key={`${state.index}:${item.url}`}
            item={item}
            onClose={close}
            onSwipe={(dir) => go(dir)}
            canPrev={state.index > 0}
            canNext={state.index < state.items.length - 1}
          />
        )}

        <button className="media-viewer__btn media-viewer__close" onClick={close} aria-label="Close" autoFocus>
          <X size={22} />
        </button>
        {item?.type === "image" && <DownloadButton key={item.url} url={item.url} />}

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

/** Save the photo being viewed (best authorised copy; share sheet on phones, download elsewhere). */
function DownloadButton({ url }: { url: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={`media-viewer__btn media-viewer__download${busy ? " is-busy" : ""}`}
      aria-label={busy ? "Preparing photo…" : "Save photo"}
      aria-busy={busy}
      disabled={busy}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={async (e) => {
        e.stopPropagation();
        setBusy(true);
        try {
          const r = await saveImage(url);
          if (r === "downloaded") toast("Download started");
        } catch {
          toast("Couldn't save the photo. Check your connection and try again.", "error");
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <span className="btn__spinner" aria-hidden="true" /> : <Download size={20} />}
    </button>
  );
}

/**
 * Keeps the page exactly where it is while the viewer is open. `overflow:
 * hidden` alone doesn't stop touch scrolling on iOS, so the body is pinned with
 * position: fixed at the current offset, and put back on close.
 */
function lockPageScroll(): () => void {
  const y = window.scrollY;
  const body = document.body;
  const prev = { position: body.style.position, top: body.style.top, left: body.style.left, right: body.style.right, width: body.style.width, overflow: body.style.overflow };
  Object.assign(body.style, { position: "fixed", top: `-${y}px`, left: "0", right: "0", width: "100%", overflow: "hidden" });
  document.documentElement.classList.add("media-open");
  return () => {
    Object.assign(body.style, prev);
    document.documentElement.classList.remove("media-open");
    window.scrollTo({ top: y, left: 0, behavior: "instant" as ScrollBehavior });
  };
}

type View = { scale: number; x: number; y: number };
const NORMAL: View = { scale: 1, x: 0, y: 0 };

/** One photo (or video) with its own zoom/pan/swipe handling. */
function Stage({
  item,
  onClose,
  onSwipe,
  canPrev,
  canNext,
}: {
  item: MediaItem;
  onClose: () => void;
  onSwipe: (dir: -1 | 1) => void;
  canPrev: boolean;
  canNext: boolean;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(NORMAL);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const [fullLoaded, setFullLoaded] = useState(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ startDist: number; startScale: number; startView: View; mid: { x: number; y: number } } | null>(null);
  const panStart = useRef<{ x: number; y: number; view: View; moved: boolean; mouse: boolean } | null>(null);
  /** This gesture used two fingers at some point: lifting them is never a tap or a swipe. */
  const multi = useRef(false);
  const lastTap = useRef(0);
  const tapTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(tapTimer.current), []);
  const zoomed = view.scale > 1.01;

  /** Keep the zoomed photo covering the screen (no panning it off into black). */
  const clamp = useCallback((v: View): View => {
    const el = stageRef.current;
    const scale = Math.min(MAX_ZOOM, Math.max(1, v.scale));
    if (!el || scale <= 1) return NORMAL;
    const maxX = ((scale - 1) * el.clientWidth) / 2;
    const maxY = ((scale - 1) * el.clientHeight) / 2;
    return { scale, x: Math.min(maxX, Math.max(-maxX, v.x)), y: Math.min(maxY, Math.max(-maxY, v.y)) };
  }, []);

  /** Zoom to `scale` keeping the point (cx, cy) — relative to the stage centre — under the finger. */
  const zoomAt = useCallback(
    (from: View, scale: number, cx: number, cy: number) => {
      const k = scale / from.scale;
      return clamp({ scale, x: cx - (cx - from.x) * k, y: cy - (cy - from.y) * k });
    },
    [clamp],
  );

  const center = (x: number, y: number) => {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: x - r.left - r.width / 2, y: y - r.top - r.height / 2 };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (item.type === "video") return;
    // The zoom buttons sit inside the stage: capturing their press would turn the tap into a tap on the stage.
    if ((e.target as HTMLElement).closest("button")) return;
    if (pointers.current.size === 0) multi.current = false;
    capturePointer(e.currentTarget as HTMLElement, e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      multi.current = true;
      const [a, b] = [...pointers.current.values()];
      gesture.current = { startDist: Math.hypot(a.x - b.x, a.y - b.y), startScale: view.scale, startView: view, mid: center((a.x + b.x) / 2, (a.y + b.y) / 2) };
      panStart.current = null;
      setDrag(null);
    } else if (pointers.current.size === 1) {
      panStart.current = { x: e.clientX, y: e.clientY, view, moved: false, mouse: e.pointerType === "mouse" };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (g && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const scale = Math.min(MAX_ZOOM, Math.max(1, (g.startScale * Math.hypot(a.x - b.x, a.y - b.y)) / g.startDist));
      setView(zoomAt(g.startView, scale, g.mid.x, g.mid.y));
      return;
    }
    const p = panStart.current;
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) p.moved = true;
    if (zoomed) setView(clamp({ ...p.view, x: p.view.x + dx, y: p.view.y + dy }));
    else setDrag({ dx, dy });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gesture.current = null;
    const p = panStart.current;
    if (pointers.current.size > 0) return;
    panStart.current = null;
    const d = drag;
    setDrag(null);
    if (!p || multi.current) return;
    if (!p.moved) {
      // Double tap: zoom in at the tap, or back out. A single tap outside the photo closes.
      const now = Date.now();
      clearTimeout(tapTimer.current);
      if (now - lastTap.current < 300) {
        const c = center(e.clientX, e.clientY);
        setView(zoomed ? NORMAL : zoomAt(view, DOUBLE_TAP_ZOOM, c.x, c.y));
        lastTap.current = 0;
      } else {
        lastTap.current = now;
        const { clientX: x, clientY: y } = e;
        // Only a mouse click beside the photo closes (as on desktop sites). On a phone the
        // space around a photo is easy to touch by accident: there, the close button or a
        // swipe down closes.
        if (p.mouse)
          tapTimer.current = setTimeout(() => {
            const img = stageRef.current?.querySelector(".media-viewer__img:last-child")?.getBoundingClientRect();
            const onPhoto = img && x >= img.left && x <= img.right && y >= img.top && y <= img.bottom;
            if (!onPhoto && !zoomed) onClose();
          }, 300);
      }
      return;
    }
    if (zoomed || !d) return;
    if (Math.abs(d.dx) > 60 && Math.abs(d.dx) > Math.abs(d.dy)) {
      if (d.dx < 0 && canNext) onSwipe(1);
      if (d.dx > 0 && canPrev) onSwipe(-1);
    } else if (d.dy > 90 && d.dy > Math.abs(d.dx)) onClose();
  };

  const zoomBy = (factor: number) => setView((v) => zoomAt(v, v.scale * factor, 0, 0));

  // Keyboard zoom, wherever focus is in the viewer.
  useEffect(() => {
    if (item.type === "video") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "+" || e.key === "=") setView((v) => zoomAt(v, v.scale * 1.5, 0, 0));
      else if (e.key === "-") setView((v) => zoomAt(v, v.scale / 1.5, 0, 0));
      else if (e.key === "0") setView(NORMAL);
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [item.type, zoomAt]);

  // Desktop: Ctrl/⌘ + wheel or a trackpad pinch zooms at the pointer.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || item.type === "video") return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const c = { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
      setView((v) => zoomAt(v, v.scale * Math.exp(-e.deltaY / 200), c.x, c.y));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [item.type, zoomAt]);

  const transform = drag
    ? `translate(${drag.dx}px, ${Math.max(0, drag.dy)}px)`
    : `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  const fade = drag && drag.dy > 0 ? Math.max(0.4, 1 - drag.dy / 400) : 1;

  return (
    <div
      ref={stageRef}
      className={`media-viewer__stage${zoomed ? " is-zoomed" : ""}${drag || gesture.current ? " is-dragging" : ""}`}
      style={{ opacity: fade }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      tabIndex={-1}
    >
      {item.type === "video" ? (
        <video src={item.url} poster={item.posterUrl} controls autoPlay playsInline />
      ) : (
        <div className="media-viewer__frame" style={{ transform }}>
          {/* The feed-sized copy first (usually already on the phone), the full photo over it once loaded. */}
          {!fullLoaded && <MediaImg className="media-viewer__img media-viewer__img--small" src={item.url} size="sm" alt="" aria-hidden="true" draggable={false} />}
          <MediaImg
            className={`media-viewer__img${fullLoaded ? " is-loaded" : ""}`}
            src={item.url}
            alt={item.alt ?? ""}
            draggable={false}
            onLoad={() => setFullLoaded(true)}
          />
        </div>
      )}
      {item.type !== "video" && (
        <div className="media-viewer__zoom">
          <button type="button" className="media-viewer__btn" onClick={() => zoomBy(1 / 1.5)} disabled={!zoomed} aria-label="Zoom out">
            <ZoomOut size={20} />
          </button>
          <button type="button" className="media-viewer__btn" onClick={() => zoomBy(1.5)} disabled={view.scale >= MAX_ZOOM} aria-label="Zoom in">
            <ZoomIn size={20} />
          </button>
        </div>
      )}
    </div>
  );
}
