import { useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Copy, Flag, Pencil, Reply, Search, Trash2 } from "lucide-react";
import { MESSAGE_EDIT_WINDOW_MS, MESSAGE_MAX_LENGTH, type DirectMessage, type MessageReaction } from "../../data";
import { Button } from "../../ui/Button";
import { clockTime, dayLabel } from "./format";

export const QUICK_REACTIONS = ["❤️", "😂", "😮", "😢", "👍", "🔥"];

/** A small built-in set (no third-party picker, nothing fetched). */
const EMOJI = [
  "😀", "😃", "😄", "😁", "😆", "🥹", "😅", "🤣", "😊", "🙂", "😉", "😍", "🥰", "😘", "😋", "😜",
  "🤪", "🤔", "🤨", "😐", "🙄", "😏", "😬", "😌", "😴", "🤤", "😷", "🥳", "😎", "🤓", "😕", "😟",
  "😮", "😲", "😳", "🥺", "😢", "😭", "😱", "😤", "😡", "🤯", "🫡", "🤗", "🫶", "👏", "🙌", "👍",
  "👎", "👊", "✌️", "🤞", "🤝", "🙏", "💪", "👀", "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "💔",
  "💯", "✨", "🔥", "⭐", "🎉", "🎂", "🎁", "☕", "🍕", "⚽", "🎶", "📸", "✅", "❌", "‼️", "❓",
];

export const canEdit = (m: DirectMessage) =>
  m.fromViewer && !m.undecryptable && !!m.text && m.media.length === 0 && Date.now() - m.createdAt.getTime() < MESSAGE_EDIT_WINDOW_MS;

/**
 * Whether reactions can be added or changed. The server can't tell a reaction from an
 * edit, so it refuses any change to your own message after the edit window.
 */
export const canAnnotate = (m: DirectMessage) => !m.fromViewer || Date.now() - m.createdAt.getTime() < MESSAGE_EDIT_WINDOW_MS;

export function EmojiGrid({ onPick, label = "Emoji" }: { onPick: (emoji: string) => void; label?: string }) {
  return (
    <div className="emoji-grid" role="group" aria-label={label}>
      {EMOJI.map((e) => (
        <button key={e} type="button" className="emoji-grid__item" onClick={() => onPick(e)} aria-label={e}>
          {e}
        </button>
      ))}
    </div>
  );
}

/** Long-press / right-click menu for one message. */
export function MessageActionSheet({
  m,
  canReact,
  onReact,
  onReply,
  onEdit,
  onUnsend,
  onReport,
  onCopy,
}: {
  m: DirectMessage;
  canReact: boolean;
  onReact: (emoji: string | null) => void;
  onReply: () => void;
  onEdit?: () => void;
  onUnsend?: () => void;
  onReport?: () => void;
  onCopy?: () => void;
}) {
  const [more, setMore] = useState(false);
  const mine = m.reactions?.find((r) => r.mine)?.emoji ?? null;
  return (
    <div className="sheet-menu msg-actions">
      {canReact && (
        <>
          <div className="msg-actions__quick" role="group" aria-label="React">
            {QUICK_REACTIONS.map((e) => (
              <button
                key={e}
                type="button"
                className={`msg-actions__emoji${mine === e ? " is-mine" : ""}`}
                aria-pressed={mine === e}
                aria-label={mine === e ? `Remove ${e}` : `React ${e}`}
                onClick={() => onReact(mine === e ? null : e)}
              >
                {e}
              </button>
            ))}
            <button type="button" className="msg-actions__emoji msg-actions__more" aria-expanded={more} aria-label="More emoji" onClick={() => setMore((v) => !v)}>
              +
            </button>
          </div>
          {more && <EmojiGrid onPick={(e) => onReact(e === mine ? null : e)} label="React with" />}
        </>
      )}
      <button className="sheet-menu__item" onClick={onReply}>
        <Reply size={20} aria-hidden="true" /> Reply
      </button>
      {onCopy && (
        <button className="sheet-menu__item" onClick={onCopy}>
          <Copy size={20} aria-hidden="true" /> Copy text
        </button>
      )}
      {onEdit && (
        <button className="sheet-menu__item" onClick={onEdit}>
          <Pencil size={20} aria-hidden="true" /> Edit
        </button>
      )}
      {onUnsend && (
        <button className="sheet-menu__item sheet-menu__item--danger" onClick={onUnsend}>
          <Trash2 size={20} aria-hidden="true" /> Unsend
        </button>
      )}
      {onReport && (
        <button className="sheet-menu__item sheet-menu__item--danger" onClick={onReport}>
          <Flag size={20} aria-hidden="true" /> Report
        </button>
      )}
    </div>
  );
}

export function EditSheet({ m, onSave, onCancel }: { m: DirectMessage; onSave: (text: string) => Promise<void>; onCancel: () => void }) {
  const [text, setText] = useState(m.text);
  const [busy, setBusy] = useState(false);
  const trimmed = text.trim();
  return (
    <form
      className="sheet-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await onSave(trimmed);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2 className="sheet-form__title">Edit message</h2>
      <label className="field">
        <span className="field__label visually-hidden">Message</span>
        <textarea className="field__input" rows={3} maxLength={MESSAGE_MAX_LENGTH} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
      </label>
      <p className="sheet-form__body">{"They'll see that it was edited. Edits are end-to-end encrypted too."}</p>
      <div className="sheet-form__actions">
        <Button variant="ghost" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={busy} disabled={!trimmed || trimmed === m.text}>
          Save
        </Button>
      </div>
    </form>
  );
}

