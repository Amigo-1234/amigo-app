import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowLeft, BadgeCheck, CircleAlert, ExternalLink, Flag, HandHeart, MessageSquareText, SearchX } from "lucide-react";
import { dataSource, SUPPORT_LIMITS, type SupportFeedback, type SupportReaction, type SupportRequest } from "../data";
import { askOf, categoryLabel, hostOf, reactionLabel, SUPPORT_REACTIONS } from "../data/supportRules";
import { describeError } from "../features/feed/errors";
import { profileHref } from "../features/profile/links";
import { Progress, statusLabel } from "../features/support/SupportCard";
import { supportErrorText, useSupportConfig, useSupportRequest } from "../features/support/useSupport";
import { fullTimestamp, timeAgo } from "../lib/time";
import { ScreenHeader } from "../shell/ScreenHeader";
import { useViewer } from "../state/session";
import { useToast } from "../state/toast";
import { Avatar } from "../ui/Avatar";
import { Button, IconButton } from "../ui/Button";
import { Skeleton } from "../ui/Skeleton";
import { StateMessage } from "../ui/StateMessage";
import "../features/support/Support.css";

export default function SupportRequestScreen() {
  const { requestId = "" } = useParams();
  const navigate = useNavigate();
  const { state, retry } = useSupportRequest(requestId);
  const back = () => (window.history.state?.idx > 0 ? navigate(-1) : navigate("/support"));
  return (
    <>
      <ScreenHeader
        title="Support request"
        leading={
          <IconButton label="Back" onClick={back} className="back-btn">
            <ArrowLeft size={22} />
          </IconButton>
        }
      />
      {state.status === "loading" && (
        <div className="support-detail" aria-busy="true" aria-label="Loading request">
          <Skeleton width={180} height={14} />
          <Skeleton width="85%" height={26} />
          <Skeleton width="100%" height={14} />
          <Skeleton width="70%" height={14} />
        </div>
      )}
      {state.status === "error" && (
        <StateMessage tone="error" icon={<CircleAlert size={24} />} {...describeError(state.error, "this request")}
          action={<Button variant="secondary" onClick={retry}>Try again</Button>} />
      )}
      {state.status === "ready" && !state.data && (
        <StateMessage icon={<SearchX size={24} />} title="This request isn't available" body="It may have been removed, or the link is wrong."
          action={<Button variant="secondary" onClick={() => navigate("/support")}>Back to Support Hub</Button>} />
      )}
      {state.status === "ready" && state.data && <RequestView r={state.data} />}
    </>
  );
}

function RequestView({ r }: { r: SupportRequest }) {
  const href = profileHref(r.creator.handle);
  const ask = askOf(r.ask);
  return (
    <>
      <article className="support-detail" aria-labelledby="support-title">
        <div className="support-detail__creator">
          <Avatar name={r.creator.name} src={r.creator.avatarUrl} seed={r.creator.id} size="md" />
          <span>
            {href ? <Link to={href} className="support-detail__name">{r.creator.name}</Link> : <span className="support-detail__name">{r.creator.name}</span>}
            <span className="support-detail__meta">
              @{r.creator.handle} · <time dateTime={r.createdAt.toISOString()} title={fullTimestamp(r.createdAt)}>{timeAgo(r.createdAt)}</time>
            </span>
          </span>
        </div>
        <p className="support-detail__tags">
          <span className="support-tag">{categoryLabel(r.category)}</span>
          {r.status !== "active" && <span className={`support-tag support-tag--${r.status}`}>{statusLabel(r)}</span>}
        </p>
        <h2 id="support-title" className="support-detail__title">{r.title}</h2>
        <p className="support-detail__desc">{r.description}</p>
        <dl className="support-detail__facts">
          <div>
            <dt>What they'd like</dt>
            <dd>{ask.label}</dd>
          </div>
          <div>
            <dt>Link</dt>
            <dd className="support-detail__url">{r.url}</dd>
          </div>
        </dl>
        <Progress r={r} />
      </article>

      <SupportPanel r={r} />
      {r.isViewer && <FeedbackList r={r} />}
      {!r.isViewer && <ReportLink r={r} />}
    </>
  );
}

