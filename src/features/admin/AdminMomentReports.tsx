import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { dataSource, type MomentReport } from "../../data";
import { timeAgoLong } from "../../lib/time";
import { useViewer } from "../../state/session";
import { useToast } from "../../state/toast";
import { Button } from "../../ui/Button";
import { MomentVisual } from "../moments/MomentVisual";
import { reportReasonLabel } from "../reports/reasons";
import { supportErrorText } from "../support/useSupport";
import "../moments/Moments.css";

/**
 * Admin → Reports → Reported Moments. Admins see the reported Moment (which
 * was shared with an audience anyway) and can take it down. Replies to
 * Moments are Messages and are never shown here.
 */
export function AdminMomentReports() {
  const api = dataSource.admin?.moments;
  const viewer = useViewer();
  const toast = useToast();
  const [reports, setReports] = useState<MomentReport[] | null>(null);
  const [filter, setFilter] = useState<"open" | "reviewed" | "all">("open");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!api) return;
    api.listReports(viewer.id).then(setReports, (e) => toast(supportErrorText(e), "error"));
  }, [api, viewer.id, toast]);
  useEffect(load, [load]);

  if (!api) return null;
  const shown = (reports ?? []).filter((r) => filter === "all" || r.status === filter);

  async function run(id: string, fn: () => Promise<void>, ok: string) {
    setBusy(id);
    try {
      await fn();
      toast(ok);
      load();
    } catch (e) {
      toast(supportErrorText(e), "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="admin-card" aria-labelledby="moment-reports">
      <h2 id="moment-reports" className="admin-card__title">Reported Moments</h2>
      <p className="admin-muted">Removing a Moment takes it down for everyone and is recorded in the audit log. Replies to Moments are private messages and aren't visible here.</p>
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
        <p className="admin-muted">{filter === "open" ? "No reported Moments." : "Nothing here."}</p>
      ) : (
        <ul className="admin-rows">
          {shown.map((r) => (
            <li key={r.id} className="admin-row moment-report">
              <div className="moment-report__thumb">
                {r.moment ? (
                  <MomentVisual text={r.moment.text} background={r.moment.background} media={r.moment.media} size="thumb" />
                ) : (
                  <MomentVisual text="Expired" background="plain" media={null} size="thumb" />
                )}
              </div>
              <div className="admin-row__main">
                <p>
                  <strong>{reportReasonLabel(r.reason)}</strong>
                  {r.moment && (
                    <>
                      {" "}— Moment by <Link to={`/u/${r.moment.author.handle}`}>@{r.moment.author.handle}</Link>
                    </>
                  )}
                  , reported by <Link to={`/u/${r.reporter.handle}`}>@{r.reporter.handle}</Link>
                  <span className="admin-muted"> · {timeAgoLong(r.createdAt)}</span>
                </p>
                {r.note && <p className="admin-muted">“{r.note}”</p>}
                {!r.moment && <p className="admin-muted">This Moment has expired or was deleted by its author.</p>}
                {r.moment?.removed && <p className="admin-muted">Removed by an admin.</p>}
                {r.moment && !r.moment.removed && r.status === "open" && (
                  <label className="field">
                    <span className="field__label">Reason for removing (optional, for the audit log)</span>
                    <input
                      className="field__input"
                      value={notes[r.id] ?? ""}
                      maxLength={200}
                      onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))}
                    />
                  </label>
                )}
              </div>
              <div className="admin-row__actions">
                {r.moment && !r.moment.removed && (
                  <Button size="sm" variant="danger" loading={busy === r.id} onClick={() => run(r.id, () => api.remove(viewer.id, r.moment!.id, notes[r.id] ?? ""), "Moment removed")}>
                    Remove Moment
                  </Button>
                )}
                {r.status === "open" ? (
                  <Button size="sm" variant="secondary" disabled={busy === r.id} onClick={() => run(r.id, () => api.setReportStatus(viewer.id, r.id, "reviewed"), "Report dismissed")}>
                    Dismiss
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" disabled={busy === r.id} onClick={() => run(r.id, () => api.setReportStatus(viewer.id, r.id, "open"), "Reopened")}>
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
