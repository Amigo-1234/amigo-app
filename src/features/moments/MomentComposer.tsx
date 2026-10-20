import { limitText } from "../feed/errors";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowDown, ArrowUp, ImagePlus, Maximize2, Minimize2, RotateCcw, Trash2, X } from "lucide-react";
import {
  dataSource,
  MOMENT_BACKGROUNDS,
  MOMENT_TEXT_MAX_LENGTH,
  type MomentAudience,
  type MomentBackground,
  type MomentLayout,
  type NewMediaInput,
} from "../../data";
import { ImageError, processImage } from "../../lib/image";
import { useViewer } from "../../state/session";
import { useToast } from "../../state/toast";
import { Button, IconButton } from "../../ui/Button";
import { Sheet } from "../../ui/Sheet";
import { MomentVisual, type PhotoState } from "./MomentVisual";
import { DEFAULT_LAYOUT, initialLayout, MAX_ZOOM, MIN_ZOOM, pan, TEXT_Y_MAX, TEXT_Y_MIN, withTextY, withZoom } from "./framing";
import "./Moments.css";

const BG_LABEL: Record<MomentBackground, string> = {
  coral: "Coral",
  sunset: "Sunset",
  ocean: "Ocean",
  forest: "Forest",
  night: "Night",
  plain: "Plain",
};

/** New Moment: a photo, text on a background, or text over a photo. Disappears after 24 hours. */
export function MomentComposerSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} label="New Moment" fullscreenOnMobile>
      {open && <MomentComposer onClose={onClose} />}
    </Sheet>
  );
}

type Gesture =
  | { kind: "pan"; id: number; x: number; y: number }
  | { kind: "pinch"; dist: number; zoom: number; mid: { x: number; y: number } }
  | { kind: "caption"; id: number; top: number; height: number }
  | null;