/** Support → visit → come back → confirm → optional feedback. */
function SupportPanel({ r }: { r: SupportRequest }) {
  const viewer = useViewer();
  const toast = useToast();
  const config = useSupportConfig();
  const [busy, setBusy] = useState(false);
  const [openedAt, setOpenedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const host = hostOf(r.url);
  const ask = askOf(r.ask);

  useEffect(() => {
    if (r.viewerState !== "opened") return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [r.viewerState]);

  if (r.isViewer) {
    return (
      <section className="support-panel">
        <p className="support-panel__title">This is your request</p>
        <p className="support-panel__text">
          {r.status === "pending"
            ? "It's waiting for a quick review before it's shown to others."
            : r.status === "active"
              ? `${r.target - r.supporterCount} more ${r.target - r.supporterCount === 1 ? "supporter" : "supporters"} to reach your goal. Feedback people leave shows up below — only you can see it.`
              : r.status === "completed"
                ? "You reached your supporter goal. Feedback people left is below."
                : statusLabel(r) + "."}
        </p>
      </section>
    );
  }
  if (r.viewerState === "none" && r.status !== "active") {
    return (
      <section className="support-panel">
        <p className="support-panel__text">{r.status === "completed" ? "This request reached its goal." : "This request isn't open for support right now."}</p>
      </section>
    );
  }

  const open = async () => {
    // Open synchronously in the click so browsers don't block the new tab.
    window.open(r.url, "_blank", "noopener,noreferrer");
    setOpenedAt(Date.now());
    try {
      await dataSource.support!.openSupport(r.id, viewer.id);
    } catch (e) {
      toast(supportErrorText(e), "error");
    }
  };

  if (r.viewerState === "none") {
    return (
      <section className="support-panel">
        <Button size="lg" block onClick={open} icon={<HandHeart size={20} aria-hidden="true" />}>
          Support — {ask.verb.toLowerCase()} on {host}
        </Button>
        <p className="support-panel__hint">
          <ExternalLink size={14} aria-hidden="true" /> Opens {host} in a new tab. Take your time, then come back here to confirm and leave feedback.
          Nothing else is required — no follows, subscriptions or likes.
        </p>
      </section>
    );
  }

  if (r.viewerState === "opened") {
    const wait = config && openedAt ? Math.max(0, Math.ceil(config.minVisitSeconds - (now - openedAt) / 1000)) : 0;
    const confirm = async () => {
      setBusy(true);
      try {
        const earned = await dataSource.support!.confirmSupport(r.id, viewer.id);
        toast(`Thanks for supporting! +${earned.credits} credit · +${earned.reputation} reputation`);
      } catch (e) {
        toast(supportErrorText(e), "error");
      } finally {
        setBusy(false);
      }
    };
    return (
      <section className="support-panel support-panel--back" aria-live="polite">
        <p className="support-panel__title">Welcome back. Did you check it out?</p>
        <p className="support-panel__text">Confirm only if you actually checked it out — it's what makes Support Hub worth using.</p>
        <div className="support-panel__actions">
          <Button onClick={confirm} disabled={busy || wait > 0} loading={busy} icon={<BadgeCheck size={18} aria-hidden="true" />}>
            {wait > 0 ? `Yes, I supported this (${wait}s)` : "Yes, I supported this"}
          </Button>
          <Button variant="ghost" onClick={open}>
            Open link again
          </Button>
        </div>
      </section>
    );
  }

  return r.viewerFeedback ? (
    <section className="support-panel support-panel--done">
      <p className="support-panel__title">
        <BadgeCheck size={18} aria-hidden="true" /> You supported this and left feedback. Thank you.
      </p>
    </section>
  ) : (
    <FeedbackForm r={r} />
  );
}

function FeedbackForm({ r }: { r: SupportRequest }) {
  const viewer = useViewer();
  const toast = useToast();
  const config = useSupportConfig();
  const [reaction, setReaction] = useState<SupportReaction | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [skipped, setSkipped] = useState(false);
  if (skipped) {
    return (
      <section className="support-panel support-panel--done">
        <p className="support-panel__title">
          <BadgeCheck size={18} aria-hidden="true" /> You supported this. Thank you.
        </p>
      </section>
    );
  }
  const send = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const earned = await dataSource.support!.leaveFeedback(r.id, viewer.id, { reaction, text });
      toast(earned.credits ? `Feedback sent. +${earned.credits} credit · +${earned.reputation} reputation` : "Feedback sent");
    } catch (err) {
      toast(supportErrorText(err), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="support-panel" onSubmit={send} aria-label="Leave feedback">
      <p className="support-panel__title">
        <BadgeCheck size={18} aria-hidden="true" /> You supported this. Want to leave feedback?
      </p>
      <p className="support-panel__text">
        Optional. Only {r.creator.name} sees it.{config ? ` Written feedback earns +${config.feedbackCredits} credit.` : ""}
      </p>
      <div className="support-reactions" role="group" aria-label="Quick reaction">
        {SUPPORT_REACTIONS.map((x) => (
          <button key={x.id} type="button" className="chip" aria-pressed={reaction === x.id} onClick={() => setReaction(reaction === x.id ? null : x.id)}>
            {x.label}
          </button>
        ))}
      </div>
      <label className="visually-hidden" htmlFor="support-feedback">Feedback</label>
      <textarea
        id="support-feedback"
        className="field__input support-feedback"
        rows={3}
        maxLength={SUPPORT_LIMITS.feedbackMax}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={`What worked? What would you change?`}
      />
      <div className="support-panel__actions">
        <Button type="submit" disabled={busy || (!reaction && !text.trim())} loading={busy}>
          Send feedback
        </Button>
        <Button type="button" variant="ghost" onClick={() => setSkipped(true)}>
          Skip
        </Button>
        <span className="support-panel__count">{text.length}/{SUPPORT_LIMITS.feedbackMax}</span>
      </div>
    </form>
  );
}

function FeedbackList({ r }: { r: SupportRequest }) {
  const viewer = useViewer();
  const [items, setItems] = useState<SupportFeedback[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    dataSource.support!.listFeedback(r.id, viewer.id).then((f) => !cancelled && setItems(f)).catch(() => !cancelled && setItems([]));
    return () => {
      cancelled = true;
    };
  }, [r.id, viewer.id, r.supporterCount]);
  return (
    <section className="support-feedback-list" aria-labelledby="feedback-title">
      <h3 id="feedback-title">
        <MessageSquareText size={17} aria-hidden="true" /> Feedback{items ? ` (${items.length})` : ""}
      </h3>
      {items && items.length === 0 && <p className="support-panel__text">No feedback yet. It'll appear here when supporters leave some.</p>}
      <ul>
        {items?.map((f) => (
          <li key={f.id}>
            <Avatar name={f.author.name} src={f.author.avatarUrl} seed={f.author.id} size="sm" />
            <div>
              <p className="support-fb__meta">
                <strong>{f.author.name}</strong> · {timeAgo(f.createdAt)}
                {f.reaction && <span className="support-tag">{reactionLabel(f.reaction)}</span>}
              </p>
              {f.text && <p className="support-fb__text">{f.text}</p>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ReportLink({ r }: { r: SupportRequest }) {
  const viewer = useViewer();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [done, setDone] = useState(false);
  if (done) return <p className="support-report">Thanks — an Amigo admin will review it.</p>;
  return open ? (
    <form
      className="support-report support-report--open"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await dataSource.support!.report(r.id, viewer.id, reason);
          setDone(true);
        } catch (err) {
          toast(supportErrorText(err), "error");
        }
      }}
    >
      <label htmlFor="report-reason">What's wrong with this request?</label>
      <input id="report-reason" className="field__input" value={reason} maxLength={280} onChange={(e) => setReason(e.target.value)} placeholder="Spam, scam link, inappropriate…" />
      <div className="support-panel__actions">
        <Button type="submit" variant="secondary" size="sm" disabled={!reason.trim()}>
          Send report
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  ) : (
    <p className="support-report">
      <button type="button" onClick={() => setOpen(true)}>
        <Flag size={14} aria-hidden="true" /> Report this request
      </button>
    </p>
  );
}
