import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import {
  CREATOR_CATEGORIES,
  dataSource,
  type AdminCreatorApplication,
  type AdminCreatorFeedback,
  type AdminHistoryEntry,
  type CreatorApplicationStatus,
  type CreatorFeedback,
  type CreatorStats,
} from "../../data";
import { timeAgo } from "../../lib/time";
import { useToast } from "../../state/toast";
import { Avatar } from "../../ui/Avatar";
import { Button } from "../../ui/Button";
import { supportErrorText } from "../support/useSupport";

const STATUS_TABS: { id: CreatorApplicationStatus | "all"; label: string }[] = [
  { id: "pending", label: "Pending" },
  { id: "info_requested", label: "Info requested" },
  { id: "approved", label: "Approved" },
  { id: "rejected", label: "Rejected" },
  { id: "all", label: "All" },
];
const STATUS_LABEL: Record<CreatorApplicationStatus, string> = {
  pending: "Pending review",
  info_requested: "More information requested",
  approved: "Approved",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};
const CREATOR_LABEL = { not_eligible: "Not in programme", eligible: "Approved creator", suspended: "Suspended", revoked: "Revoked" } as const;
const categoryLabel = (id: string) => CREATOR_CATEGORIES.find((c) => c.id === id)?.label ?? (id || "—");
const errText = (e: unknown) => (e instanceof Error && (e as { code?: string }).code?.startsWith("SP") ? e.message : supportErrorText(e));

