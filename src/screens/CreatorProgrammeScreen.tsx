import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowLeft, BadgeCheck, CircleAlert, Clock, MessageSquareText, Sparkles, Star } from "lucide-react";
import {
  CREATOR_CATEGORIES,
  dataSource,
  type CreatorApplicationInput,
  type CreatorFeedback,
  type CreatorFeedbackCategory,
  type CreatorProgramme,
  type CreatorStats,
} from "../data";
import { timeAgo } from "../lib/time";
import { ScreenHeader } from "../shell/ScreenHeader";
import { useToast } from "../state/toast";
import { Button, IconButton } from "../ui/Button";
import { Skeleton } from "../ui/Skeleton";
import { StateMessage } from "../ui/StateMessage";
import "./SettingsScreen.css";
import "./CreatorProgrammeScreen.css";

/** Server messages for refused input (CP…/MN… codes) are written for people; anything else gets a generic line. */
const errorText = (e: unknown, fallback: string) => {
  const err = e as { code?: string; message?: string } | null;
  return err?.code && /^(CP|MN)\d+/.test(err.code) && err.message ? err.message.charAt(0).toUpperCase() + err.message.slice(1) + "." : fallback;
};

const EMPTY: CreatorApplicationInput = { category: "music", description: "", reason: "", links: [""], extra: "" };
const MAX = 600;

/**
 * Settings → Creator Monetization: the Creator Programme (early access).
 * Apply, follow the review, see a dashboard of real engagement once approved,
 * and send private feedback. Nothing financial: no earnings, balances or payouts.
 */
