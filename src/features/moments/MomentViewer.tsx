import { useCallback, useEffect, useRef, useState, type FormEvent, type PointerEvent } from "react";
import { useNavigate } from "react-router";
import { ChevronLeft, ChevronRight, Eye, MoreHorizontal, Send, Trash2, Flag, UsersRound, X } from "lucide-react";
import { dataSource, MessageError, MOMENT_REACTIONS, type Moment, type MomentGroup, type MomentViewer as Viewer, type MessageReportReason } from "../../data";
import { timeAgo, timeAgoLong, fullTimestamp } from "../../lib/time";
import { profileHref } from "../profile/links";
import { REPORT_REASONS } from "../reports/reasons";
import { useViewer } from "../../state/session";
import { useToast } from "../../state/toast";
import { Avatar } from "../../ui/Avatar";
import { Button, IconButton } from "../../ui/Button";
import { Sheet } from "../../ui/Sheet";
import { VerifiedBadge } from "../../ui/VerifiedBadge";
import { MomentVisual } from "./MomentVisual";
import "./Moments.css";

/** How long each Moment shows before moving on. */
const DURATION_MS = 6000;
const firstUnseen = (g: MomentGroup) => Math.max(0, g.moments.findIndex((m) => !m.seen));

type Pos = { gi: number; mi: number } | null;

/**
 * Full-screen Moments viewer. Phones: tap right/left for next/previous, hold
 * to pause, swipe down (or Back) to close, swipe sideways to skip a person.
 * Keyboard: ← → Space Esc. Desktop: the Moment in a 9:16 frame with arrows.
 */