/** Admin → Creator Programme: the review queue. Decisions are checked and audit-logged by the database. */
export function AdminCreatorApplications() {
  const api = dataSource.admin!.creatorProgramme!;
  const toast = useToast();
  const [status, setStatus] = useState<CreatorApplicationStatus | "all">("pending");
  const [query, setQuery] = useState("");
  const [applied, setApplied] = useState("");
  const [rows, setRows] = useState<AdminCreatorApplication[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => {
    setRows(null);
    api.applications(status, applied).then(setRows, (e) => {
      setRows([]);
      toast(errText(e), "error");
    });
  }, [api, status, applied, toast]);
  useEffect(load, [load]);

  return (
    <section className="admin-card" aria-labelledby="cp-apps">
      <h2 id="cp-apps" className="admin-card__title">Creator applications</h2>
      <p className="admin-muted">
        Early access: approving admits a creator to the programme and their dashboard. No payments, earnings or payouts exist. Rejections and requests
        for more information need a short explanation, which the applicant sees.
      </p>
      <div className="admin-tabs-row" role="tablist" aria-label="Application status">
        {STATUS_TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={status === t.id} className={`admin-chip${status === t.id ? " is-on" : ""}`} onClick={() => setStatus(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <form
        className="admin-inline"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(query.trim());
        }}
      >
        <label className="visually-hidden" htmlFor="cp-q">Search applicants</label>
        <input id="cp-q" className="field__input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search @username or name" />
        <Button type="submit" size="sm" variant="secondary">Search</Button>
      </form>
      {!rows ? (
        <p className="admin-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="admin-muted">No applications here.</p>
      ) : (
        <ul className="admin-rows">
          {rows.map((a) => (
            <li key={a.id} className="admin-row">
              <button type="button" className="admin-account" aria-expanded={open === a.id} onClick={() => setOpen(open === a.id ? null : a.id)}>
                <Avatar name={a.person.name} src={a.person.avatarUrl} seed={a.person.id} size="sm" />
                <span className="admin-row__main">
                  <span className="admin-row__title">{a.person.name}</span>
                  <span className="admin-muted">
                    @{a.person.handle} · {categoryLabel(a.category)} · {a.status === "pending" ? "submitted" : "updated"} {timeAgo(a.updatedAt)}
                  </span>
                  <span className="admin-badges">
                    <span className={`admin-badge${a.status === "rejected" ? " admin-badge--danger" : a.status === "approved" ? "" : " admin-badge--muted"}`}>{STATUS_LABEL[a.status]}</span>
                    {a.creatorStatus !== "not_eligible" && a.creatorStatus !== "eligible" && <span className="admin-badge admin-badge--danger">{CREATOR_LABEL[a.creatorStatus]}</span>}
                    {a.current.openFraudFlags > 0 && <span className="admin-badge admin-badge--danger">{a.current.openFraudFlags} open flag(s)</span>}
                  </span>
                </span>
              </button>
              {open === a.id && <ApplicationDetail a={a} onChanged={load} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ApplicationDetail({ a, onChanged }: { a: AdminCreatorApplication; onChanged: () => void }) {
  const api = dataSource.admin!.creatorProgramme!;
  const mon = dataSource.admin!.monetization!;
  const moderation = dataSource.admin!.moderation;
  const toast = useToast();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<AdminHistoryEntry[] | null>(null);
  const [stats, setStats] = useState<CreatorStats | null>(null);

  useEffect(() => {
    if (moderation?.history) void moderation.history(a.person.id).then((h) => setHistory(h.filter((x) => x.action.startsWith("creator.") || x.action.startsWith("monetization."))), () => setHistory([]));
    if (a.creatorStatus === "eligible") void api.stats(a.person.id).then(setStats, () => undefined);
  }, [a.person.id, a.creatorStatus, api, moderation]);

  const act = async (fn: () => Promise<void>, done: string, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    try {
      await fn();
      toast(done);
      setNote("");
      onChanged();
    } catch (e) {
      toast(errText(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const openApp = a.status === "pending" || a.status === "info_requested";
  const e = a.current;

  return (
    <div className="admin-account__detail">
      <p>
        <Link to={`/u/${a.person.handle}`}>View public profile and posts</Link>
        <span className="admin-muted"> · first submitted {a.submittedAt.toLocaleString()}</span>
      </p>
      <dl className="admin-def">
        <dt>Creates</dt>
        <dd>{a.description || "—"}</dd>
        <dt>Why they want to join</dt>
        <dd>{a.reason || "—"}</dd>
        {a.links.length > 0 && (
          <>
            <dt>Links</dt>
            <dd>
              {a.links.map((l) => (
                <a key={l} href={l} target="_blank" rel="noopener noreferrer nofollow" className="admin-link-break">
                  {l}
                </a>
              ))}
            </dd>
          </>
        )}
        {a.extra && (
          <>
            <dt>Additional information</dt>
            <dd>{a.extra}</dd>
          </>
        )}
        {a.status === "info_requested" && (
          <>
            <dt>Information requested</dt>
            <dd>{a.infoRequest}</dd>
          </>
        )}
        {(a.status === "approved" || a.status === "rejected") && (
          <>
            <dt>Decision</dt>
            <dd>
              {STATUS_LABEL[a.status]}
              {a.reviewedBy && ` by @${a.reviewedBy}`}
              {a.reviewedAt && ` · ${a.reviewedAt.toLocaleString()}`}
              {a.reviewNote && ` — ${a.reviewNote}`}
            </dd>
          </>
        )}
      </dl>
      <dl className="admin-stats admin-stats--compact">
        {(
          [
            ["Followers", e.followers],
            ["Verified followers", e.verifiedFollowers],
            ["Posts, 30 days", e.posts30d],
            ["Support received", e.supportReceived],
            ["Account age (days)", e.accountAgeDays],
            ["Open fraud flags", e.openFraudFlags],
          ] as [string, number][]
        ).map(([label, n]) => (
          <div key={label} className="admin-stats__item">
            <dt>{label}</dt>
            <dd>{n.toLocaleString()}</dd>
          </div>
        ))}
      </dl>
      {stats && (
        <p className="admin-muted">
          Dashboard: {stats.posts} posts · {stats.likesReceived} likes received · {stats.repliesReceived} replies received
        </p>
      )}

      {openApp && (
        <div className="admin-user__form">
          <label className="visually-hidden" htmlFor={`cp-note-${a.id}`}>Note to the applicant</label>
          <textarea id={`cp-note-${a.id}`} className="field__input admin-textarea" rows={2} maxLength={500} value={note} onChange={(ev) => setNote(ev.target.value)} placeholder="Note to the applicant (required to reject or ask for more)" />
          <div className="admin-inline">
            <Button size="sm" disabled={busy} onClick={() => void act(() => api.decide(a.id, "approved", note), `Approved @${a.person.handle}`, `Approve @${a.person.handle} for the Creator Programme? (No payments are enabled.)`)}>
              Approve
            </Button>
            <Button size="sm" variant="secondary" disabled={busy || note.trim().length < 3} onClick={() => void act(() => api.decide(a.id, "info_requested", note), "Asked for more information")}>
              Request info
            </Button>
            <Button size="sm" variant="danger" disabled={busy || note.trim().length < 3} onClick={() => void act(() => api.decide(a.id, "rejected", note), "Rejected", `Reject @${a.person.handle}'s application? They'll see your note.`)}>
              Reject
            </Button>
          </div>
        </div>
      )}

      {!openApp && a.status === "approved" && (
        <div className="admin-user__form">
          <label className="visually-hidden" htmlFor={`cp-reason-${a.id}`}>Reason</label>
          <input id={`cp-reason-${a.id}`} className="field__input" maxLength={500} value={note} onChange={(ev) => setNote(ev.target.value)} placeholder="Reason (shown to the creator, audited)" />
          <div className="admin-inline">
            {a.creatorStatus === "eligible" ? (
              <>
                <Button size="sm" variant="secondary" disabled={busy || note.trim().length < 3} onClick={() => void act(() => mon.setStatus(a.person.id, "suspended", note), "Creator suspended", `Suspend @${a.person.handle}'s creator access?`)}>
                  Suspend
                </Button>
                <Button size="sm" variant="danger" disabled={busy || note.trim().length < 3} onClick={() => void act(() => mon.setStatus(a.person.id, "revoked", note), "Approval revoked", `Revoke @${a.person.handle}'s approval? They won't be able to reapply.`)}>
                  Revoke
                </Button>
              </>
            ) : (
              <Button size="sm" variant="secondary" disabled={busy || note.trim().length < 3} onClick={() => void act(() => mon.setStatus(a.person.id, "eligible", note), "Creator access restored", `Restore @${a.person.handle}'s creator access?`)}>
                Restore access
              </Button>
            )}
          </div>
        </div>
      )}

      {history && history.length > 0 && (
        <div>
          <h3 className="admin-subtitle">Previous decisions</h3>
          <ul className="admin-rows">
            {history.map((h) => (
              <li key={h.id} className="admin-muted">
                {timeAgo(h.at)} · @{h.admin ?? "unknown"} · {h.summary}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ feedback

const FB_TABS: { id: CreatorFeedback["status"] | "all"; label: string }[] = [
  { id: "open", label: "New" },
  { id: "reviewed", label: "Reviewed" },
  { id: "resolved", label: "Resolved" },
  { id: "all", label: "All" },
];
const FB_CATEGORY: Record<CreatorFeedback["category"], string> = {
  programme: "The programme",
  features: "Features & ideas",
  bug: "Something's broken",
  support: "Needs help",
  other: "Other",
};

/** Admin → Creator Feedback: private feedback from creators; respond and track status. */
export function AdminCreatorFeedback() {
  const api = dataSource.admin!.creatorProgramme!;
  const toast = useToast();
  const [status, setStatus] = useState<CreatorFeedback["status"] | "all">("open");
  const [rows, setRows] = useState<AdminCreatorFeedback[] | null>(null);

  const load = useCallback(() => {
    setRows(null);
    api.feedback(status).then(setRows, (e) => {
      setRows([]);
      toast(errText(e), "error");
    });
  }, [api, status, toast]);
  useEffect(load, [load]);

  return (
    <section className="admin-card" aria-labelledby="cp-fb">
      <h2 id="cp-fb" className="admin-card__title">Creator feedback</h2>
      <p className="admin-muted">Private between each creator and admins. Never published.</p>
      <div className="admin-tabs-row" role="tablist" aria-label="Feedback status">
        {FB_TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={status === t.id} className={`admin-chip${status === t.id ? " is-on" : ""}`} onClick={() => setStatus(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {!rows ? (
        <p className="admin-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="admin-muted">Nothing here.</p>
      ) : (
        <ul className="admin-rows">
          {rows.map((f) => (
            <FeedbackRow key={f.id} f={f} onChanged={load} />
          ))}
        </ul>
      )}
    </section>
  );
}

function FeedbackRow({ f, onChanged }: { f: AdminCreatorFeedback; onChanged: () => void }) {
  const api = dataSource.admin!.creatorProgramme!;
  const toast = useToast();
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async (e: FormEvent | null, next: CreatorFeedback["status"]) => {
    e?.preventDefault();
    setBusy(true);
    try {
      await api.updateFeedback(f.id, next, reply);
      toast(reply.trim() ? "Response sent" : `Marked ${next}`);
      setReply("");
      onChanged();
    } catch (err) {
      toast(errText(err), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="admin-row admin-feedback">
      <div className="admin-row--person">
        <Avatar name={f.person.name} src={f.person.avatarUrl} seed={f.person.id} size="sm" />
        <div className="admin-row__main">
          <Link to={`/u/${f.person.handle}`} className="admin-row__title">{f.person.name}</Link>
          <span className="admin-muted">
            @{f.person.handle} · {FB_CATEGORY[f.category]} · {f.rating ? `${f.rating}/5 · ` : ""}
            {timeAgo(f.createdAt)} · {f.status}
          </span>
        </div>
      </div>
      <p className="admin-feedback__body">{f.body}</p>
      {f.adminResponse && (
        <p className="admin-feedback__reply">
          <strong>Response{f.respondedBy && ` by @${f.respondedBy}`}</strong>
          {f.respondedAt && <span className="admin-muted"> · {timeAgo(f.respondedAt)}</span>}
          <br />
          {f.adminResponse}
        </p>
      )}
      <form className="admin-user__form" onSubmit={(e) => void save(e, "reviewed")}>
        <label className="visually-hidden" htmlFor={`fb-${f.id}`}>Response to the creator</label>
        <textarea id={`fb-${f.id}`} className="field__input admin-textarea" rows={2} maxLength={2000} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Write a response (the creator sees it)" />
        <div className="admin-inline">
          <Button type="submit" size="sm" disabled={busy || !reply.trim()}>Send response</Button>
          {f.status !== "reviewed" && (
            <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void save(null, "reviewed")}>
              Mark reviewed
            </Button>
          )}
          {f.status !== "resolved" && (
            <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void save(null, "resolved")}>
              Resolve
            </Button>
          )}
        </div>
      </form>
    </li>
  );
}
