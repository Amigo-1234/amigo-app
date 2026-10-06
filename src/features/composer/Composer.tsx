import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useRef, useState, type DragEvent, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, ImagePlus, X } from "lucide-react";
import { dataSource, POST_MAX_LENGTH, type NewMediaInput } from "../../data";
import { processImage, ImageError } from "../../lib/image";
import { usePublishing } from "../../state/publishing";
import { useViewer } from "../../state/session";
import { Avatar } from "../../ui/Avatar";
import { Button, IconButton } from "../../ui/Button";
import { MediaLayout } from "../posts/PostMedia";
import { clearDraft, loadDraft, saveDraft, type Draft } from "./draft";
import "./Composer.css";

export { POST_MAX_LENGTH };

const ACCEPT = "image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif";

interface Item {
  id: string;
  name: string;
  status: "processing" | "ready";
  blob?: Blob;
  previewUrl?: string;
  width: number;
  height: number;
}

export interface ComposerHandle {
  /** Close if empty; otherwise ask whether to discard, keep as draft, or keep editing. */
  requestClose: () => void;
}

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

/**
 * The single composer used both inline on Home and in the global Create sheet.
 */
export const Composer = forwardRef<ComposerHandle, { variant?: "inline" | "sheet"; autoFocus?: boolean; onClose?: () => void }>(
  function Composer({ variant = "inline", autoFocus = false, onClose }, handle) {
    const viewer = useViewer();
    const { publish } = usePublishing();
    const inputId = useId();
    const textRef = useRef<HTMLTextAreaElement>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const formRef = useRef<HTMLFormElement>(null);
    const maxMedia = dataSource.maxMediaPerPost;

    const [text, setText] = useState("");
    const [items, setItems] = useState<Item[]>([]);
    const [errors, setErrors] = useState<string[]>([]);
    const [draft, setDraft] = useState<Draft | null>(() => loadDraft(viewer.id));
    const [confirming, setConfirming] = useState(false);
    const [announce, setAnnounce] = useState("");
    const [dragOver, setDragOver] = useState(false);
    const dragFrom = useRef<number | null>(null);
    const itemsRef = useRef(items);
    itemsRef.current = items;

    const trimmed = text.trim();
    const ready = items.filter((i) => i.status === "ready");
    const processing = items.some((i) => i.status === "processing");
    const tooLong = text.length > POST_MAX_LENGTH;
    const dirty = trimmed.length > 0 || items.length > 0;
    const canPost = (trimmed.length > 0 || ready.length > 0) && !tooLong && !processing;

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

    // Keep a local text draft while writing (not while a restore offer is pending).
    useEffect(() => {
      if (draft) return;
      const t = setTimeout(() => saveDraft(viewer.id, text, itemsRef.current.length), 500);
      return () => clearTimeout(t);
    }, [text, viewer.id, draft]);

    // Free preview memory for anything still held when the composer goes away.
    useEffect(() => () => itemsRef.current.forEach((i) => i.previewUrl && URL.revokeObjectURL(i.previewUrl)), []);

    const reset = useCallback(() => {
      setText("");
      setItems([]);
      setErrors([]);
      setConfirming(false);
    }, []);

    function discard() {
      items.forEach((i) => i.previewUrl && URL.revokeObjectURL(i.previewUrl));
      clearDraft(viewer.id);
      reset();
      onClose?.();
    }

    useImperativeHandle(handle, () => ({
      requestClose: () => {
        if (dirty) setConfirming(true);
        else onClose?.();
      },
    }));

    // ------------------------------------------------------------- media

    async function addFiles(fileList: FileList | File[]) {
      const files = Array.from(fileList);
      if (!files.length) return;
      const slots = maxMedia - itemsRef.current.length;
      const problems: string[] = [];
      if (files.length > slots) {
        problems.push(
          slots <= 0
            ? `You can add up to ${maxMedia} photo${maxMedia === 1 ? "" : "s"} per post.`
            : `You can add up to ${maxMedia} photos per post — ${files.length - slots} ${files.length - slots === 1 ? "wasn't" : "weren't"} added.`,
        );
      }
      const accepted = files.slice(0, Math.max(0, slots));
      const placeholders: Item[] = accepted.map((f) => ({ id: crypto.randomUUID(), name: f.name, status: "processing", width: 4, height: 3 }));
      setItems((list) => [...list, ...placeholders]);
      setErrors(problems);

      await Promise.all(
        accepted.map(async (file, i) => {
          const id = placeholders[i].id;
          try {
            const img = await processImage(file);
            const previewUrl = URL.createObjectURL(img.blob);
            setItems((list) => list.map((it) => (it.id === id ? { ...it, status: "ready", blob: img.blob, previewUrl, width: img.width, height: img.height } : it)));
          } catch (e) {
            setItems((list) => list.filter((it) => it.id !== id));
            setErrors((errs) => [...errs, e instanceof ImageError ? e.message : `${file.name || "That image"} couldn't be added.`]);
          }
        }),
      );
      setAnnounce(`${itemsRef.current.filter((x) => x.status === "ready").length} of ${maxMedia} photos added`);
    }

    function removeItem(index: number) {
      const it = items[index];
      if (it?.previewUrl) URL.revokeObjectURL(it.previewUrl);
      setItems((list) => list.filter((_, i) => i !== index));
      setAnnounce(`Photo ${index + 1} removed`);
      // Keep focus inside the composer.
      requestAnimationFrame(() => (formRef.current?.querySelector<HTMLElement>("[data-action=remove]") ?? textRef.current)?.focus());
    }

    function move(from: number, to: number, focusAction?: string) {
      if (to < 0 || to >= items.length || from === to) return;
      const moved = items[from];
      setItems((list) => {
        const next = [...list];
        const [m] = next.splice(from, 1);
        next.splice(to, 0, m);
        return next;
      });
      setAnnounce(`Photo moved to position ${to + 1} of ${items.length}`);
      if (focusAction) {
        requestAnimationFrame(() => {
          const btn =
            formRef.current?.querySelector<HTMLElement>(`[data-media-id="${moved.id}"] [data-action="${focusAction}"]:not(:disabled)`) ??
            formRef.current?.querySelector<HTMLElement>(`[data-media-id="${moved.id}"] [data-action]:not(:disabled)`);
          btn?.focus();
        });
      }
    }

    // ------------------------------------------------------------ submit

    function submit(e?: FormEvent) {
      e?.preventDefault();
      if (!canPost) return;
      const media: NewMediaInput[] = ready.map((i) => ({ kind: "image", blob: i.blob!, width: i.width, height: i.height }));
      // Hand the previews to the publishing queue (it frees them when done).
      publish({ text: trimmed, media }, ready.map((i) => i.previewUrl!));
      clearDraft(viewer.id);
      setDraft(null);
      setText("");
      setItems([]);
      setErrors([]);
      onClose?.();
    }

    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      setDragOver(false);
      void addFiles(e.dataTransfer.files);
    };

    const full = items.length >= maxMedia;

    return (
      <form
        ref={formRef}
        className={`composer composer--${variant}${dragOver ? " is-dragover" : ""}`}
        onSubmit={submit}
        aria-label="Create a post"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={(e) => e.currentTarget === e.target && setDragOver(false)}
        onDrop={onDrop}
      >
        {variant === "sheet" && (
          <div className="composer__bar">
            <Button type="button" variant="ghost" size="sm" onClick={() => (dirty ? setConfirming(true) : onClose?.())}>
              Cancel
            </Button>
            <span className="composer__bar-title">New post</span>
            <Button type="submit" size="sm" disabled={!canPost}>
              Post
            </Button>
          </div>
        )}

        {draft && !dirty && (
          <div className="composer__draft" role="status">
            <p>
              <strong>Unfinished post</strong> “{draft.text.length > 80 ? `${draft.text.slice(0, 80).trimEnd()}…` : draft.text}”
              {draft.mediaCount > 0 && <span className="composer__draft-note"> Photos aren't kept in drafts.</span>}
            </p>
            <div className="composer__draft-actions">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => {
                  setText(draft.text);
                  setDraft(null);
                  requestAnimationFrame(() => textRef.current?.focus());
                }}
              >
                Restore
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  clearDraft(viewer.id);
                  setDraft(null);
                }}
              >
                Discard
              </Button>
            </div>
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
              placeholder={items.length ? "Add a caption…" : "What's happening?"}
              value={text}
              rows={items.length ? 1 : variant === "sheet" ? 3 : 2}
              onChange={(e) => {
                setText(e.target.value);
                if (draft && e.target.value) setDraft(null); // typing fresh text dismisses the offer
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
              }}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
                if (files.length) {
                  e.preventDefault();
                  void addFiles(files);
                }
              }}
              aria-invalid={tooLong}
              aria-describedby={tooLong ? `${inputId}-long` : undefined}
            />
            {tooLong && (
              <p id={`${inputId}-long`} className="composer__error">
                Posts can be up to {POST_MAX_LENGTH} characters — {text.length - POST_MAX_LENGTH} over.
              </p>
            )}

            {items.length > 0 && (
              <div className="composer__media">
                <MediaLayout
                  items={items.map((i) => ({ type: "image", url: i.previewUrl ?? "", width: i.width, height: i.height }))}
                  maxHeight={variant === "sheet" ? 360 : 320}
                  renderExtras={(index) => {
                    const it = items[index];
                    return (
                      <div
                        className={`composer-tile${it.status === "processing" ? " is-processing" : ""}`}
                        data-media-id={it.id}
                        draggable={it.status === "ready" && items.length > 1}
                        onDragStart={(e) => {
                          dragFrom.current = index;
                          e.dataTransfer.effectAllowed = "move";
                        }}
                        onDragOver={(e) => dragFrom.current !== null && e.preventDefault()}
                        onDrop={(e) => {
                          if (dragFrom.current === null) return;
                          e.preventDefault();
                          e.stopPropagation();
                          move(dragFrom.current, index);
                          dragFrom.current = null;
                        }}
                      >
                        {it.status === "processing" && (
                          <span className="composer-tile__spinner" role="status" aria-label={`Preparing ${it.name || "photo"}`} />
                        )}
                        {items.length > 1 && <span className="composer-tile__badge" aria-hidden="true">{index + 1}</span>}
                        <button type="button" className="composer-tile__btn composer-tile__remove" data-action="remove" onClick={() => removeItem(index)} aria-label={`Remove photo ${index + 1}`}>
                          <X size={16} />
                        </button>
                        {items.length > 1 && (
                          <span className="composer-tile__order">
                            <button type="button" className="composer-tile__btn" data-action="earlier" disabled={index === 0} onClick={() => move(index, index - 1, "earlier")} aria-label={`Move photo ${index + 1} earlier`}>
                              <ArrowLeft size={16} />
                            </button>
                            <button type="button" className="composer-tile__btn" data-action="later" disabled={index === items.length - 1} onClick={() => move(index, index + 1, "later")} aria-label={`Move photo ${index + 1} later`}>
                              <ArrowRight size={16} />
                            </button>
                          </span>
                        )}
                      </div>
                    );
                  }}
                />
              </div>
            )}

            {errors.length > 0 && (
              <ul className="composer__errors" role="alert">
                {errors.map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="composer__tools">
          <IconButton type="button" label={full ? `Up to ${maxMedia} photos per post` : "Add photos"} onClick={() => fileRef.current?.click()} disabled={full}>
            <ImagePlus size={20} />
          </IconButton>
          <input ref={fileRef} type="file" accept={ACCEPT} multiple={maxMedia > 1} hidden onChange={(e) => { void addFiles(e.target.files ?? []); e.target.value = ""; }} />
          {items.length > 0 && <span className="composer__count">{items.length}/{maxMedia}</span>}
          <div className="composer__spacer" />
          <CharRing length={text.length} />
          {variant === "inline" && (
            <Button type="submit" size="sm" disabled={!canPost}>
              Post
            </Button>
          )}
        </div>

        <p className="visually-hidden" aria-live="polite">
          {announce}
        </p>

        {confirming && (
          <div className="composer__confirm" role="alertdialog" aria-modal="true" aria-labelledby={`${inputId}-confirm`}>
            <div className="composer__confirm-panel">
              <h2 id={`${inputId}-confirm`}>Discard this post?</h2>
              <p>{items.length ? "Your text and photos will be lost." : "Your text will be lost."}</p>
              <div className="composer__confirm-actions">
                <Button type="button" variant="danger" onClick={discard}>
                  Discard
                </Button>
                {trimmed && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      saveDraft(viewer.id, text, items.length);
                      items.forEach((i) => i.previewUrl && URL.revokeObjectURL(i.previewUrl));
                      reset();
                      setDraft(loadDraft(viewer.id));
                      onClose?.();
                    }}
                  >
                    Save draft
                  </Button>
                )}
                <Button type="button" onClick={() => setConfirming(false)} autoFocus>
                  Keep editing
                </Button>
              </div>
            </div>
          </div>
        )}
      </form>
    );
  },
);
