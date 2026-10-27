import { limitText } from "../feed/errors";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowDown, ArrowUp, ImagePlus, Trash2, X } from "lucide-react";
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
import { capturePointer } from "../../lib/visualViewport";
import { useViewer } from "../../state/session";
import { useToast } from "../../state/toast";
import { Button, IconButton } from "../../ui/Button";
import { Sheet } from "../../ui/Sheet";
import { MomentVisual, type PhotoState } from "./MomentVisual";
import { DEFAULT_LAYOUT, initialLayout, TEXT_Y_MAX, TEXT_Y_MIN, withTextY } from "./framing";
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

/** Photos always show whole (framing.ts wholePhoto); the caption is what can be moved. */
type Gesture = { kind: "caption"; id: number; top: number; height: number } | null;

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
      setLayout((l) => ({ ...initialLayout(p.width), textY: l.textY === 0.5 ? 0.72 : l.textY }));
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

  function onFrameDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (!(e.target as HTMLElement).closest(".moment-visual__text")) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    capturePointer(e.currentTarget, e.pointerId);
    const f = frameSize();
    if (f && pointers.current.size === 1) gesture.current = { kind: "caption", id: e.pointerId, top: f.top, height: f.h };
  }
  function onFrameMove(e: ReactPointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (g && g.id === e.pointerId) setLayout((l) => withTextY(l, (e.clientY - g.top) / g.height));
  }
  function onFrameUp(e: ReactPointerEvent<HTMLDivElement>) {
    pointers.current.delete(e.pointerId);
    if (gesture.current?.id === e.pointerId) gesture.current = null;
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
          className="moment-composer__frame"
          aria-label="Preview"
          onPointerDown={onFrameDown}
          onPointerMove={onFrameMove}
          onPointerUp={onFrameUp}
          onPointerCancel={onFrameUp}
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
          {hint && image && trimmed && (
            <span className="moment-composer__hint" aria-hidden="true">
              Drag the caption to move it
            </span>
          )}
        </div>
      </div>

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
