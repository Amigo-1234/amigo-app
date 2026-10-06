import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ImagePlus, X } from "lucide-react";
import { dataSource } from "../../data";
import { prepareImage, type PreparedImage } from "../../lib/image";
import { useViewer } from "../../state/session";
import { useToast } from "../../state/toast";
import { Avatar } from "../../ui/Avatar";
import { Button, IconButton } from "../../ui/Button";
import "./Composer.css";

export const POST_MAX_LENGTH = 500;

function CharRing({ length }: { length: number }) {
  const remaining = POST_MAX_LENGTH - length;
  if (length === 0) return null;
  const r = 9;
  const c = 2 * Math.PI * r;
  const pct = Math.min(1, length / POST_MAX_LENGTH);
  const state = remaining < 0 ? "over" : remaining <= 40 ? "warn" : "ok";
  return (
    <span className={`char-ring char-ring--${state}`} aria-live="polite" aria-label={`${remaining} characters remaining`}>
      <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r={r} className="char-ring__track" />
        <circle cx="12" cy="12" r={r} className="char-ring__fill" strokeDasharray={c} strokeDashoffset={c * (1 - pct)} />
      </svg>
      {remaining <= 40 && <span className="char-ring__num">{remaining}</span>}
    </span>
  );
}

export function Composer({
  variant = "inline",
  autoFocus = false,
  onPosted,
  onCancel,
}: {
  variant?: "inline" | "sheet";
  autoFocus?: boolean;
  onPosted?: () => void;
  onCancel?: () => void;
}) {
  const viewer = useViewer();
  const toast = useToast();
  const inputId = useId();
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [text, setText] = useState("");
  const [image, setImage] = useState<PreparedImage | null>(null);
  const [processing, setProcessing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = text.trim();
  const canPost = (trimmed.length > 0 || image) && trimmed.length <= POST_MAX_LENGTH && !processing && !submitting;

  // Grow the textarea with its content.
  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  useEffect(() => {
    if (autoFocus) textRef.current?.focus();
  }, [autoFocus]);

  async function onPickFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    setProcessing(true);
    try {
      setImage(await prepareImage(file));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProcessing(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!canPost) return;
    setSubmitting(true);
    setError(null);
    try {
      await dataSource.createPost(viewer, { text: trimmed, image });
      setText("");
      setImage(null);
      toast("Posted");
      onPosted?.();
    } catch (err) {
      console.error(err);
      setError("Your post didn't go through. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className={`composer composer--${variant}`} onSubmit={submit} aria-label="Create a post">
      {variant === "sheet" && (
        <div className="composer__bar">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <span className="composer__bar-title">New post</span>
          <Button type="submit" size="sm" disabled={!canPost} loading={submitting}>
            Post
          </Button>
        </div>
      )}

      <div className="composer__main">
        <Avatar name={viewer.name} src={viewer.avatarUrl} seed={viewer.id} size="md" />
        <div className="composer__field">
          <label htmlFor={inputId} className="visually-hidden">
            Post text
          </label>
          <textarea
            id={inputId}
            ref={textRef}
            className="composer__input"
            placeholder="What's happening?"
            value={text}
            rows={variant === "sheet" ? 4 : 2}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
            }}
            disabled={submitting}
          />

          {(image || processing) && (
            <div className="composer__preview">
              {processing ? (
                <div className="composer__preview-loading" role="status">
                  Preparing image…
                </div>
              ) : (
                image && (
                  <>
                    <img src={image.dataUrl} alt="Attached image preview" style={{ aspectRatio: `${image.width} / ${image.height}` }} />
                    <button type="button" className="composer__remove" onClick={() => setImage(null)} aria-label="Remove image">
                      <X size={16} />
                    </button>
                  </>
                )
              )}
            </div>
          )}

          {error && (
            <p className="composer__error" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>

      <div className="composer__tools">
        <IconButton type="button" label="Add photo" onClick={() => fileRef.current?.click()} disabled={submitting || processing || !!image}>
          <ImagePlus size={20} />
        </IconButton>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => onPickFile(e.target.files?.[0])} />
        <div className="composer__spacer" />
        <CharRing length={trimmed.length} />
        {variant === "inline" && (
          <Button type="submit" size="sm" disabled={!canPost} loading={submitting}>
            Post
          </Button>
        )}
      </div>
    </form>
  );
}
