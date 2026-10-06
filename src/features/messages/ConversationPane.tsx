import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowLeft, Ban, CircleAlert, Flag, Info, Lock, MoreHorizontal, Reply, RotateCcw, ShieldAlert, ShieldCheck, UserRound, X } from "lucide-react";
import { dataSource, MessageError, type Conversation, type DirectMessage, type MessageQuote, type MessageReportReason, type PeerTrust } from "../../data";
import { fullTimestamp } from "../../lib/time";
import { useMediaViewer } from "../posts/MediaViewer";
import { profileHref } from "../profile/links";
import { useSecurity } from "../../state/security";
import { useViewer } from "../../state/session";
import { useToast } from "../../state/toast";
import { Avatar } from "../../ui/Avatar";
import { Button, IconButton } from "../../ui/Button";
import { Sheet } from "../../ui/Sheet";
import { Skeleton } from "../../ui/Skeleton";
import { StateMessage } from "../../ui/StateMessage";
import { VerifiedBadge } from "../../ui/VerifiedBadge";
import { describeError } from "../feed/errors";
import { clockTime, dayLabel, sameDay, STATUS_LABEL } from "./format";
import { MessageComposer } from "./MessageComposer";
import { useConversation, type PendingMessage } from "./useMessages";
import "./Security.css";

/** Messages closer together than this from the same person share one timestamp. */
const RUN_GAP_MS = 5 * 60_000;
const REPORT_CONTEXT = 12;

type Row =
  | { kind: "message"; m: DirectMessage }
  | { kind: "pending"; p: PendingMessage };

