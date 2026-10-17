import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { dataSource, type ContentReport, type Suspension } from "../../data";
import { timeAgo } from "../../lib/time";
import { useViewer } from "../../state/session";
import { useToast } from "../../state/toast";
import { Button } from "../../ui/Button";
import { REPORT_REASONS } from "../reports/reasons";
import { supportErrorText } from "../support/useSupport";

const reasonLabel = (id: string) => REPORT_REASONS.find((r) => r.id === id)?.label ?? id;
const targetHref = (r: ContentReport) =>
  r.targetType === "post" ? `/post/${r.targetId}` : r.targetType === "profile" && r.targetAuthor ? `/u/${r.targetAuthor.handle}` : null;

/** Admin → Reports: posts, replies, profiles and Worlds people reported. */
export function AdminContentReports({ onSuspended }: { onSuspended?: () => void }) {
  const api = dataSource.admin!.moderation!;
  const toast = useToast();
  const [status, setStatus] = useState<"open" | "all">("open");
  const [rows, setRows] = useState<ContentReport[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => void api.listReports(status).then(setRows, (e) => toast(supportErrorText(e), "error")), [api, status, toast]);
  useEffect(load, [load]);

  async function act(id: string, fn: () => Promise<void>, done: string) {
    setBusy(id);
    try {
      await fn();
      toast(done);
      load();
    } catch (e) {
      toast(supportErrorText(e), "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="admin-card" aria-labelledby="content-reports">
      <h2 id="content-reports" className="admin-card__title">Posts, profiles and Worlds</h2>
      <label className="admin-filter">
        Show
        <select value={status} onChange={(e) => setStatus(e.target.value as "open" | "all")}>
          <option value="open">Open</option>
          <option value="all">All</option>
        </select>
      </label>
      {!rows ? (
        <p className="admin-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="admin-muted">No {status === "open" ? "open " : ""}reports.</p>
      ) : (
        <ul className="admin-rows">
          {rows.map((r) => {
            const href = targetHref(r);
            return (
              <li key={r.id} className="admin-row">
                <p>
                  <strong>{r.targetLabel}</strong>
                  {r.targetAuthor && <> by @{r.targetAuthor.handle}</>} · {reasonLabel(r.reason)} · reported by @{r.reporterHandle} {timeAgo(r.createdAt)}
                  {r.reportCount > 1 && <> · {r.reportCount} open reports</>}
                  {r.targetRemoved && <> · removed</>}
                  {r.status === "reviewed" && <> · reviewed</>}
                </p>
                {r.targetText && <blockquote className="admin-quote">{r.targetText}</blockquote>}
                {r.note && <p className="admin-muted">Note: {r.note}</p>}
                <div className="admin-inline">
                  {href && (
                    <Link to={href} className="btn btn--ghost btn--sm">
                      Open
                    </Link>
                  )}
                  {r.targetType === "post" && !r.targetRemoved && (
                    <Button
                      size="sm"
                      variant="danger"
                      loading={busy === r.id + "rm"}
                      onClick={() => {
                        const note = window.prompt("Remove this post for everyone? Add a note for the audit log (optional).", "");
                        if (note === null) return;
                        void act(r.id + "rm", () => api.removePost(r.targetId, note), "Post removed");
                      }}
                    >
                      Remove post
                    </Button>
                  )}
                  {r.targetAuthor && (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={busy === r.id + "su"}
                      onClick={() => {
                        const reason = window.prompt(`Suspend @${r.targetAuthor!.handle}? Reason (shown to them):`, `${reasonLabel(r.reason)} — Community Guidelines`);
                        if (!reason) return;
                        void act(r.id + "su", () => api.suspend(r.targetAuthor!.id, reason, null), `Suspended @${r.targetAuthor!.handle}`).then(onSuspended);
                      }}
                    >
                      Suspend author
                    </Button>
                  )}
                  {r.status === "open" ? (
                    <Button size="sm" variant="ghost" loading={busy === r.id} onClick={() => act(r.id, () => api.setReportStatus(r.id, "reviewed"), "Marked reviewed")}>
                      Dismiss
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" loading={busy === r.id} onClick={() => act(r.id, () => api.setReportStatus(r.id, "open"), "Reopened")}>
                      Reopen
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Admin → Reports: suspended accounts, suspending by @handle, restoring. */
export function AdminSuspensions({ refreshKey = 0 }: { refreshKey?: number }) {
  const api = dataSource.admin!.moderation!;
  const users = dataSource.admin!.users;
  const viewer = useViewer();
  const toast = useToast();
  const [rows, setRows] = useState<Suspension[] | null>(null);
  const [handle, setHandle] = useState("");
  const [reason, setReason] = useState("");
  const [days, setDays] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => void api.listSuspensions().then(setRows, (e) => toast(supportErrorText(e), "error")), [api, toast]);
  useEffect(load, [load, refreshKey]);

  async function suspend(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const found = await users.find(viewer.id, handle.trim().replace(/^@/, ""));
      if (!found) throw new Error("No one with that handle");
      const n = Number(days);
      const until = days && n > 0 ? new Date(Date.now() + n * 86_400_000) : null;
      if (!window.confirm(`Suspend @${found.person.handle}${until ? ` for ${n} day(s)` : " until restored"}?`)) return;
      await api.suspend(found.person.id, reason, until);
      toast(`Suspended @${found.person.handle}`);
      setHandle("");
      setReason("");
      setDays("");
      load();
    } catch (err) {
      toast(err instanceof Error && err.message === "No one with that handle" ? err.message : supportErrorText(err), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="admin-card" aria-labelledby="suspensions">
      <h2 id="suspensions" className="admin-card__title">Suspended accounts</h2>
      <p className="admin-muted">
        A suspended account can still sign in, read, report, block and delete itself, but the database refuses its new posts, replies, likes, follows,
        messages, Moments, Worlds and Support Hub activity. Every change is audit-logged.
      </p>
      <form className="admin-user__form" onSubmit={suspend}>
        <input className="field__input" value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="@handle" aria-label="Handle" />
        <input className="field__input" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="Reason (shown to them)" aria-label="Reason" />
        <input className="field__input" value={days} inputMode="numeric" onChange={(e) => setDays(e.target.value.replace(/\D/g, ""))} placeholder="Days (blank: until restored)" aria-label="Days" />
        <Button type="submit" size="sm" variant="danger" loading={busy} disabled={busy || !handle.trim() || reason.trim().length < 3}>
          Suspend
        </Button>
      </form>
      {!rows ? (
        <p className="admin-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="admin-muted">No suspended accounts.</p>
      ) : (
        <ul className="admin-rows">
          {rows.map((s) => (
            <li key={s.userId} className="admin-row">
              <p>
                <Link to={`/u/${s.handle}`}>
                  <strong>{s.name}</strong> @{s.handle}
                </Link>{" "}
                · {s.until ? `until ${s.until.toLocaleString()}` : "until restored"} · since {timeAgo(s.suspendedAt)}
                {s.suspendedBy && <> by @{s.suspendedBy}</>}
              </p>
              <p className="admin-muted">{s.reason}</p>
              <Button
                size="sm"
                variant="secondary"
                onClick={async () => {
                  const note = window.prompt(`Restore @${s.handle}? Note for the audit log (optional):`, "");
                  if (note === null) return;
                  try {
                    await api.unsuspend(s.userId, note);
                    toast(`Restored @${s.handle}`);
                    load();
                  } catch (e) {
                    toast(supportErrorText(e), "error");
                  }
                }}
              >
                Restore
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