export function UnsendSheet({ onConfirm, onCancel }: { onConfirm: () => Promise<void>; onCancel: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="sheet-form">
      <h2 className="sheet-form__title">Unsend message?</h2>
      <p className="sheet-form__body">
        {"It's removed for everyone, along with its reactions, and deleted from Amigo's servers. They may already have seen it."}
      </p>
      <div className="sheet-form__actions">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="danger"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
            } finally {
              setBusy(false);
            }
          }}
        >
          Unsend
        </Button>
      </div>
    </div>
  );
}

export function ReactionChips({ reactions, fromViewer, onToggle }: { reactions: MessageReaction[]; fromViewer: boolean; onToggle?: (r: MessageReaction) => void }) {
  if (!reactions.length) return null;
  return (
    <div className={`msg__reactions${fromViewer ? " msg__reactions--mine" : ""}`}>
      {reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          className={`msg__reaction${r.mine ? " is-mine" : ""}`}
          disabled={!onToggle}
          aria-pressed={r.mine}
          aria-label={`${r.emoji} ${r.count}${r.mine ? ", including you. Tap to remove" : ""}`}
          onClick={() => onToggle?.(r)}
        >
          <span aria-hidden="true">{r.emoji}</span>
          {r.count > 1 && <span className="msg__reaction-count">{r.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Search the messages this device has decrypted (nothing is sent anywhere). */
export function SearchSheet({ messages, peerName, onPick }: { messages: DirectMessage[]; peerName: string; onPick: (id: string) => void }) {
  const [q, setQ] = useState("");
  const hits = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (needle.length < 2) return [];
    return messages.filter((m) => !m.undecryptable && m.text.toLowerCase().includes(needle)).reverse().slice(0, 50);
  }, [q, messages]);
  return (
    <div className="sheet-form msg-search">
      <h2 className="sheet-form__title">Search conversation</h2>
      <label className="field msg-search__field">
        <Search size={16} aria-hidden="true" />
        <span className="visually-hidden">Search</span>
        <input className="field__input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search messages" autoFocus />
      </label>
      <p className="sheet-form__body">Searches the messages loaded on this device. Encrypted messages are never searched on the server.</p>
      <ul className="msg-search__results">
        {hits.map((m) => (
          <li key={m.id}>
            <button type="button" className="msg-search__hit" onClick={() => onPick(m.id)}>
              <span className="msg-search__who">
                {m.fromViewer ? "You" : peerName} · {dayLabel(m.createdAt)} {clockTime(m.createdAt)}
              </span>
              <span className="msg-search__text">{m.text}</span>
            </button>
          </li>
        ))}
        {q.trim().length >= 2 && !hits.length && <li className="msg-search__empty">No matches in loaded messages.</li>}
      </ul>
    </div>
  );
}

const LONG_PRESS_MS = 450;
const SWIPE_REPLY_PX = 56;

/**
 * Long-press (touch), right-click and swipe-right-to-reply on a message bubble.
 * Returns the handlers and the current swipe offset for the bubble's transform.
 */
export function useBubbleGestures({ onMenu, onReply, onDoubleTap }: { onMenu: () => void; onReply: () => void; onDoubleTap?: () => void }) {
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const swiping = useRef(false);
  const lastTap = useRef(0);

  const clear = () => {
    clearTimeout(timer.current);
    start.current = null;
    swiping.current = false;
    setDx(0);
  };

  return {
    dx,
    handlers: {
      onPointerDown(e: ReactPointerEvent) {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
        clearTimeout(timer.current);
        if (e.pointerType !== "mouse") {
          timer.current = setTimeout(() => {
            start.current = null;
            setDx(0);
            navigator.vibrate?.(10);
            // Lifting the finger can produce a click on whatever is now under it
            // (the sheet's backdrop) — swallow that one click so the menu stays open.
            const swallow = (ev: Event) => {
              ev.preventDefault();
              ev.stopPropagation();
            };
            window.addEventListener("click", swallow, { capture: true, once: true });
            setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 800);
            onMenu();
          }, LONG_PRESS_MS);
        }
      },
      onPointerMove(e: ReactPointerEvent) {
        const s = start.current;
        if (!s || s.id !== e.pointerId) return;
        const mx = e.clientX - s.x;
        const my = e.clientY - s.y;
        if (Math.abs(mx) > 8 || Math.abs(my) > 8) clearTimeout(timer.current);
        if (!swiping.current && mx > 12 && Math.abs(mx) > Math.abs(my) * 1.5) swiping.current = true;
        if (swiping.current) setDx(Math.max(0, Math.min(mx, SWIPE_REPLY_PX + 24)));
      },
      onPointerUp() {
        const replied = swiping.current && dx >= SWIPE_REPLY_PX;
        const wasTap = start.current && !swiping.current;
        clear();
        if (replied) onReply();
        else if (wasTap && onDoubleTap) {
          const now = Date.now();
          if (now - lastTap.current < 300) {
            lastTap.current = 0;
            onDoubleTap();
          } else lastTap.current = now;
        }
      },
      onPointerCancel: clear,
      onPointerLeave: () => {
        if (!swiping.current) clear();
      },
      onContextMenu(e: ReactMouseEvent) {
        e.preventDefault();
        clear();
        onMenu();
      },
    },
  };
}