export function ConversationPane({ conversationId }: { conversationId: string }) {
  const c = useConversation(conversationId);
  const viewer = useViewer();
  const navigate = useNavigate();
  const toast = useToast();
  const [replyTo, setReplyTo] = useState<MessageQuote | null>(null);
  const [sheet, setSheet] = useState<null | "menu" | "block" | "report">(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const conversation = c.view?.conversation;
  const security = dataSource.messages?.security;
  const { setup, verify } = useSecurity();
  const [trust, setTrust] = useState<PeerTrust | null>(null);
  const [trustKey, setTrustKey] = useState(0);
  const peerId = conversation?.peer.id;

  // How this person's identity looks from here; re-checked after any verification finishes.
  useEffect(() => {
    if (!security || !peerId) return;
    let cancelled = false;
    security.peerTrust(viewer.id, peerId).then((t) => !cancelled && setTrust(t), () => undefined);
    return () => {
      cancelled = true;
    };
  }, [security, peerId, viewer.id, setup, trustKey]);

  // Stay pinned to the newest message unless you've scrolled up to read.
  const rowsKey = `${c.messages.length}:${c.pending.length}:${c.peerTyping}`;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [rowsKey, c.status]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  useEffect(() => setReplyTo(null), [conversationId]);

  const back = (
    <IconButton label="Back to messages" className="convo__back" onClick={() => navigate("/messages")}>
      <ArrowLeft size={22} />
    </IconButton>
  );

  if (c.status === "loading") {
    return (
      <div className="convo">
        <header className="convo__head">
          {back}
          <Skeleton width={36} height={36} radius="var(--radius-full)" />
          <Skeleton width={140} height={16} />
        </header>
        <div className="convo__scroll" aria-busy="true" aria-label="Loading conversation" />
      </div>
    );
  }
  if (c.status === "error" || c.status === "missing" || !conversation) {
    return (
      <div className="convo">
        <header className="convo__head">{back}</header>
        {c.status === "error" ? (
          <StateMessage
            tone="error"
            icon={<CircleAlert size={24} />}
            {...describeError(c.error, "this conversation")}
            action={<Button variant="secondary" onClick={c.retry}>Try again</Button>}
          />
        ) : (
          <StateMessage
            icon={<CircleAlert size={24} />}
            title="Conversation not found"
            body="It may have been removed, or you're not part of it."
            action={<Link className="btn btn--secondary btn--md" to="/messages">Back to messages</Link>}
          />
        )}
      </div>
    );
  }

  const peer = conversation.peer;
  const href = profileHref(peer.handle);
  const rows: Row[] = [...c.messages.map((m) => ({ kind: "message" as const, m })), ...c.pending.map((p) => ({ kind: "pending" as const, p }))];
  const lastOwn = [...c.messages].reverse().find((m) => m.fromViewer);
  const send = async (input: Parameters<typeof c.send>[0]) => {
    stick.current = true;
    const err = await c.send(input);
    if (err) toast(sendErrorText(err, peer.name), "error");
    if (err instanceof MessageError && err.code === "identity-changed") setTrustKey((k) => k + 1);
  };
  const acceptChange = async () => {
    await security?.acceptIdentityChange(viewer.id, peer.id).catch(() => undefined);
    setTrustKey((k) => k + 1);
  };
  const keyChanged = trust === "changed" || trust === "changed-verified";

  return (
    <div className="convo">
      <header className="convo__head">
        {back}
        <Link to={href ?? "#"} className="convo__peer" aria-label={`${peer.name}, view profile`}>
          <Avatar name={peer.name} src={peer.avatarUrl} seed={peer.id} size="sm" />
          <span className="convo__peer-text">
            <span className="convo__peer-name">
              {peer.name}
              <VerifiedBadge verified={peer.verified} size={15} />
              {trust === "verified" && (
                <span className="trust trust--verified" title="You verified their security key">
                  <ShieldCheck size={13} aria-hidden="true" /> Verified
                </span>
              )}
              {keyChanged && (
                <span className="trust trust--changed" title="Their security key changed">
                  <ShieldAlert size={13} aria-hidden="true" /> Key changed
                </span>
              )}
            </span>
            <span className="convo__peer-sub" aria-live="polite">
              {c.peerTyping ? <span className="convo__typing-label">typing…</span> : `@${peer.handle}`}
            </span>
          </span>
        </Link>
        <IconButton label="Conversation options" onClick={() => setSheet("menu")}>
          <MoreHorizontal size={22} />
        </IconButton>
      </header>

      <div className="convo__scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="convo__intro">
          <Avatar name={peer.name} src={peer.avatarUrl} seed={peer.id} size="lg" />
          <p className="convo__intro-name">
            {peer.name}
            <VerifiedBadge verified={peer.verified} size={18} />
          </p>
          <p className="convo__intro-handle">@{peer.handle}</p>
          {href && (
            <Link to={href} className="btn btn--secondary btn--sm">
              View profile
            </Link>
          )}
          <EncryptionNote />
          {security && trust === "unverified" && (
            <p className="convo__note">
              <span>
                Want extra certainty? <button type="button" className="link-btn" onClick={() => verify(peer.id)}>Verify {peer.name}</button> by
                comparing emoji, in person or on a call.
              </span>
            </p>
          )}
          {trust === "verified" && (
            <p className="convo__note">
              <ShieldCheck size={14} aria-hidden="true" /> You verified {peer.name}'s security key.
            </p>
          )}
        </div>

        <ol className="msgs" aria-label={`Messages with ${peer.name}`}>
          {rows.map((row, i) => {
            const at = row.kind === "message" ? row.m.createdAt : row.p.createdAt;
            const prev = rows[i - 1];
            const prevAt = prev ? (prev.kind === "message" ? prev.m.createdAt : prev.p.createdAt) : null;
            const next = rows[i + 1];
            const mine = row.kind === "pending" || row.m.fromViewer;
            const nextMine = next ? next.kind === "pending" || next.m.fromViewer : null;
            const nextAt = next ? (next.kind === "message" ? next.m.createdAt : next.p.createdAt) : null;
            const endOfRun = !next || nextMine !== mine || !nextAt || nextAt.getTime() - at.getTime() > RUN_GAP_MS;
            return (
              <Fragment key={row.kind === "message" ? row.m.id : row.p.localId}>
                {(!prevAt || !sameDay(prevAt, at)) && (
                  <li className="msgs__day" aria-label={dayLabel(at)}>
                    <span>{dayLabel(at)}</span>
                  </li>
                )}
                {row.kind === "message" ? (
                  <MessageBubble
                    m={row.m}
                    peerName={peer.name}
                    showMeta={endOfRun || row.m.id === lastOwn?.id}
                    showStatus={row.m.id === lastOwn?.id && c.pending.length === 0}
                    onReply={() => setReplyTo({ id: row.m.id, fromViewer: row.m.fromViewer, text: row.m.text, hasImage: row.m.media.length > 0 })}
                  />
                ) : (
                  <PendingBubble p={row.p} onRetry={() => c.retrySend(row.p.localId).then((e) => e && toast(sendErrorText(e, peer.name), "error"))} onDiscard={() => c.discard(row.p.localId)} />
                )}
              </Fragment>
            );
          })}
          {c.peerTyping && (
            <li className="msg msg--theirs msg--typing" aria-label={`${peer.name} is typing`}>
              <span className="msg__bubble">
                <span className="typing-dots" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
              </span>
            </li>
          )}
        </ol>
      </div>

      {keyChanged && conversation.canSend && (
        <div className={`sec-banner${trust === "changed-verified" ? " sec-banner--warn" : ""}`} role="status">
          <ShieldAlert size={18} aria-hidden="true" />
          <div className="sec-banner__text">
            <strong>{peer.name}'s security key changed.</strong> This usually means they set up a new phone or reset their account.
            {trust === "changed-verified" ? " You'd verified them before — verify again to be sure it's really them." : ""}
            <div className="sec-banner__actions">
              <Button size="sm" variant={trust === "changed-verified" ? "primary" : "secondary"} onClick={() => verify(peer.id)}>
                {trust === "changed-verified" ? "Verify again" : "Verify"}
              </Button>
              <Button size="sm" variant="ghost" onClick={acceptChange}>
                {trust === "changed-verified" ? "Continue without verifying" : "OK"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {conversation.canSend && trust === "changed-verified" ? null : conversation.canSend ? (
        <MessageComposer conversationId={conversationId} peerName={peer.name} replyTo={replyTo} onCancelReply={() => setReplyTo(null)} onSend={send} />
      ) : (
        <div className="convo__blocked" role="status">
          {conversation.blockedByViewer ? (
            <>
              <p>You blocked @{peer.handle}. Neither of you can send messages.</p>
              <Button variant="secondary" size="sm" onClick={() => setSheet("block")}>
                Unblock
              </Button>
            </>
          ) : (
            <p>You can't reply to this conversation.</p>
          )}
        </div>
      )}

      <Sheet open={sheet === "menu"} onClose={() => setSheet(null)} label="Conversation options">
        <div className="sheet-menu">
          {href && (
            <Link to={href} className="sheet-menu__item" onClick={() => setSheet(null)}>
              <UserRound size={20} aria-hidden="true" /> View profile
            </Link>
          )}
          {security && trust !== "verified" && (
            <button
              className="sheet-menu__item"
              onClick={() => {
                setSheet(null);
                void verify(peer.id);
              }}
            >
              <ShieldCheck size={20} aria-hidden="true" /> {keyChanged ? `Verify @${peer.handle} again` : `Verify @${peer.handle}`}
            </button>
          )}
          <button className="sheet-menu__item" onClick={() => setSheet("block")}>
            <Ban size={20} aria-hidden="true" /> {conversation.blockedByViewer ? `Unblock @${peer.handle}` : `Block @${peer.handle}`}
          </button>
          <button className="sheet-menu__item sheet-menu__item--danger" onClick={() => setSheet("report")}>
            <Flag size={20} aria-hidden="true" /> Report conversation
          </button>
          <Button variant="ghost" block onClick={() => setSheet(null)}>
            Cancel
          </Button>
        </div>
      </Sheet>

      <Sheet open={sheet === "block"} onClose={() => setSheet(null)} label={conversation.blockedByViewer ? "Unblock" : "Block"}>
        <BlockSheet conversation={conversation} viewerId={viewer.id} onDone={() => setSheet(null)} />
      </Sheet>

      <Sheet open={sheet === "report"} onClose={() => setSheet(null)} label="Report conversation">
        {sheet === "report" && <ReportSheet conversation={conversation} messages={c.messages} viewerId={viewer.id} onDone={() => setSheet(null)} />}
      </Sheet>
    </div>
  );
}

function sendErrorText(e: Error, peerName: string) {
  if (e instanceof MessageError && e.code === "blocked") return `You can't message ${peerName} right now.`;
  if (e instanceof MessageError && e.code === "too-long") return "That message is too long.";
  if (e instanceof MessageError && e.code === "peer-unavailable") return `${peerName} can't receive encrypted messages yet — they need to open Amigo World once.`;
  if (e instanceof MessageError && e.code === "identity-changed") return `${peerName}'s security key changed. Check the notice above, then send again.`;
  if (e instanceof MessageError && e.code === "device-unverified") return "Approve this device from another of your devices before sending.";
  return "Your message wasn't sent. Tap Retry to try again.";
}

/** Says exactly what protects these messages — never more than the backend really does. */
function EncryptionNote() {
  if (dataSource.messages?.encryption === "e2e") {
    return (
      <p className="convo__note">
        <Lock size={14} aria-hidden="true" /> Messages are end-to-end encrypted. Only you and the people in this conversation can read them.
      </p>
    );
  }
  return (
    <p className="convo__note">
      <Info size={14} aria-hidden="true" /> Demo: messages stay in this browser and aren't end-to-end encrypted yet.
    </p>
  );
}

function MessageBubble({ m, peerName, showMeta, showStatus, onReply }: { m: DirectMessage; peerName: string; showMeta: boolean; showStatus: boolean; onReply: () => void }) {
  const openMedia = useMediaViewer();
  const jump = () => {
    const el = m.replyTo && document.getElementById(`msg-${m.replyTo.id}`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("is-flash");
    setTimeout(() => el.classList.remove("is-flash"), 1200);
  };
  return (
    <li id={`msg-${m.id}`} className={`msg ${m.fromViewer ? "msg--mine" : "msg--theirs"}`}>
      <div className="msg__line">
        <div className="msg__bubble">
          <span className="visually-hidden">{m.fromViewer ? "You" : peerName}: </span>
          {m.replyTo && (
            <button type="button" className="msg__quote" onClick={jump} aria-label={`Reply to ${m.replyTo.fromViewer ? "you" : peerName}: ${m.replyTo.text || "Photo"}. Show message`}>
              <span className="msg__quote-who">{m.replyTo.fromViewer ? "You" : peerName}</span>
              <span className="msg__quote-text">{m.replyTo.text || (m.replyTo.hasImage ? "Photo" : "Message")}</span>
            </button>
          )}
          {m.undecryptable ? (
            <p className="msg__text msg__text--muted">
              <Lock size={14} aria-hidden="true" /> This message can't be decrypted on this device.
            </p>
          ) : (
            <>
              {m.media.map((media, i) => (
                <button key={i} type="button" className="msg__image" onClick={() => openMedia(m.media, i)} aria-label="Open photo">
                  <img src={media.url} alt={media.alt ?? ""} width={media.width} height={media.height} loading="lazy" />
                </button>
              ))}
              {m.text && <p className="msg__text">{m.text}</p>}
            </>
          )}
        </div>
        <IconButton label="Reply" size="sm" className="msg__reply" onClick={onReply}>
          <Reply size={16} />
        </IconButton>
      </div>
      {showMeta && (
        <p className="msg__meta">
          <time dateTime={m.createdAt.toISOString()} title={fullTimestamp(m.createdAt)}>
            {clockTime(m.createdAt)}
          </time>
          {showStatus && <span className={`msg__status msg__status--${m.status}`}>· {STATUS_LABEL[m.status]}</span>}
          {m.unverifiedDevice && <span className="msg__status"> · from a device they haven't verified</span>}
        </p>
      )}
    </li>
  );
}

function PendingBubble({ p, onRetry, onDiscard }: { p: PendingMessage; onRetry: () => void; onDiscard: () => void }) {
  return (
    <li className={`msg msg--mine is-pending${p.failed ? " is-failed" : ""}`}>
      <div className="msg__line">
        <div className="msg__bubble">
          {p.previewUrl && (
            <span className="msg__image">
              <img src={p.previewUrl} alt="" width={p.input.image?.width} height={p.input.image?.height} />
            </span>
          )}
          {p.input.text && <p className="msg__text">{p.input.text}</p>}
        </div>
      </div>
      <p className="msg__meta" role={p.failed ? "alert" : undefined}>
        {p.failed ? (
          <>
            <span className="msg__status msg__status--failed">{STATUS_LABEL.failed}</span>
            <button type="button" className="link-btn" onClick={onRetry}>
              <RotateCcw size={13} aria-hidden="true" /> Retry
            </button>
            <button type="button" className="link-btn" onClick={onDiscard}>
              <X size={13} aria-hidden="true" /> Delete
            </button>
          </>
        ) : (
          <span className="msg__status msg__status--sending">{STATUS_LABEL.sending}</span>
        )}
      </p>
    </li>
  );
}

function BlockSheet({ conversation, viewerId, onDone }: { conversation: Conversation; viewerId: string; onDone: () => void }) {
  const api = dataSource.messages!;
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const peer = conversation.peer;
  const blocking = !conversation.blockedByViewer;

  async function go() {
    setBusy(true);
    try {
      await (blocking ? api.block(viewerId, peer.id) : api.unblock(viewerId, peer.id));
      toast(blocking ? `Blocked @${peer.handle}` : `Unblocked @${peer.handle}`);
      onDone();
    } catch {
      toast(blocking ? "Couldn't block. Try again." : "Couldn't unblock. Try again.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet-form">
      <h2 className="sheet-form__title">{blocking ? `Block @${peer.handle}?` : `Unblock @${peer.handle}?`}</h2>
      <p className="sheet-form__body">
        {blocking
          ? "Neither of you will be able to send messages in this conversation. They aren't told that you blocked them. You can unblock any time."
          : "You'll both be able to send messages again."}
      </p>
      <div className="sheet-form__actions">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button variant={blocking ? "danger" : "primary"} loading={busy} onClick={go}>
          {blocking ? "Block" : "Unblock"}
        </Button>
      </div>
    </div>
  );
}

const REASONS: { id: MessageReportReason; label: string }[] = [
  { id: "spam", label: "Spam or scam" },
  { id: "harassment", label: "Harassment or bullying" },
  { id: "inappropriate", label: "Inappropriate content" },
  { id: "other", label: "Something else" },
];

function ReportSheet({ conversation, messages, viewerId, onDone }: { conversation: Conversation; messages: DirectMessage[]; viewerId: string; onDone: () => void }) {
  const api = dataSource.messages!;
  const toast = useToast();
  const [reason, setReason] = useState<MessageReportReason | null>(null);
  const [note, setNote] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const theirs = messages.filter((m) => !m.fromViewer && !m.undecryptable && (m.text || m.media.length)).slice(-REPORT_CONTEXT);
  const toggle = (id: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function submit() {
    if (!reason) return;
    setBusy(true);
    try {
      // Only the messages you ticked are shared — nothing else from the conversation.
      await api.report(viewerId, conversation.id, { reason, note, messageIds: theirs.filter((m) => picked.has(m.id)).map((m) => m.id) });
      toast("Thanks — your report was sent to the Amigo team");
      onDone();
    } catch {
      toast("Couldn't send the report. Try again.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet-form">
      <h2 className="sheet-form__title">Report @{conversation.peer.handle}</h2>
      <fieldset className="sheet-form__choices">
        <legend className="sheet-form__body">What's wrong?</legend>
        {REASONS.map((r) => (
          <label key={r.id} className="choice">
            <input type="radio" name="report-reason" checked={reason === r.id} onChange={() => setReason(r.id)} />
            {r.label}
          </label>
        ))}
      </fieldset>
      {theirs.length > 0 && (
        <fieldset className="sheet-form__choices report-pick">
          <legend className="sheet-form__body">
            Choose messages to include (optional). Only what you select is shared with the Amigo team — they can't see the rest of this
            conversation.
          </legend>
          {theirs.map((m) => (
            <label key={m.id} className="choice report-pick__item">
              <input type="checkbox" checked={picked.has(m.id)} onChange={() => toggle(m.id)} />
              <span>
                <span className="report-pick__text">{m.text || "Photo"}</span>
                <span className="report-pick__time">{clockTime(m.createdAt)}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <label className="field">
        <span className="field__label">Anything else? (optional)</span>
        <textarea className="field__input" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="sheet-form__actions">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button variant="danger" disabled={!reason} loading={busy} onClick={submit}>
          {picked.size ? `Send report with ${picked.size} message${picked.size === 1 ? "" : "s"}` : "Send report"}
        </Button>
      </div>
    </div>
  );
}
