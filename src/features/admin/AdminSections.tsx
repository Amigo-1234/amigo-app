import { useEffect, useState } from "react";
import { Link } from "react-router";
import { dataSource, type AdminAuditEntry, type World } from "../../data";
import { timeAgo } from "../../lib/time";
import { useViewer } from "../../state/session";
import { formatSpan, serverNow, worldStatus } from "../worlds/time";
import { CancelWorld, WorldEditor } from "../worlds/WorldEditor";
import { Sheet } from "../../ui/Sheet";
import { Button } from "../../ui/Button";

type Count = number | "error";
const settled = async <T,>(p: Promise<T[]>, keep: (x: T) => boolean = () => true): Promise<Count> =>
  p.then((rows) => rows.filter(keep).length, () => "error" as const);

/**
 * Real counts only — things that need an admin's attention, and what admins
 * did recently. Each count loads on its own, so one failing source shows
 * "couldn't load" instead of holding up the rest.
 */
export function AdminOverview() {
  const viewer = useViewer();
  const [counts, setCounts] = useState<{ label: string; to: string; n: Count }[] | null>(null);
  const [audit, setAudit] = useState<AdminAuditEntry[] | null>(null);
  const [auditFailed, setAuditFailed] = useState(false);
  useEffect(() => {
    const admin = dataSource.admin!;
    const a = admin.support;
    const sources: { label: string; to: string; load: () => Promise<Count> }[] = [
      ...(admin.moderation ? [{ label: "Open reports on posts", to: "/admin/reports", load: () => settled(admin.moderation!.listReports("open")) }] : []),
      ...(admin.messageReports ? [{ label: "Open message reports", to: "/admin/reports", load: () => settled(admin.messageReports!.list(viewer.id), (r) => r.status === "open") }] : []),
      ...(admin.moments ? [{ label: "Reported Moments", to: "/admin/reports", load: () => settled(admin.moments!.listReports(viewer.id), (r) => r.status === "open") }] : []),
      { label: "Support requests waiting for review", to: "/admin/support?status=pending", load: () => settled(a.listRequests(viewer.id, "pending")) },
      { label: "Open reports on Support requests", to: "/admin/support?tab=reports", load: () => settled(a.listReports(viewer.id, "open")) },
      { label: "Support activity flagged for a look", to: "/admin/support?tab=activity", load: () => settled(a.suspicious(viewer.id)) },
    ];
    let live = true;
    void Promise.all(sources.map((x) => x.load())).then((ns) => live && setCounts(sources.map((x, i) => ({ label: x.label, to: x.to, n: ns[i] }))));
    a.audit(viewer.id, 8).then(
      (log) => live && setAudit(log),
      () => live && setAuditFailed(true),
    );
    return () => {
      live = false;
    };
  }, [viewer.id]);
  const items = counts ?? [];
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
                  {i.n === "error" ? (
                    <>
                      <strong>—</strong> {i.label} <span className="admin-muted">(couldn't load)</span>
                    </>
                  ) : (
                    <>
                      <strong className={i.n ? "is-due" : ""}>{i.n}</strong> {i.label}
                    </>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="admin-card" aria-labelledby="ov-audit">
        <h2 id="ov-audit" className="admin-card__title">Recent admin actions</h2>
        {auditFailed ? <p className="admin-muted">Couldn't load recent actions. Reload to try again.</p> : <AuditList entries={audit} />}
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

/** Admin → Worlds: create, edit and cancel scheduled events (every change is checked and audit-logged by the database). */
export function AdminWorlds() {
  const viewer = useViewer();
  const [worlds, setWorlds] = useState<World[] | null>(null);
  const [editing, setEditing] = useState<World | "new" | null>(null);
  const [cancelling, setCancelling] = useState<World | null>(null);
  const [failed, setFailed] = useState(false);
  const load = () => {
    if (!dataSource.worlds) return setWorlds([]);
    setFailed(false);
    void dataSource.worlds.listWorlds(viewer.id).then(setWorlds, () => setFailed(true));
  };
  useEffect(load, [viewer.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const now = serverNow();
  const admin = dataSource.worlds?.admin;
  const sorted = [...(worlds ?? [])].sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime());
  return (
    <section className="admin-card">
      <h2 className="admin-card__title">Worlds</h2>
      {admin ? (
        <p>
          <Button size="sm" onClick={() => setEditing("new")}>
            New World
          </Button>
        </p>
      ) : (
        <p className="admin-muted">Managing Worlds isn't available on this backend.</p>
      )}
      {failed ? (
        <p className="admin-muted">
          Couldn't load Worlds.{" "}
          <Button size="sm" variant="ghost" onClick={load}>
            Try again
          </Button>
        </p>
      ) : !worlds ? (
        <p className="admin-muted">Loading…</p>
      ) : (
        worlds.length === 0 && <p className="admin-muted">No Worlds yet.</p>
      )}
      <ul className="admin-rows">
        {sorted.map((w) => {
          const st = worldStatus(w, now);
          const changeable = st === "upcoming" || st === "live";
          return (
            <li key={w.id} className="admin-row">
              <div className="admin-row__main">
                <Link to={`/worlds/${w.slug}`} className="admin-row__title">{w.title}</Link>
                <span className="admin-muted">
                  {st} · {formatSpan(w.startsAt, w.endsAt)} · {w.participantCount} people{w.competition ? " · competition" : ""}
                </span>
              </div>
              {admin && changeable && (
                <span className="admin-row__actions">
                  <Button size="sm" variant="secondary" onClick={() => setEditing(w)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setCancelling(w)}>
                    Cancel
                  </Button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <Sheet open={!!editing} onClose={() => setEditing(null)} label={editing === "new" ? "New World" : "Edit World"} fullscreenOnMobile>
        {editing && (
          <WorldEditor
            world={editing === "new" ? undefined : editing}
            onDone={(saved) => {
              setEditing(null);
              if (saved) load();
            }}
          />
        )}
      </Sheet>
      <Sheet open={!!cancelling} onClose={() => setCancelling(null)} label="Cancel World">
        {cancelling && (
          <CancelWorld
            world={cancelling}
            onDone={(done) => {
              setCancelling(null);
              if (done) load();
            }}
          />
        )}
      </Sheet>
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