export function MomentViewer({ queue, live, start, onClose }: { queue: MomentGroup[]; live: MomentGroup[] | null; start: number; onClose: () => void }) {
  const viewer = useViewer();
  const navigate = useNavigate();
  const toast = useToast();
  const api = dataSource.moments!;
  const ref = useRef<HTMLDialogElement>(null);
  const [pos, setPos] = useState<Pos>(() => ({ gi: start, mi: firstUnseen(queue[start]) }));
  const [held, setHeld] = useState(false);
  const [showPaused, setShowPaused] = useState(false);
  const [typing, setTyping] = useState(false);
  const [sheet, setSheet] = useState<null | "menu" | "viewers" | "report" | "delete">(null);
  const [progress, setProgress] = useState(0);
  const [drag, setDrag] = useState(0);
  const elapsed = useRef(0);
  const press = useRef<{ x: number; y: number; t: number; timer?: ReturnType<typeof setTimeout> } | null>(null);
  const closedBy = useRef<"popstate" | "navigate" | null>(null);

  const group = pos ? queue[pos.gi] : null;
  const snapshot = group && pos ? group.moments[pos.mi] : null;
  // Live data (reactions, view counts) when we have it; the snapshot keeps playback stable.
  const moment: Moment | null = snapshot ? (live?.find((g) => g.author.id === group!.author.id)?.moments.find((m) => m.id === snapshot.id) ?? snapshot) : null;
  const own = !!group?.isViewer;
  const paused = held || typing || !!sheet;

  const close = useCallback(() => setPos(null), []);

  // Open as a modal; Back (or swipe-back) closes it.
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) {
      d.showModal();
      d.focus();
    }
    if (!history.state?.momentViewer) history.pushState({ ...(history.state ?? {}), momentViewer: true }, "");
    const onPop = () => {
      closedBy.current = "popstate";
      setPos(null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (pos) return;
    ref.current?.close();
    if (!closedBy.current && history.state?.momentViewer) history.back();
    onClose();
  }, [pos, onClose]);

  const next = useCallback(() => {
    setPos((p) => {
      if (!p) return p;
      const g = queue[p.gi];
      if (p.mi < g.moments.length - 1) return { gi: p.gi, mi: p.mi + 1 };
      if (p.gi < queue.length - 1) return { gi: p.gi + 1, mi: firstUnseen(queue[p.gi + 1]) };
      return null;
    });
  }, [queue]);

  const prev = useCallback(() => {
    setPos((p) => {
      if (!p) return p;
      if (p.mi > 0) return { gi: p.gi, mi: p.mi - 1 };
      if (p.gi > 0) return { gi: p.gi - 1, mi: 0 };
      elapsed.current = 0;
      setProgress(0);
      return { ...p };
    });
  }, []);

  const skipPerson = useCallback(
    (dir: 1 | -1) =>
      setPos((p) => {
        if (!p) return p;
        const gi = p.gi + dir;
        if (gi < 0) return { gi: 0, mi: 0 };
        if (gi >= queue.length) return null;
        return { gi, mi: dir === 1 ? firstUnseen(queue[gi]) : 0 };
      }),
    [queue],
  );

  // New Moment on screen: restart the clock and count the view.
  const momentId = snapshot?.id;
  useEffect(() => {
    elapsed.current = 0;
    setProgress(0);
    if (momentId && !own) api.markSeen(viewer.id, momentId).catch(() => undefined);
  }, [momentId, own, api, viewer.id]);

  // The clock (paused while holding, typing a reply, or a sheet is open).
  useEffect(() => {
    if (paused || !momentId) return;
    let raf = 0;
    let last = performance.now();
    const tick = (t: number) => {
      elapsed.current += t - last;
      last = t;
      const p = elapsed.current / DURATION_MS;
      if (p >= 1) return next();
      setProgress(p);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [paused, momentId, next]);

  useEffect(() => {
    if (!held) return setShowPaused(false);
    const t = setTimeout(() => setShowPaused(true), 350);
    return () => clearTimeout(t);
  }, [held]);

  // ------------------------------------------------------------- gestures

  const interactive = (t: EventTarget) => !!(t as HTMLElement).closest("button, a, input, textarea, form");

  function onPointerDown(e: PointerEvent) {
    if (interactive(e.target)) return;
    press.current = { x: e.clientX, y: e.clientY, t: performance.now() };
    setHeld(true);
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }
  function onPointerMove(e: PointerEvent) {
    if (!press.current) return;
    const dy = e.clientY - press.current.y;
    setDrag(dy > 0 ? dy : 0);
  }
  function onPointerUp(e: PointerEvent) {
    const p = press.current;
    press.current = null;
    setHeld(false);
    setDrag(0);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    const dt = performance.now() - p.t;
    if (dy > 90 && Math.abs(dy) > Math.abs(dx)) return close();
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) return skipPerson(dx < 0 ? 1 : -1);
    if (dt < 350 && Math.abs(dx) < 12 && Math.abs(dy) < 12) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      if (e.clientX - rect.left < rect.width / 3) prev();
      else next();
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (typing || sheet) return;
    if (e.key === "ArrowRight") next();
    else if (e.key === "ArrowLeft") prev();
    else if (e.key === " ") {
      e.preventDefault();
      setHeld((h) => !h);
    }
  }

  // --------------------------------------------------------------- actions

  async function react(emoji: string) {
    if (!moment) return;
    const nextEmoji = moment.viewerReaction === emoji ? null : emoji;
    try {
      await api.react(viewer.id, moment.id, nextEmoji);
      if (nextEmoji) toast(`Reacted ${nextEmoji}`);
    } catch {
      toast("Couldn't react. Try again.", "error");
    }
  }

  function goToProfile(e: React.MouseEvent, href: string) {
    e.preventDefault();
    closedBy.current = "navigate";
    setPos(null);
    navigate(href, { replace: !!history.state?.momentViewer });
  }

  if (!pos || !group || !moment) return <dialog ref={ref} className="moment-viewer" aria-label="Moments" />;

  const href = profileHref(group.author.handle);

  return (
    <dialog
      ref={ref}
      className="moment-viewer"
      tabIndex={-1}
      aria-label={`${group.author.name}'s Moments`}
      onCancel={(e) => {
        e.preventDefault();
        if (!sheet) close();
      }}
      onKeyDown={onKeyDown}
    >
      <div className="moment-viewer__stage">
        <button type="button" className="moment-viewer__nav" aria-label="Previous" onClick={prev} disabled={pos.gi === 0 && pos.mi === 0}>
          <ChevronLeft size={24} />
        </button>

        <div
          className="moment-viewer__frame"
          style={drag ? { transform: `translateY(${drag}px)`, opacity: Math.max(0.4, 1 - drag / 400) } : undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            press.current = null;
            setHeld(false);
            setDrag(0);
          }}
        >
          <MomentVisual text={moment.text} background={moment.background} media={moment.media} />

          <div className="moment-viewer__top">
            <div className="moment-viewer__bars" aria-hidden="true">
              {group.moments.map((m, i) => (
                <span key={m.id} className="moment-viewer__bar">
                  <span style={{ transform: `scaleX(${i < pos.mi ? 1 : i === pos.mi ? progress : 0})` }} />
                </span>
              ))}
            </div>
            <div className="moment-viewer__head">
              <a href={href ?? "#"} className="moment-viewer__who" onClick={(e) => href && goToProfile(e, href)}>
                <Avatar name={group.author.name} src={group.author.avatarUrl} seed={group.author.id} size="sm" />
                <span className="moment-viewer__name">
                  {own ? "Your Moment" : group.author.name}
                  {!own && <VerifiedBadge verified={group.author.verified} size={14} />}
                </span>
              </a>
              <time className="moment-viewer__time" dateTime={moment.createdAt.toISOString()} title={fullTimestamp(moment.createdAt)}>
                {timeAgo(moment.createdAt)}
              </time>
              {moment.audience === "followers" && (
                <span className="moment-viewer__time" title="Followers only">
                  <UsersRound size={14} aria-label="Followers only" />
                </span>
              )}
              <span className="moment-viewer__head-actions">
                <IconButton label="More options" onClick={() => setSheet("menu")}>
                  <MoreHorizontal size={22} />
                </IconButton>
                <IconButton label="Close" onClick={close}>
                  <X size={22} />
                </IconButton>
              </span>
            </div>
          </div>

          {showPaused && <span className="moment-viewer__paused">Paused</span>}

          <div className="moment-viewer__bottom">
            {own ? (
              <button type="button" className="moment-viewer__seen" onClick={() => setSheet("viewers")}>
                <Eye size={18} aria-hidden="true" /> Seen by {moment.viewCount ?? 0}
              </button>
            ) : (
              <>
                <div className="moment-viewer__reactions" role="group" aria-label="React">
                  {MOMENT_REACTIONS.map((r) => (
                    <button key={r} type="button" className="moment-react" aria-pressed={moment.viewerReaction === r} aria-label={`React ${r}`} onClick={() => react(r)}>
                      {r}
                    </button>
                  ))}
                </div>
                <ReplyBox moment={moment} onTyping={setTyping} />
              </>
            )}
          </div>
        </div>

        <button type="button" className="moment-viewer__nav" aria-label="Next" onClick={next}>
          <ChevronRight size={24} />
        </button>
      </div>

      <Sheet open={sheet === "menu"} onClose={() => setSheet(null)} label="Moment options">
        <div className="sheet-menu">
          {own ? (
            <button className="sheet-menu__item sheet-menu__item--danger" onClick={() => setSheet("delete")}>
              <Trash2 size={20} aria-hidden="true" /> Delete Moment
            </button>
          ) : (
            <button className="sheet-menu__item sheet-menu__item--danger" onClick={() => setSheet("report")}>
              <Flag size={20} aria-hidden="true" /> Report Moment
            </button>
          )}
          <Button variant="ghost" block onClick={() => setSheet(null)}>
            Cancel
          </Button>
        </div>
      </Sheet>

      <Sheet open={sheet === "delete"} onClose={() => setSheet(null)} label="Delete Moment">
        <div className="sheet-form">
          <h2 className="sheet-form__title">Delete this Moment?</h2>
          <p className="sheet-form__body">It disappears for everyone straight away.</p>
          <div className="sheet-form__actions">
            <Button variant="ghost" onClick={() => setSheet(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                try {
                  await api.delete(viewer.id, moment.id);
                  toast("Moment deleted");
                  setSheet(null);
                  if (group.moments.length === 1) close();
                  else next();
                } catch {
                  toast("Couldn't delete it. Try again.", "error");
                }
              }}
            >
              Delete
            </Button>
          </div>
        </div>
      </Sheet>

      <Sheet open={sheet === "viewers"} onClose={() => setSheet(null)} label="Viewers">
        {sheet === "viewers" && <ViewersList momentId={moment.id} />}
      </Sheet>

      <Sheet open={sheet === "report"} onClose={() => setSheet(null)} label="Report Moment">
        {sheet === "report" && <ReportMoment moment={moment} onDone={() => setSheet(null)} />}
      </Sheet>
    </dialog>
  );
}

