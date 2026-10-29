import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { type AdminBusiness } from "../../data";
import { timeAgoLong } from "../../lib/time";
import { useToast } from "../../state/toast";
import { Button } from "../../ui/Button";
import { businessApi } from "../business/useMyBusiness";
import { businessErrorText, categoryLabel } from "../business/shared";

/**
 * Admin → Businesses: the on/off switch for business pages, and suspend/restore. Admins see who
 * runs each page (nobody else can); every change here is recorded in the audit log.
 */
export function AdminBusinesses() {
  const toast = useToast();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [rows, setRows] = useState<AdminBusiness[] | null>(null);
  const [filter, setFilter] = useState<"all" | "active" | "suspended">("all");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!businessApi) return;
    businessApi.mine().then((m) => setEnabled(m.enabled), () => undefined);
    businessApi.admin.list(filter).then(setRows, (e) => toast(businessErrorText(e), "error"));
  }, [filter, toast]);
  useEffect(load, [load]);

  if (!businessApi) return null;
  const api = businessApi;

  async function run(id: string, fn: () => Promise<void>, ok: string) {
    setBusy(id);
    try {
      await fn();
      toast(ok);
      load();
    } catch (e) {
      toast(businessErrorText(e), "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <section className="admin-card" aria-labelledby="biz-switch">
        <h2 id="biz-switch" className="admin-card__title">Business pages</h2>
        <p className="admin-muted">
          {enabled === null ? "Loading…" : enabled ? "On: verified members can create a business page." : "Off: nobody can create a business page. Existing pages stay as they are."}
        </p>
        {enabled !== null && (
          <div className="admin-row__actions">
            <Button
              size="sm"
              variant={enabled ? "secondary" : "primary"}
              loading={busy === "switch"}
              onClick={() => run("switch", () => api.admin.setEnabled(!enabled), enabled ? "Business pages turned off" : "Business pages turned on")}
            >
              {enabled ? "Turn off" : "Turn on"}
            </Button>
          </div>
        )}
      </section>

      <section className="admin-card" aria-labelledby="biz-list">
        <h2 id="biz-list" className="admin-card__title">Businesses</h2>
        <p className="admin-muted">Suspending hides the page and its posts from everyone and stops the owner editing, posting or deleting it.</p>
        <div className="admin-filter">
          <label>
            Show{" "}
            <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
              <option value="all">All</option>
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
            </select>
          </label>
        </div>
        {!rows ? (
          <p className="admin-muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="admin-muted">No businesses.</p>
        ) : (
          <ul className="admin-rows">
            {rows.map((b) => (
              <li key={b.id} className="admin-row">
                <div className="admin-row__main">
                  <p>
                    <Link to={`/b/${b.handle}`} className="admin-row__title">{b.name}</Link> <span className="admin-muted">/b/{b.handle}</span>
                    {b.status === "suspended" && <span className="admin-badge admin-badge--danger">Suspended</span>}
                  </p>
                  <p className="admin-muted">
                    {categoryLabel(b.category)} · {b.followerCount} followers · {b.postCount} posts · run by <Link to={`/u/${b.ownerHandle}`}>@{b.ownerHandle}</Link> · created {timeAgoLong(b.createdAt)}
                  </p>
                  {b.suspendedNote && <p className="admin-muted">“{b.suspendedNote}”</p>}
                  {b.status === "active" && (
                    <label className="field">
                      <span className="field__label">Reason for suspending (optional, for the audit log)</span>
                      <input className="field__input" value={notes[b.id] ?? ""} maxLength={200} onChange={(e) => setNotes((n) => ({ ...n, [b.id]: e.target.value }))} />
                    </label>
                  )}
                </div>
                <div className="admin-row__actions">
                  {b.status === "active" ? (
                    <Button size="sm" variant="danger" loading={busy === b.id} onClick={() => run(b.id, () => api.admin.setStatus(b.id, true, notes[b.id] ?? ""), "Business suspended")}>
                      Suspend
                    </Button>
                  ) : (
                    <Button size="sm" variant="secondary" loading={busy === b.id} onClick={() => run(b.id, () => api.admin.setStatus(b.id, false, ""), "Business restored")}>
                      Restore
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