function MomentComposer({ onClose }: { onClose: () => void }) {
  const viewer = useViewer();
  const toast = useToast();
  const [text, setText] = useState("");
  const [background, setBackground] = useState<MomentBackground>("coral");
  const [audience, setAudience] = useState<MomentAudience>("everyone");
  const [image, setImage] = useState<{ media: NewMediaInput; url: string } | null>(null);
  const [layout, setLayout] = useState<MomentLayout>(DEFAULT_LAYOUT);
  const [processing, setProcessing] = useState(false);
  /** Whether the chosen photo's preview actually displays: nothing is shared until it does. */
  const [photoState, setPhotoState] = useState<PhotoState>("ready");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture>(null);
  const lastTap = useRef(0);

  useEffect(
    () => () => {
      if (image) URL.revokeObjectURL(image.url);
    },
    [image],
  );
  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => setHint(false), 2600);
    return () => clearTimeout(t);
  }, [hint]);

  async function pick(file: File | undefined) {
    if (!file) return;
    setProcessing(true);
    setError(null);
    try {
      const p = await processImage(file);
      setPhotoState("loading");
      setImage({ media: { kind: "image", blob: p.blob, width: p.width, height: p.height }, url: URL.createObjectURL(p.blob) });
      setLayout((l) => ({ ...initialLayout(p.width, p.height), textY: l.textY === 0.5 ? 0.72 : l.textY }));
      setHint(true);
    } catch (e) {
      setError(e instanceof ImageError ? e.message : "We couldn't add that photo.");
    } finally {
      setProcessing(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function removePhoto() {
    setImage(null);
    setPhotoState("ready");
    setLayout((l) => ({ ...DEFAULT_LAYOUT, textY: l.textY }));
  }

  const trimmed = text.trim();
  const tooLong = text.length > MOMENT_TEXT_MAX_LENGTH;
  const canPost = (!!trimmed || !!image) && !tooLong && !processing && (!image || photoState === "ready");

  async function share() {
    if (!canPost) return;
    setPosting(true);
    try {
      await dataSource.moments!.create(viewer, { text: trimmed, background, image: image?.media ?? null, audience, layout });
      toast("Moment shared — it disappears in 24 hours");
      onClose();
    } catch (e) {
      setError(limitText(e) ?? "Couldn't share your Moment. Try again.");
      setPosting(false);
    }
  }

  // ------------------------------------------------------------- gestures

  const frameSize = () => {
    const r = frameRef.current?.getBoundingClientRect();
    return r ? { w: r.width, h: r.height, top: r.top } : null;
  };
  const panBy = (dx: number, dy: number) => {
    const f = frameSize();
    const m = image?.media;
    if (!f || !m?.width || !m.height) return;
    setLayout((l) => pan(f.w, f.h, m.width!, m.height!, l, dx, dy));
  };
  const toggleFit = () => setLayout((l) => ({ ...l, fit: l.fit === "cover" ? "contain" : "cover", zoom: 1 }));

  function onFrameDown(e: ReactPointerEvent<HTMLDivElement>) {
    const onCaption = (e.target as HTMLElement).closest(".moment-visual__text");
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.currentTarget.setPointerCapture?.(e.pointerId);
    if (onCaption && pointers.current.size === 1) {
      const f = frameSize();
      if (f) gesture.current = { kind: "caption", id: e.pointerId, top: f.top, height: f.h };
      return;
    }
    if (!image) return;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { kind: "pinch", dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: layout.zoom, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    } else {
      gesture.current = { kind: "pan", id: e.pointerId, x: e.clientX, y: e.clientY };
      // Double tap: fill the screen ↔ show the whole photo.
      if (performance.now() - lastTap.current < 300) toggleFit();
      lastTap.current = performance.now();
    }
  }
  function onFrameMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "caption" && g.id === e.pointerId) {
      setLayout((l) => withTextY(l, (e.clientY - g.top) / g.height));
    } else if (g.kind === "pan" && g.id === e.pointerId) {
      panBy(e.clientX - g.x, e.clientY - g.y);
      gesture.current = { ...g, x: e.clientX, y: e.clientY };
    } else if (g.kind === "pinch" && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      setLayout((l) => withZoom(l, g.zoom * (dist / g.dist)));
      panBy(mid.x - g.mid.x, mid.y - g.mid.y);
      gesture.current = { ...g, mid };
    }
  }
  function onFrameUp(e: ReactPointerEvent<HTMLDivElement>) {
    pointers.current.delete(e.pointerId);
    const left = [...pointers.current.entries()][0];
    // Lifting one finger of a pinch carries on as a pan with the other.
    gesture.current = left && image ? { kind: "pan", id: left[0], x: left[1].x, y: left[1].y } : null;
  }

  const moveCaption = (d: number) => setLayout((l) => withTextY(l, l.textY + d));

  return (
    <div className="moment-composer">
      <div className="moment-composer__head">
        <IconButton label="Close" onClick={onClose}>
          <X size={20} />
        </IconButton>
        <h2 className="sheet-form__title">New Moment</h2>
        <Button size="sm" loading={posting} disabled={!canPost} onClick={share}>
          Share
        </Button>
      </div>

      <div className="moment-composer__stage">
        <div
          ref={frameRef}
          className={`moment-composer__frame${image ? " is-editable" : ""}`}
          role={image ? "application" : undefined}
          aria-label={image ? "Photo framing. Drag to move, pinch or use the zoom slider to zoom, arrow keys move the photo." : "Preview"}
          tabIndex={image ? 0 : undefined}
          onPointerDown={onFrameDown}
          onPointerMove={onFrameMove}
          onPointerUp={onFrameUp}
          onPointerCancel={onFrameUp}
          onWheel={(e) => image && setLayout((l) => withZoom(l, l.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08)))}
          onKeyDown={(e) => {
            if (!image) return;
            const step = 24;
            const moves: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
            if (moves[e.key]) {
              e.preventDefault();
              panBy(...moves[e.key]);
            }
          }}
        >
          <MomentVisual
            text={trimmed || (image ? "" : "Say something…")}
            background={background}
            media={image ? { url: image.url, width: image.media.width, height: image.media.height } : null}
            layout={layout}
            onPhotoState={setPhotoState}
            captionProps={{ className: "is-draggable", title: "Drag to move the caption" }}
          />
          {(processing || (image && photoState === "loading")) && (
            <span className="moment-composer__status" role="status">
              <span className="moment-composer__spinner" aria-hidden="true" />
              Preparing your photo…
            </span>
          )}
          {image && photoState === "failed" && (
            <span className="moment-composer__status moment-composer__status--error" role="alert">
              This photo couldn't be shown on this device. Remove it and try another one.
            </span>
          )}
          {hint && image && (
            <span className="moment-composer__hint" aria-hidden="true">
              Drag to move · Pinch to zoom · Drag the caption
            </span>
          )}
        </div>
      </div>

      {image && (
        <div className="moment-composer__tools" role="group" aria-label="Photo framing">
          <IconButton label={layout.fit === "cover" ? "Show the whole photo" : "Fill the screen"} onClick={toggleFit}>
            {layout.fit === "cover" ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
          </IconButton>
          <label className="moment-composer__zoom">
            <span className="visually-hidden">Zoom</span>
            <input
              type="range"
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              step={0.01}
              value={layout.zoom}
              onChange={(e) => setLayout((l) => withZoom(l, Number(e.target.value)))}
              aria-valuetext={`${Math.round(layout.zoom * 100)}%`}
            />
          </label>
          <IconButton label="Reset framing" onClick={() => setLayout((l) => ({ ...initialLayout(image.media.width, image.media.height), textY: l.textY }))}>
            <RotateCcw size={18} />
          </IconButton>
        </div>
      )}

      {trimmed && (
        <div className="moment-composer__tools" role="group" aria-label="Caption position">
          <span className="moment-composer__tools-label">Caption</span>
          <IconButton label="Move caption up" onClick={() => moveCaption(-0.06)} disabled={layout.textY <= TEXT_Y_MIN + 0.001}>
            <ArrowUp size={18} />
          </IconButton>
          <IconButton label="Move caption down" onClick={() => moveCaption(0.06)} disabled={layout.textY >= TEXT_Y_MAX - 0.001}>
            <ArrowDown size={18} />
          </IconButton>
        </div>
      )}

      <label className="field">
        <span className="field__label">
          {image ? "Caption (optional)" : "Text"}{" "}
          <span className="field__count">
            {text.length}/{MOMENT_TEXT_MAX_LENGTH}
          </span>
        </span>
        <textarea
          className="field__input"
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Say something…"
          aria-invalid={tooLong}
        />
      </label>

      <div className="moment-composer__row">
        {image ? (
          <Button variant="secondary" size="sm" icon={<Trash2 size={16} aria-hidden="true" />} onClick={removePhoto}>
            Remove photo
          </Button>
        ) : dataSource.moments?.photos === false ? null : (
          <Button variant="secondary" size="sm" loading={processing} icon={<ImagePlus size={16} aria-hidden="true" />} onClick={() => fileRef.current?.click()}>
            Add a photo
          </Button>
        )}
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => pick(e.target.files?.[0])} />
        <div className="segmented" role="radiogroup" aria-label="Who can see it">
          {(["everyone", "followers"] as const).map((a) => (
            <button key={a} type="button" role="radio" aria-checked={audience === a} className="segmented__opt" onClick={() => setAudience(a)}>
              {a === "everyone" ? "Everyone" : "Followers"}
            </button>
          ))}
        </div>
      </div>

      {!image && (
        <fieldset className="moment-composer__bgs">
          <legend className="field__label">Background</legend>
          {MOMENT_BACKGROUNDS.map((b) => (
            <label key={b} className={`moment-swatch moment-bg--${b}`} title={BG_LABEL[b]}>
              <input type="radio" name="moment-bg" value={b} checked={background === b} onChange={() => setBackground(b)} aria-label={BG_LABEL[b]} />
            </label>
          ))}
        </fieldset>
      )}

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <Button block loading={posting} disabled={!canPost} onClick={share}>
        Share Moment
      </Button>
      <p className="moment-composer__note">
        {audience === "followers" ? "Only people who follow you can see it." : "Anyone on Amigo can see it."} It disappears after 24 hours.
      </p>
    </div>
  );
}
