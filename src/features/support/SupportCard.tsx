import { Link } from "react-router";
import { BadgeCheck, ExternalLink, Sparkles } from "lucide-react";
import type { SupportRequest } from "../../data";
import { timeAgo, timeAgoLong } from "../../lib/time";
import { askOf, categoryLabel, hostOf } from "../../data/supportRules";
import { Avatar } from "../../ui/Avatar";

const STATUS_LABEL: Record<SupportRequest["status"], string> = {
  pending: "Waiting for review",
  active: "Open",
  completed: "Completed",
  closed: "Closed",
  rejected: "Not approved",
  removed: "Removed",
};

export function statusLabel(r: SupportRequest) {
  return STATUS_LABEL[r.status];
}

export function Progress({ r }: { r: SupportRequest }) {
  const pct = Math.min(100, Math.round((r.supporterCount / r.target) * 100));
  return (
    <span className="support-progress">
      <span className="support-progress__bar" role="progressbar" aria-valuemin={0} aria-valuemax={r.target} aria-valuenow={Math.min(r.supporterCount, r.target)} aria-label="Support progress">
        <span style={{ width: `${pct}%` }} />
      </span>
      <span className="support-progress__text">
        <strong>{r.supporterCount}</strong> of {r.target} supporters
      </span>
    </span>
  );
}

/** One request in a list. The whole card opens the request; Support happens on its page. */
export function SupportCard({ r }: { r: SupportRequest }) {
  const ask = askOf(r.ask);
  return (
    <li className={`support-card${r.featured ? " is-featured" : ""}`}>
      <Link to={`/support/${r.id}`} className="support-card__link">
        <span className="support-card__top">
          <Avatar name={r.creator.name} src={r.creator.avatarUrl} seed={r.creator.id} size="sm" />
          <span className="support-card__who">
            <span className="support-card__name">{r.creator.name}</span>
            <span className="support-card__meta">
              {categoryLabel(r.category)} · <time dateTime={r.createdAt.toISOString()} aria-label={timeAgoLong(r.createdAt)}>{timeAgo(r.createdAt)}</time>
            </span>
          </span>
          {r.featured && (
            <span className="support-tag support-tag--featured">
              <Sparkles size={13} aria-hidden="true" /> Featured
            </span>
          )}
          {r.status !== "active" && <span className={`support-tag support-tag--${r.status}`}>{statusLabel(r)}</span>}
        </span>
        <span className="support-card__title">{r.title}</span>
        <span className="support-card__desc">{r.description}</span>
        <span className="support-card__ask">
          <ExternalLink size={14} aria-hidden="true" />
          {ask.verb} on {hostOf(r.url)}
        </span>
        <span className="support-card__foot">
          <Progress r={r} />
          {r.viewerState === "supported" && (
            <span className="support-card__done">
              <BadgeCheck size={15} aria-hidden="true" /> You supported
            </span>
          )}
          {r.isViewer && <span className="support-card__done">Your request</span>}
        </span>
      </Link>
    </li>
  );
}
