import { useEffect, useState } from "react";
import { Link } from "react-router";
import { dataSource, type AdminAuditEntry, type World } from "../../data";
import { timeAgo } from "../../lib/time";
import { useViewer } from "../../state/session";
import { worldStatus } from "../worlds/time";

/** Real counts only — things that need an admin's attention, and what admins did recently. */
export function AdminOverview() {
  const viewer = useViewer();
  const [counts, setCounts] = useState<{ pending: number; reports: number; flags: number } | null>(null);
  const [audit, setAudit] = useState<AdminAuditEntry[] | null>(null);
  useEffect(() => {
    const a = dataSource.admin!.support;
    void Promise.all([a.listRequests(viewer.id, "pending"), a.listReports(viewer.id, "open"), a.suspicious(viewer.id), a.audit(viewer.id, 8)]).then(
      ([pending, reports, flags, log]) => {
        setCounts({ pending: pending.length, reports: reports.length, flags: flags.length });
        setAudit(log);
      },
    );
  }, [viewer.id]);
  const items = counts
    ? [
        { n: counts.pending, label: "Support requests waiting for review", to: "/admin/support?status=pending" },
        { n: counts.reports, label: "Open reports on Support requests", to: "/admin/support?tab=reports" },
        { n: counts.flags, label: "Support activity flagged for a look", to: "/admin/support?tab=activity" },
      ]
    : [];
  return (
    <>
      <section className="admin-card" aria-labelledby="ov-attn">
        <h2 id="ov-attn" className="admin-card__title">Needs attention</h2>
        {!counts ? (
          <p className="admin-muted">Loading…</p>
        ) : (
          <ul className="admin-attn">
            {items.map((i) => (
              <li key={i.label}>
                <Link to={i.to}>
                  <strong className={i.n ? "is-due" : ""}>{i.n}</strong> {i.label}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="admin-card" aria-labelledby="ov-audit">
        <h2 id="ov-audit" className="admin-card__title">Recent admin actions</h2>
        <AuditList entries={audit} />
      </section>
    </>
  );
}

export function AuditList({ entries }: { entries: AdminAuditEntry[] | null }) {
  if (!entries) return <p className="admin-muted">Loading…</p>;
  if (!entries.length) return <p className="admin-muted">No admin actions yet. Every moderation and credit change will be listed here.</p>;
  return (
    <ul className="admin-audit">
      {entries.map((e) => (
        <li key={e.id}>
          <span className="admin-audit__what">{e.summary}</span>
          <span className="admin-muted">
            @{e.admin.handle} · {timeAgo(e.createdAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Worlds are created with SQL for now (docs/architecture/WORLDS.md); this lists them read-only. */
export function AdminWorlds() {
  const viewer = useViewer();
  const [worlds, setWorlds] = useState<World[] | null>(null);
  useEffect(() => {
    if (!dataSource.worlds) return setWorlds([]);
    void dataSource.worlds.listWorlds(viewer.id).then(setWorlds);
  }, [viewer.id]);
  const now = Date.now();
  return (
    <section className="admin-card">
      <h2 className="admin-card__title">Worlds</h2>
      <p className="admin-muted">
        Creating and editing Worlds from here isn't built yet — admins create them with SQL (see docs/architecture/WORLDS.md). Current Worlds:
      </p>
      <ul className="admin-rows">
        {worlds?.map((w) => (
          <li key={w.id} className="admin-row">
            <div className="admin-row__main">
              <Link to={`/worlds/${w.slug}`} className="admin-row__title">{w.title}</Link>
              <span className="admin-muted">
                {worldStatus(w, now)} · {w.participantCount} people{w.competition ? " · competition" : ""}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AdminPlaceholder({ title, body, link }: { title: string; body: string; link?: { to: string; label: string } }) {
  return (
    <section className="admin-card">
      <h2 className="admin-card__title">{title}</h2>
      <p className="admin-muted">{body}</p>
      {link && (
        <p>
          <Link to={link.to} className="admin-link">{link.label}</Link>
        </p>
      )}
    </section>
  );
}