export default function CreatorProgrammeScreen() {
  const navigate = useNavigate();
  const api = dataSource.creatorProgramme;
  const [p, setP] = useState<CreatorProgramme | "error" | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);

  const reload = useCallback(() => {
    if (!api) return;
    void api.get().then(setP, () => setP("error"));
  }, [api]);
  useEffect(() => {
    setP(undefined);
    reload();
  }, [reload, attempt]);

  const header = (
    <ScreenHeader
      title="Creator Monetization"
      leading={
        <IconButton label="Back" onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate("/settings"))} className="back-btn">
          <ArrowLeft size={22} />
        </IconButton>
      }
    />
  );

  if (!api) {
    return (
      <>
        {header}
        <StateMessage icon={<Sparkles size={24} />} title="The Creator Programme isn't available here." />
      </>
    );
  }
  if (p === undefined) {
    return (
      <>
        {header}
        <div className="settings" aria-busy="true">
          <Skeleton width="70%" height={22} />
          <Skeleton width="100%" height={140} />
        </div>
      </>
    );
  }
  if (p === "error") {
    return (
      <>
        {header}
        <StateMessage
          tone="error"
          icon={<CircleAlert size={24} />}
          title="Couldn't load the Creator Programme"
          body="Check your connection and try again."
          action={
            <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          }
        />
      </>
    );
  }

  const app = p.application;
  const approved = p.creatorStatus === "eligible";
  const blocked = p.creatorStatus === "suspended" || p.creatorStatus === "revoked" || p.accountSuspended;
  const canApply = !approved && !blocked && p.applicationsOpen && (!app || app.status === "rejected" || app.status === "withdrawn") && p.applicationsThisMonth < 3;
  const canSendFeedback = approved || (!!app && app.status !== "withdrawn");

  return (
    <>
      {header}
      <div className="settings creator">
        <div className="creator-hero">
          <span className="creator-hero__icon" aria-hidden="true">
            <Sparkles size={22} />
          </span>
          <div>
            <h2 className="creator-hero__title">Creator Monetization</h2>
            <p className="creator-hero__lead">
              {approved
                ? "Your Creator Programme home: your status, your numbers and a direct line to the Amigo team."
                : "Your creativity deserves opportunities. Apply to join the Amigo World Creator Programme."}
            </p>
          </div>
        </div>
        <p className="creator-notice">
          The programme is currently in early access. Approval does not guarantee earnings, and payments are not available yet.
        </p>

        <StatusCard p={p} />

        {approved && p.stats && <Dashboard stats={p.stats} />}

        {app?.status === "info_requested" && (
          <ApplicationForm
            title="Update your application"
            initial={app}
            submitLabel="Send update"
            onSubmit={async (input) => {
              await api.update(app.id, input);
              reload();
            }}
          />
        )}

        {canApply && (
          <ApplicationForm
            title={app ? "Apply again" : "Apply to the Creator Programme"}
            initial={EMPTY}
            submitLabel="Submit application"
            onSubmit={async (input) => {
              await api.apply(input);
              reload();
            }}
          />
        )}

        {!approved && !blocked && !p.applicationsOpen && (!app || app.status === "rejected" || app.status === "withdrawn") && (
          <section className="settings-section">
            <div className="settings-card creator-pad">
              <p className="creator-muted">
                Applications aren't open right now. {p.publicNote || "Check back here — this page will let you apply when they open."}
              </p>
            </div>
          </section>
        )}
        {!approved && !blocked && p.applicationsOpen && p.applicationsThisMonth >= 3 && (!app || app.status === "rejected" || app.status === "withdrawn") && (
          <p className="creator-muted">You've applied three times in the last 30 days. You can apply again later.</p>
        )}

        {app && (app.status === "pending" || app.status === "info_requested") && (
          <WithdrawButton onWithdraw={async () => {
            await api.withdraw(app.id);
            reload();
          }} />
        )}

        {canSendFeedback && <FeedbackPanel />}

        <p className="settings-panel__text">
          Read the <Link to="/legal/monetization">Monetization Programme Terms</Link> (draft).
        </p>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ status

function StatusCard({ p }: { p: CreatorProgramme }) {
  const app = p.application;
  let icon = <Sparkles size={20} />;
  let title = "Not applied";
  let body = "You haven't applied to the Creator Programme.";
  let tone = "neutral";
  if (p.creatorStatus === "eligible") {
    icon = <BadgeCheck size={20} />;
    title = "Creator Programme — Approved";
    body = "You're approved for the Amigo World Creator Programme. Monetization payments are not active yet.";
    tone = "ok";
  } else if (p.creatorStatus === "suspended") {
    icon = <CircleAlert size={20} />;
    title = "Creator access suspended";
    body = p.creatorReason ? `Reason: ${p.creatorReason}` : "Your Creator Programme access is suspended.";
    tone = "warn";
  } else if (p.creatorStatus === "revoked") {
    icon = <CircleAlert size={20} />;
    title = "Creator approval revoked";
    body = p.creatorReason ? `Reason: ${p.creatorReason}` : "Your Creator Programme approval was withdrawn.";
    tone = "warn";
  } else if (p.accountSuspended) {
    icon = <CircleAlert size={20} />;
    title = "Account suspended";
    body = "You can't apply while your account is suspended.";
    tone = "warn";
  } else if (app?.status === "pending") {
    icon = <Clock size={20} />;
    title = "Pending review";
    body = `Submitted ${timeAgo(app.updatedAt)}. The Amigo team reviews every application by hand.`;
  } else if (app?.status === "info_requested") {
    icon = <MessageSquareText size={20} />;
    title = "More information requested";
    body = app.infoRequest;
    tone = "warn";
  } else if (app?.status === "rejected") {
    icon = <CircleAlert size={20} />;
    title = "Not approved";
    body = app.reviewNote ? `Reviewer's note: ${app.reviewNote}` : "Your last application wasn't approved.";
  } else if (app?.status === "withdrawn") {
    title = "Application withdrawn";
    body = "You withdrew your application.";
  }
  return (
    <section className="settings-section" aria-labelledby="creator-status">
      <h3 id="creator-status" className="settings-section__title">Your status</h3>
      <div className={`creator-status creator-status--${tone}`}>
        <span className="creator-status__icon" aria-hidden="true">{icon}</span>
        <div>
          <p className="creator-status__title">{title}</p>
          <p className="creator-status__body">{body}</p>
        </div>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ application form

function ApplicationForm({
  title,
  initial,
  submitLabel,
  onSubmit,
}: {
  title: string;
  initial: CreatorApplicationInput;
  submitLabel: string;
  onSubmit: (input: CreatorApplicationInput) => Promise<void>;
}) {
  const toast = useToast();
  const [f, setF] = useState<CreatorApplicationInput>({ ...initial, links: initial.links.length ? initial.links : [""] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof CreatorApplicationInput>(k: K, v: CreatorApplicationInput[K]) => setF((x) => ({ ...x, [k]: v }));
  const tooShort = f.description.trim().length < 20 || f.reason.trim().length < 20;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(f);
      toast("Application sent for review");
    } catch (err) {
      setError(errorText(err, "Couldn't send your application. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section" aria-labelledby="creator-apply">
      <h3 id="creator-apply" className="settings-section__title">{title}</h3>
      <form className="settings-card creator-form" onSubmit={submit} noValidate>
        <p className="creator-muted">Your name, username, profile and posts are taken from your account — no need to repeat them.</p>
        <label className="creator-field">
          <span>Creator category</span>
          <select className="field__input" value={f.category} onChange={(e) => set("category", e.target.value as CreatorApplicationInput["category"])}>
            {CREATOR_CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        </label>
        <TextArea label="What do you create?" hint="A short description of your content" value={f.description} onChange={(v) => set("description", v)} />
        <TextArea label="Why do you want to join?" value={f.reason} onChange={(v) => set("reason", v)} />
        <fieldset className="creator-field">
          <legend>Links to your work (optional)</legend>
          {f.links.map((l, i) => (
            <input
              key={i}
              className="field__input"
              type="url"
              inputMode="url"
              placeholder="https://"
              value={l}
              maxLength={300}
              aria-label={`Link ${i + 1}`}
              onChange={(e) => set("links", f.links.map((x, j) => (j === i ? e.target.value : x)))}
            />
          ))}
          {f.links.length < 5 && (
            <Button type="button" size="sm" variant="ghost" onClick={() => set("links", [...f.links, ""])}>
              Add another link
            </Button>
          )}
        </fieldset>
        <TextArea label="Anything else? (optional)" value={f.extra} onChange={(v) => set("extra", v)} min={0} />
        {error && (
          <p className="creator-error" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" loading={busy} disabled={busy || tooShort}>
          {submitLabel}
        </Button>
        {tooShort && <p className="creator-muted">Write at least 20 characters for both answers.</p>}
      </form>
    </section>
  );
}

function TextArea({ label, hint, value, onChange, min = 20 }: { label: string; hint?: string; value: string; onChange: (v: string) => void; min?: number }) {
  const left = MAX - value.length;
  return (
    <label className="creator-field">
      <span>
        {label}
        {hint && <small className="creator-muted"> · {hint}</small>}
      </span>
      <textarea className="field__input creator-textarea" rows={3} maxLength={MAX} value={value} onChange={(e) => onChange(e.target.value)} />
      <small className={`creator-count${left < 40 ? " is-low" : ""}`} aria-live="polite">
        {min > 0 && value.trim().length < min ? `${min - value.trim().length} more characters needed` : `${left} characters left`}
      </small>
    </label>
  );
}

function WithdrawButton({ onWithdraw }: { onWithdraw: () => Promise<void> }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="ghost"
      loading={busy}
      disabled={busy}
      onClick={async () => {
        if (!window.confirm("Withdraw your application? You can apply again later.")) return;
        setBusy(true);
        try {
          await onWithdraw();
          toast("Application withdrawn");
        } catch (e) {
          toast(errorText(e, "Couldn't withdraw. Try again."), "error");
        } finally {
          setBusy(false);
        }
      }}
    >
      Withdraw application
    </Button>
  );
}

// ------------------------------------------------------------------ dashboard

function Dashboard({ stats }: { stats: CreatorStats }) {
  const tiles: [string, number][] = [
    ["Posts", stats.posts],
    ["Likes received", stats.likesReceived],
    ["Replies received", stats.repliesReceived],
    ["Followers", stats.followers],
    ["Followers with verified email", stats.verifiedFollowers],
  ];
  return (
    <section className="settings-section" aria-labelledby="creator-dash">
      <h3 id="creator-dash" className="settings-section__title">Your dashboard</h3>
      <dl className="creator-tiles">
        {tiles.map(([label, n]) => (
          <div key={label} className="creator-tile">
            <dt>{label}</dt>
            <dd>{n.toLocaleString()}</dd>
          </div>
        ))}
      </dl>
      <div className="settings-card creator-pad">
        <div className="creator-charts">
          <WeekBars title="Likes received" weeks={stats.weekly} pick={(w) => w.likes} />
          <WeekBars title="Replies received" weeks={stats.weekly} pick={(w) => w.replies} />
          <WeekBars title="Posts" weeks={stats.weekly} pick={(w) => w.posts} />
        </div>
      </div>
      {stats.recentPosts.length > 0 && (
        <div className="settings-card">
          <h4 className="creator-subtitle">Recent posts</h4>
          <ul className="creator-posts">
            {stats.recentPosts.map((post) => (
              <li key={post.id}>
                <Link to={`/post/${post.id}`} className="creator-post">
                  <span className="creator-post__body">{post.body || "Photo post"}</span>
                  <span className="creator-muted">
                    {post.likes} {post.likes === 1 ? "like" : "likes"} · {post.replies} {post.replies === 1 ? "reply" : "replies"} · {timeAgo(post.createdAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="settings-panel__text">
        Counts come straight from Amigo: your posts (not replies), likes and replies others gave them, and your followers. Weekly charts cover the last 8
        weeks. Views and reach aren't tracked, so they aren't shown.
      </p>
    </section>
  );
}

function WeekBars({ title, weeks, pick }: { title: string; weeks: CreatorStats["weekly"]; pick: (w: CreatorStats["weekly"][number]) => number }) {
  const values = weeks.map(pick);
  const max = Math.max(1, ...values);
  const total = values.reduce((a, b) => a + b, 0);
  const label = (w: string) => new Date(`${w}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  return (
    <figure className="creator-chart">
      <figcaption>
        <span>{title}</span>
        <strong>{values.at(-1) ?? 0}</strong> <span className="creator-muted">this week</span>
      </figcaption>
      <div className="creator-chart__bars" role="list" aria-label={`${title}, last 8 weeks, ${total} in total`}>
        {weeks.map((w, i) => (
          <div key={w.week} role="listitem" className="creator-chart__slot" title={`Week of ${label(w.week)}: ${values[i]}`} aria-label={`Week of ${label(w.week)}: ${values[i]}`}>
            <span className="creator-chart__bar" style={{ height: values[i] ? `${Math.max(6, (values[i] / max) * 100)}%` : 0 }} />
          </div>
        ))}
      </div>
    </figure>
  );
}

// ------------------------------------------------------------------ feedback

const FEEDBACK_CATEGORIES: { id: CreatorFeedbackCategory; label: string }[] = [
  { id: "programme", label: "The programme" },
  { id: "features", label: "Features & ideas" },
  { id: "bug", label: "Something's broken" },
  { id: "support", label: "I need help" },
  { id: "other", label: "Other" },
];
const STATUS_LABEL: Record<CreatorFeedback["status"], string> = { open: "Sent", reviewed: "Read by the team", resolved: "Resolved" };

function FeedbackPanel() {
  const api = dataSource.creatorProgramme!;
  const toast = useToast();
  const [items, setItems] = useState<CreatorFeedback[] | null>(null);
  const [category, setCategory] = useState<CreatorFeedbackCategory>("programme");
  const [rating, setRating] = useState<number | null>(null);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => void api.feedback().then(setItems, () => setItems([])), [api]);
  useEffect(load, [load]);

  async function send(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await api.sendFeedback({ category, rating, body: body.trim() });
      toast("Feedback sent — thank you");
      setBody("");
      setRating(null);
      load();
    } catch (err) {
      toast(errorText(err, "Couldn't send your feedback. Try again."), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section" aria-labelledby="creator-feedback">
      <h3 id="creator-feedback" className="settings-section__title">Feedback</h3>
      <form className="settings-card creator-form" onSubmit={send}>
        <p className="creator-muted">Tell us how the programme is going. Only you and the Amigo team can read this; it's never published.</p>
        <label className="creator-field">
          <span>About</span>
          <select className="field__input" value={category} onChange={(e) => setCategory(e.target.value as CreatorFeedbackCategory)}>
            {FEEDBACK_CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        </label>
        <div className="creator-field">
          <span id="creator-rating">Rating (optional)</span>
          <div className="creator-stars" role="radiogroup" aria-labelledby="creator-rating">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={rating === n}
                aria-label={`${n} star${n === 1 ? "" : "s"}`}
                className={`creator-star${rating !== null && n <= rating ? " is-on" : ""}`}
                onClick={() => setRating(rating === n ? null : n)}
              >
                <Star size={22} aria-hidden="true" />
              </button>
            ))}
          </div>
        </div>
        <label className="creator-field">
          <span>Your feedback</span>
          <textarea className="field__input creator-textarea" rows={4} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} />
          <small className="creator-count">{body.trim().length < 10 ? `${10 - body.trim().length} more characters needed` : `${2000 - body.length} characters left`}</small>
        </label>
        <Button type="submit" loading={busy} disabled={busy || body.trim().length < 10}>
          Send feedback
        </Button>
      </form>
      {items && items.length > 0 && (
        <ul className="settings-card creator-feedback-list">
          {items.map((f) => (
            <li key={f.id} className="creator-feedback">
              <p className="creator-muted">
                {FEEDBACK_CATEGORIES.find((c) => c.id === f.category)?.label} · {f.rating ? `${f.rating}/5 · ` : ""}
                {timeAgo(f.createdAt)} · <strong>{STATUS_LABEL[f.status]}</strong>
              </p>
              <p className="creator-feedback__body">{f.body}</p>
              {f.adminResponse && (
                <p className="creator-feedback__reply">
                  <strong>Amigo team</strong>
                  {f.respondedAt && <span className="creator-muted"> · {timeAgo(f.respondedAt)}</span>}
                  <br />
                  {f.adminResponse}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
