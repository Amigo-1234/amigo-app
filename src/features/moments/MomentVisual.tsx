import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import type { MediaItem, MomentBackground, MomentLayout } from "../../data";
import { MediaImg } from "../../lib/mediaLinks";
import { DEFAULT_LAYOUT, place } from "./framing";

export type MomentMedia = Pick<MediaItem, "url" | "alt" | "width" | "height" | "preview">;
export type PhotoState = "loading" | "ready" | "failed";

/** The size of an element, kept current as it resizes (rotation, keyboard, window). */
function useSize<T extends HTMLElement>(): [Ref<T>, { w: number; h: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

/**
 * What a Moment looks like: a photo framed as its author chose (fill, or the
 * whole photo over a blurred copy of itself), text on a background, or text
 * over a photo, with the caption where the author put it. Used by the viewer,
 * the composer's live preview and the small previews, so all three match.
 *
 * While the photo loads, its tiny blurred preview (or the background colour)
 * shows; onPhotoState reports loading / ready / failed (the viewer waits for
 * "ready" before its clock starts).
 */
export function MomentVisual({
  text,
  background,
  media,
  layout = DEFAULT_LAYOUT,
  size = "full",
  onPhotoState,
  captionRef,
  captionProps,
  children,
}: {
  text: string;
  background: MomentBackground;
  media: MomentMedia | null;
  layout?: MomentLayout;
  size?: "full" | "thumb";
  onPhotoState?: (state: PhotoState) => void;
  /** The composer drags the caption by these. */
  captionRef?: Ref<HTMLParagraphElement>;
  captionProps?: React.HTMLAttributes<HTMLParagraphElement>;
  children?: ReactNode;
}) {
  const [frameRef, frame] = useSize<HTMLDivElement>();
  const [state, setState] = useState<PhotoState>(media ? "loading" : "ready");
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const url = media?.url;
  useEffect(() => {
    setState(url ? "loading" : "ready");
    setNatural(null);
  }, [url]);
  useEffect(() => onPhotoState?.(state), [state, onPhotoState]);

  // Stored dimensions place the photo before it arrives (no jump); the decoded size wins if they differ.
  const iw = natural?.w ?? media?.width;
  const ih = natural?.h ?? media?.height;
  const placed = media && iw && ih && frame.w && frame.h ? place(frame.w, frame.h, iw, ih, layout) : null;
  // Without dimensions (very old Moments): fill, as before.
  const style: React.CSSProperties = placed
    ? { left: placed.left, top: placed.top, width: placed.width, height: placed.height }
    : { inset: 0, width: "100%", height: "100%", objectFit: "cover" };
  const showBackdrop = !!media && (placed?.gaps ?? false);
  const backdrop = media?.preview;

  return (
    <div
      ref={frameRef}
      className={`moment-visual moment-bg--${background} moment-visual--${size}${media ? " has-photo" : ""}${state === "ready" ? " is-ready" : ""}`}
    >
      {media && backdrop && (showBackdrop || state !== "ready") && (
        <span className="moment-visual__backdrop" style={{ backgroundImage: `url("${backdrop}")` }} aria-hidden="true" />
      )}
      {media && showBackdrop && !backdrop && state === "ready" && (
        <MediaImg className="moment-visual__backdrop moment-visual__backdrop--img" src={media.url} size="sm" alt="" aria-hidden="true" draggable={false} />
      )}
      {media && state !== "failed" && (
        <MediaImg
          key={media.url}
          className="moment-visual__photo"
          src={media.url}
          size={size === "thumb" ? "sm" : "full"}
          alt={media.alt ?? ""}
          draggable={false}
          decoding="async"
          style={style}
          onLoad={(e) => {
            const img = e.currentTarget;
            if (img.naturalWidth && (img.naturalWidth !== media.width || img.naturalHeight !== media.height)) {
              // A smaller copy has the same shape; only the shape matters for framing.
              const r = img.naturalWidth / img.naturalHeight;
              if (!media.width || !media.height || Math.abs(r - media.width / media.height) > 0.01) setNatural({ w: img.naturalWidth, h: img.naturalHeight });
            }
            setState("ready");
          }}
          onError={() => setState("failed")}
        />
      )}
      {text && (
        <p
          ref={captionRef}
          {...captionProps}
          className={`moment-visual__text${media ? " moment-visual__text--over" : ""}${captionProps?.className ? ` ${captionProps.className}` : ""}`}
          style={{ top: `${layout.textY * 100}%` }}
        >
          {text}
        </p>
      )}
      {children}
    </div>
  );
}
