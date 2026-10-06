import { useEffect, useRef, useState } from "react";
import { ImagePlus, Trash2, X } from "lucide-react";
import { dataSource, MOMENT_BACKGROUNDS, MOMENT_TEXT_MAX_LENGTH, type MomentAudience, type MomentBackground, type NewMediaInput } from "../../data";
import { ImageError, processImage } from "../../lib/image";
import { useViewer } from "../../state/session";
import { useToast } from "../../state/toast";
import { Button, IconButton } from "../../ui/Button";
import { Sheet } from "../../ui/Sheet";
import { MomentVisual } from "./MomentVisual";
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

function MomentComposer({ onClose }: { onClose: () => void }) {
  const viewer = useViewer();
  const toast = useToast();
  const [text, setText] = useState("");
  const [background, setBackground] = useState<MomentBackground>("coral");
  const [audience, setAudience] = useState<MomentAudience>("everyone");
  const [image, setImage] = useState<{ media: NewMediaInput; url: string } | null>(null);
  const [processing, setProcessing] = useState(false);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(
    () => () => {
      if (image) URL.revokeObjectURL(image.url);
    },
    [image],
  );

  async function pick(file: File | undefined) {
    if (!file) return;
    setProcessing(true);
    setError(null);
    try {
      const p = await processImage(file);
      setImage({ media: { kind: "image", blob: p.blob, width: p.width, height: p.height }, url: URL.createObjectURL(p.blob) });
    } catch (e) {
      setError(e instanceof ImageError ? e.message : "We couldn't add that photo.");
    } finally {
      setProcessing(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const trimmed = text.trim();
  const tooLong = text.length > MOMENT_TEXT_MAX_LENGTH;
  const canPost = (!!trimmed || !!image) && !tooLong && !processing;

  async function share() {
    if (!canPost) return;
    setPosting(true);
    try {
      await dataSource.moments!.create(viewer, { text: trimmed, background, image: image?.media ?? null, audience });
      toast("Moment shared — it disappears in 24 hours");
      onClose();
    } catch {
      setError("Couldn't share your Moment. Try again.");
      setPosting(false);
    }
  }

  return (
    <div className="moment-composer">
      <div className="moment-composer__head">
        <h2 className="sheet-form__title">New Moment</h2>
        <IconButton label="Close" onClick={onClose}>
          <X size={20} />
        </IconButton>
      </div>

      <div className="moment-composer__preview" aria-label="Preview">
        <MomentVisual text={trimmed || (image ? "" : "Say something…")} background={background} media={image ? { url: image.url } : null} />
      </div>

      <div className="moment-composer__row">
        {image ? (
          <Button variant="secondary" size="sm" icon={<Trash2 size={16} aria-hidden="true" />} onClick={() => setImage(null)}>
            Remove photo
          </Button>
        ) : (
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

      <label className="field">
        <span className="field__label">
          {image ? "Text over your photo (optional)" : "Text"}{" "}
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
          autoFocus
        />
      </label>

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
