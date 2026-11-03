import type { MomentLayout } from "../../data";

/**
 * How a Moment photo sits in its frame. Full size (viewer, composer) always
 * uses wholePhoto(); the small previews keep the saved framing:
 *
 *   fit "cover"    fills the frame (cropping the overflow)
 *   fit "contain"  the whole photo, over a blurred copy of itself
 *   zoom 1–4       on top of that
 *   x, y 0–1       the point of the photo kept at the centre of the frame,
 *                  as far as the photo's edges allow
 */
export const DEFAULT_LAYOUT: MomentLayout = { fit: "cover", zoom: 1, x: 0.5, y: 0.5, textY: 0.5 };
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
/** The caption keeps clear of the top bar and the reply box. */
export const TEXT_Y_MIN = 0.14;
export const TEXT_Y_MAX = 0.8;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A new photo Moment's framing: the whole photo, caption towards the bottom. */
export function initialLayout(width?: number): MomentLayout {
  return { ...DEFAULT_LAYOUT, fit: "contain", textY: width ? 0.72 : 0.5 };
}

/**
 * How a Moment shows full size, whatever framing it was saved with: the whole
 * photo at its own shape (never stretched or cropped), centred over a blurred
 * copy of itself; only the caption keeps its place. Earlier Moments saved
 * "cover" or a zoom, which cropped most of a tall photo on a phone screen.
 */
export const wholePhoto = (l: MomentLayout): MomentLayout => ({ ...l, fit: "contain", zoom: 1, x: 0.5, y: 0.5 });

export interface Placement {
  left: number;
  top: number;
  width: number;
  height: number;
  /** The photo leaves part of the frame uncovered (the blurred copy shows there). */
  gaps: boolean;
}

export function place(frameW: number, frameH: number, imgW: number, imgH: number, l: MomentLayout): Placement {
  const base = l.fit === "cover" ? Math.max(frameW / imgW, frameH / imgH) : Math.min(frameW / imgW, frameH / imgH);
  const s = base * clamp(l.zoom, MIN_ZOOM, MAX_ZOOM);
  const width = imgW * s;
  const height = imgH * s;
  const axis = (frame: number, size: number, focus: number) =>
    size >= frame ? clamp(frame / 2 - focus * size, frame - size, 0) : (frame - size) / 2;
  return {
    left: axis(frameW, width, l.x),
    top: axis(frameH, height, l.y),
    width,
    height,
    gaps: width < frameW - 0.5 || height < frameH - 0.5,
  };
}

/** Moves the focus point by a drag of (dx, dy) screen pixels, kept within what the photo's edges allow. */
export function pan(frameW: number, frameH: number, imgW: number, imgH: number, l: MomentLayout, dx: number, dy: number): MomentLayout {
  const p = place(frameW, frameH, imgW, imgH, l);
  const axis = (focus: number, d: number, size: number, frame: number) => {
    if (size <= frame) return 0.5;
    const half = frame / 2 / size;
    return clamp(focus - d / size, half, 1 - half);
  };
  // Start from where the photo actually is (the stored point may sit beyond an edge).
  const cx = (frameW / 2 - p.left) / p.width;
  const cy = (frameH / 2 - p.top) / p.height;
  return { ...l, x: axis(cx, dx, p.width, frameW), y: axis(cy, dy, p.height, frameH) };
}

export const withZoom = (l: MomentLayout, zoom: number): MomentLayout => ({ ...l, zoom: clamp(zoom, MIN_ZOOM, MAX_ZOOM) });
export const withTextY = (l: MomentLayout, y: number): MomentLayout => ({ ...l, textY: clamp(y, TEXT_Y_MIN, TEXT_Y_MAX) });