/** Replies go to the author as a direct message (private to you two; end-to-end encrypted on Supabase). */
function ReplyBox({ moment, onTyping }: { moment: Moment; onTyping: (typing: boolean) => void }) {
  const viewer = useViewer();
  const toast = useToast();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const messages = dataSource.messages;
  if (!messages) return null;

  async function send(e: FormEvent) {
    e.preventDefault();
    const reply = text.trim();
    if (!reply) return;
    setSending(true);
    try {
      const conversationId = await messages!.openConversation(viewer.id, moment.author.id);
      const about = moment.text ? `“${moment.text.length > 60 ? `${moment.text.slice(0, 60)}…` : moment.text}”` : "(photo)";
      await messages!.send(viewer.id, conversationId, { text: `Replied to your Moment ${about}\n${reply}` });
      setText("");
      toast(`Reply sent to ${moment.author.name} in Messages`);
    } catch (err) {
      const code = err instanceof MessageError ? err.code : "unknown";
      toast(
        code === "blocked"
          ? `You can't message ${moment.author.name} right now.`
          : code === "device-unverified"
            ? "Approve this device in Messages first to send replies."
            : code === "peer-unavailable"
              ? `${moment.author.name} can't receive messages yet.`
              : code === "identity-changed"
                ? `${moment.author.name}'s security key changed — open your conversation in Messages to review it.`
                : "Couldn't send your reply. Try again.",
        "error",
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <form className="moment-viewer__reply" onSubmit={send}>
      <label className="visually-hidden" htmlFor="moment-reply">
        Reply to {moment.author.name}
      </label>
      <input
        id="moment-reply"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => onTyping(true)}
        onBlur={() => onTyping(false)}
        placeholder={`Reply to ${moment.author.name}…`}
        maxLength={1000}
        autoComplete="off"
      />
      <IconButton label="Send reply" type="submit" disabled={!text.trim() || sending}>
        <Send size={20} />
      </IconButton>
    </form>
  );
}

function ViewersList({ momentId }: { momentId: string }) {
  const viewer = useViewer();
  const [list, setList] = useState<Viewer[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    dataSource.moments!.viewers(viewer.id, momentId).then((l) => !cancelled && setList(l), () => !cancelled && setList([]));
    return () => {
      cancelled = true;
    };
  }, [momentId, viewer.id]);

  return (
    <div className="sheet-form">
      <h2 className="sheet-form__title">Seen by {list ? list.length : "…"}</h2>
      {list && list.length === 0 && <p className="sheet-form__body">No one has seen it yet.</p>}
      {list && list.length > 0 && (
        <ul className="moment-viewers">
          {list.map((v) => (
            <li key={v.person.id}>
              <Avatar name={v.person.name} src={v.person.avatarUrl} seed={v.person.id} size="sm" />
              <span className="moment-viewers__who">
                <span>{v.person.name}</span>
                <span>
                  @{v.person.handle} · {timeAgoLong(v.viewedAt)}
                </span>
              </span>
              {v.reaction && (
                <span className="moment-viewers__reaction" aria-label={`Reacted ${v.reaction}`}>
                  {v.reaction}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ReportMoment({ moment, onDone }: { moment: Moment; onDone: () => void }) {
  const viewer = useViewer();
  const toast = useToast();
  const [reason, setReason] = useState<MessageReportReason | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!reason) return;
    setBusy(true);
    try {
      await dataSource.moments!.report(viewer.id, moment.id, { reason, note });
      toast("Thanks — the Amigo team will review this Moment");
      onDone();
    } catch {
      toast("Couldn't send the report. Try again.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet-form">
      <h2 className="sheet-form__title">Report this Moment</h2>
      <fieldset className="sheet-form__choices">
        <legend className="sheet-form__body">What's wrong?</legend>
        {REPORT_REASONS.map((r) => (
          <label key={r.id} className="choice">
            <input type="radio" name="moment-report-reason" checked={reason === r.id} onChange={() => setReason(r.id)} />
            {r.label}
          </label>
        ))}
      </fieldset>
      <label className="field">
        <span className="field__label">Anything else? (optional)</span>
        <textarea className="field__input" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <p className="sheet-form__body">The Amigo team sees this Moment and your report — never your messages.</p>
      <div className="sheet-form__actions">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button variant="danger" disabled={!reason} loading={busy} onClick={submit}>
          Send report
        </Button>
      </div>
    </div>
  );
}
