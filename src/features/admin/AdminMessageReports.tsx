import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { Lock } from "lucide-react";
import { dataSource, type MessageReport } from "../../data";
import { fullTimestamp, timeAgoLong } from "../../lib/time";
import { useViewer } from "../../state/session";
import { useToast } from "../../state/toast";
import { Button } from "../../ui/Button";
import { supportErrorText } from "../support/useSupport";

const REASON: Record<MessageReport["reason"], string> = {
  spam: "Spam or scam",
  harassment: "Harassment or bullying",
  inappropriate: "Inappropriate content",
  other: "Something else",
};

/**
 * Admin → Reports → Message reports. Messages are end-to-end encrypted, so
 * admins only ever see what the reporter chose to submit — there is no way to
 * open the conversation itself.
 */
export function AdminMessageReports() {
  const api = dataSource.admin?.messageReports;
  const viewer = useViewer();
  const toast = useToast();
  const [reports, setReports] = useState<MessageReport[] | null>(null);
  const [filter, setFilter] = useState<"open" | "reviewed" | "all">("open");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!api) return;
    api.list(viewer.id).then(setReports, (e) => toast(supportErrorText(e), "error"));
  }, [api, viewer.id, toast]);
  useEffect(load, [load]);

  if (!api) return null;
  const shown = (reports ?? []).filter((r) => filter === "all" || r.status === filter);

  async function setStatus(r: MessageReport, status: "open" | "reviewed") {
    setBusy(r.id);
    try {
      await api!.setStatus(viewer.id, r.id, status);
      toast(status === "reviewed" ? "Marked reviewed" : "Reopened");
      load();
    } catch (e) {
      toast(supportErrorText(e), "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="admin-card" aria-labelledby="dm-reports">
      <h2 id="dm-reports" className="admin-card__title">Message reports</h2>
      <p className="admin-muted">
        <Lock size={13} aria-hidden="true" /> Messages are end-to-end encrypted. You see only the messages the reporter chose to submit —
        never the conversation. Amigo can't confirm the submitted text is genuine, so treat it as the reporter's account.
      </p>
      <div className="admin-filter">
        <label>
          Show{" "}
          <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
            <option value="open">Open</option>
            <option value="reviewed">Reviewed</option>
            <option value="all">All</option>
          </select>
        </label>
      </div>
      {!reports ? (
        <p className="admin-muted">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="admin-muted">{filter === "open" ? "No open message reports." : "Nothing here."}</p>
      ) : (
        <ul className="admin-rows dm-reports">
          {shown.map((r) => (
            <li key={r.id} className="admin-row dm-report">
              <div className="admin-row__main">
                <p className="dm-report__head">
                  <strong>{REASON[r.reason]}</strong> — <Link to={`/u/${r.reported.handle}`}>@{r.reported.handle}</Link>, reported by{" "}
                  <Link to={`/u/${r.reporter.handle}`}>@{r.reporter.handle}</Link>
                  <span className="admin-muted"> · <time title={fullTimestamp(r.createdAt)}>{timeAgoLong(r.createdAt)}</time></span>
                </p>
                {r.note && <p className="dm-report__note">“{r.note}”</p>}
                {r.evidence.length ? (
                  <ol className="dm-report__evidence" aria-label="Messages the reporter submitted">
                    {r.evidence.map((m) => (
                      <li key={m.id}>
                        <span className="dm-report__who">{m.fromReported ? `@${r.reported.handle}` : `@${r.reporter.handle}`}</span>
                        <span>{m.text || "(photo)"}</span>
                        {m.createdAt && <span className="admin-muted">{timeAgoLong(m.createdAt)}</span>}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="admin-muted">The reporter didn't include any messages.</p>
                )}
                {r.status === "reviewed" && (
                  <p className="admin-muted">
                    Reviewed{r.reviewedBy ? ` by @${r.reviewedBy}` : ""}
                    {r.reviewedAt ? ` ${timeAgoLong(r.reviewedAt)}` : ""}
                  </p>
                )}
              </div>
              <div className="admin-row__actions">
                {r.status === "open" ? (
                  <Button size="sm" loading={busy === r.id} onClick={() => setStatus(r, "reviewed")}>
                    Mark reviewed
                  </Button>
                ) : (
                  <Button size="sm" variant="secondary" loading={busy === r.id} onClick={() => setStatus(r, "open")}>
                    Reopen
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
