import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ImagePlus, Reply, SendHorizontal, X } from "lucide-react";
import { dataSource, MESSAGE_MAX_LENGTH, type MessageQuote, type NewMediaInput, type NewMessageInput } from "../../data";
import { ImageError, processImage } from "../../lib/image";
import { useViewer } from "../../state/session";
import { IconButton } from "../../ui/Button";

const TYPING_IDLE_MS = 3000;

/**
 * Text + one photo + optional reply. Enter sends on devices with a keyboard;
 * Shift+Enter adds a line. Typing state is sent while you type and cleared
 * after a pause or when you send.
 */
export function MessageComposer({
  conversationId,
  peerName,
  replyTo,
  onCancelReply,
  onSend,
}: {
  conversationId: string;
  peerName: string;
  replyTo: MessageQuote | null;
  onCancelReply: () => void;
  onSend: (input: NewMessageInput) => void;
}) {
  const viewer = useViewer();
  const api = dataSource.messages!;
  const [text, setText] = useState("");
  const [image, setImage] = useState<{ media: NewMediaInput; url: string } | null>(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const typingOn = useRef(false);

  const stopTyping = () => {
    clearTimeout(typingTimer.current);
    if (typingOn.current) api.setTyping(viewer.id, conversationId, false);
    typingOn.current = false;
  };
  // Stop showing "typing…" when leaving the conversation.
  useEffect(() => stopTyping, [conversationId]);

  useEffect(() => {
    if (replyTo) inputRef.current?.focus();
  }, [replyTo]);

  // Grow with the text, up to a few lines.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const trimmed = text.trim();
  const tooLong = text.length > MESSAGE_MAX_LENGTH;
  const canSend = (trimmed.length > 0 || !!image) && !tooLong && !processing;

  function change(value: string) {
    setText(value);
    setError(null);
    if (!value.trim()) return stopTyping();
    if (!typingOn.current) api.setTyping(viewer.id, conversationId, true);
    typingOn.current = true;
    clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(stopTyping, TYPING_IDLE_MS);
  }

  async function pick(file: File | undefined) {
    if (!file) return;
    setProcessing(true);
    setError(null);
    try {
      const p = await processImage(file);
      if (image) URL.revokeObjectURL(image.url);
      setImage({ media: { kind: "image", blob: p.blob, width: p.width, height: p.height }, url: URL.createObjectURL(p.blob) });
    } catch (e) {
      setError(e instanceof ImageError ? e.message : "We couldn't add that photo.");
    } finally {
      setProcessing(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function clearImage() {
    if (image) URL.revokeObjectURL(image.url);
    setImage(null);
  }

  function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!canSend) return;
    stopTyping();
    onSend({ text: trimmed, image: image?.media ?? null, replyToId: replyTo?.id ?? null });
    setText("");
    // The pending bubble keeps its own preview URL.
    setImage(null);
    onCancelReply();
    inputRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends where there's a real keyboard; on touch keyboards Enter is a new line.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && matchMedia("(hover: hover)").matches) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <form className="msg-composer" onSubmit={submit} aria-label="Write a message">
      {replyTo && (
        <div className="msg-composer__reply">
          <Reply size={16} aria-hidden="true" />
          <span className="msg-composer__reply-text">
            <strong>Replying to {replyTo.fromViewer ? "yourself" : peerName}</strong>
            <span>{replyTo.text || (replyTo.hasImage ? "Photo" : "Message")}</span>
          </span>
          <IconButton label="Cancel reply" size="sm" type="button" onClick={onCancelReply}>
            <X size={16} />
          </IconButton>
        </div>
      )}
      {image && (
        <div className="msg-composer__image">
          <img src={image.url} alt="Photo to send" />
          <IconButton label="Remove photo" size="sm" type="button" onClick={clearImage} className="msg-composer__image-remove">
            <X size={16} />
          </IconButton>
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="msg-composer__row">
        <IconButton label="Add a photo" type="button" onClick={() => fileRef.current?.click()} disabled={processing || !!image}>
          <ImagePlus size={22} />
        </IconButton>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => pick(e.target.files?.[0])} />
        <label className="visually-hidden" htmlFor="msg-input">
          Message {peerName}
        </label>
        <textarea
          id="msg-input"
          ref={inputRef}
          className="msg-composer__input"
          rows={1}
          value={text}
          placeholder="Message"
          onChange={(e) => change(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={stopTyping}
          aria-invalid={tooLong}
          aria-describedby={tooLong ? "msg-count" : undefined}
        />
        <IconButton label="Send" type="submit" disabled={!canSend} className="msg-composer__send">
          <SendHorizontal size={20} />
        </IconButton>
      </div>
      {text.length > MESSAGE_MAX_LENGTH - 200 && (
        <p id="msg-count" className={`msg-composer__count${tooLong ? " is-over" : ""}`} aria-live="polite">
          {text.length}/{MESSAGE_MAX_LENGTH}
        </p>
      )}
    </form>
  );
}
