import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import type { AdminListing, ListingStatus } from "../../data";
import { timeAgoLong } from "../../lib/time";
import { useToast } from "../../state/toast";
import { Button } from "../../ui/Button";
import { formatPrice, marketApi, marketErrorText, STATUS_LABEL, useMarketplace } from "../marketplace/shared";

/**
 * Admin → Marketplace: the on/off switch, and every listing with who runs its business (admins
 * only). Removing keeps the listing and its photos for review; restoring returns it as a draft.
 * Every change is recorded in the audit log.
 */
export function AdminMarketplace() {
  const toast = useToast();
  const { enabled, reload } = useMarketplace();
  const [rows, setRows] = useState<AdminListing[] | null>(null);
  const [status, setStatus] = useState<ListingStatus | "all">("all");
  const [query, setQuery] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!marketApi) return;
    marketApi.admin.list(status, query).then(setRows, (e) => toast(marketErrorText(e), "error"));
  }, [status, query, toast]);
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  if (!marketApi) return null;
  const api = marketApi;

  async function run(id: string, fn: () => Promise<void>, ok: string) {
    setBusy(id);
    try {
      await fn();
      toast(ok);
      load();
    } catch (e) {
      toast(marketErrorText(e), "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <section className="admin-card" aria-labelledby="mk-switch">
        <h2 id="mk-switch" className="admin-card__title">Marketplace</h2>
        <p className="admin-muted">
          {enabled === null ? "Loading…" : enabled ? "On: business pages can list products and services, and everyone can browse them." : "Off: only admins can see or create listings. Turn it on when you're ready to launch."}
        </p>
        {enabled !== null && (
          <div className="admin-row__actions">
            <Button
              size="sm"
              variant={enabled ? "secondary" : "primary"}
              loading={busy === "switch"}
              onClick={() => run("switch", async () => { await api.admin.setFeature("marketplace", !enabled); reload(); }, enabled ? "Marketplace turned off" : "Marketplace turned on")}
            >
              {enabled ? "Turn off" : "Turn on"}
            </Button>
          </div>
        )}
      </section>

      <section className="admin-card" aria-labelledby="mk-list">
        <h2 id="mk-list" className="admin-card__title">Listings</h2>
        <p className="admin-muted">Reported listings also appear in Reports. Removing hides a listing everywhere; the business can't edit, relist or delete it.</p>
        <div className="admin-filter">
          <label>
            Show{" "}
            <select value={status} onChange={(e) => setStatus(e.target.value as ListingStatus | "all")}>
              <option value="all">All</option>
              {(Object.keys(STATUS_LABEL) as ListingStatus[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Search{" "}
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Title or business handle" maxLength={60} />
          </label>
        </div>
        {!rows ? (
          <p className="admin-muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="admin-muted">No listings.</p>
        ) : (
          <ul className="admin-rows">
            {rows.map((l) => (
              <li key={l.id} className="admin-row">
                <div className="admin-row__main">
                  <p>
                    <Link to={`/l/${l.id}`} className="admin-row__title">{l.title}</Link>{" "}
                    <span className={`admin-badge${l.status === "removed" ? " admin-badge--danger" : ""}`}>{STATUS_LABEL[l.status]}</span>
                    {l.openReports > 0 && <span className="admin-badge admin-badge--danger">{l.openReports} open {l.openReports === 1 ? "report" : "reports"}</span>}
                  </p>
                  <p className="admin-muted">
                    {formatPrice(l.priceMinor, l.currency, "item")} · <Link to={`/b/${l.business.handle}`}>/b/{l.business.handle}</Link> · run by{" "}
                    <Link to={`/u/${l.ownerHandle}`}>@{l.ownerHandle}</Link> · listed {timeAgoLong(l.createdAt)}
                  </p>
                  {l.removedNote && <p className="admin-muted">“{l.removedNote}”</p>}
                  {l.status !== "removed" && (
                    <label className="field">
                      <span className="field__label">Reason for removing (optional, for the audit log)</span>
                      <input className="field__input" value={notes[l.id] ?? ""} maxLength={300} onChange={(e) => setNotes((n) => ({ ...n, [l.id]: e.target.value }))} />
                    </label>
                  )}
                </div>
                <div className="admin-row__actions">
                  {l.status === "removed" ? (
                    <Button size="sm" variant="secondary" loading={busy === l.id} onClick={() => run(l.id, () => api.admin.restore(l.id), "Listing restored as a draft")}>
                      Restore
                    </Button>
                  ) : (
                    <Button size="sm" variant="danger" loading={busy === l.id} onClick={() => run(l.id, () => api.admin.remove(l.id, notes[l.id] ?? ""), "Listing removed")}>
                      Remove
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
