import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { dataSource, type AdminHistoryEntry, type AdminUserDetail, type AdminUserRow } from "../../data";
import { timeAgo } from "../../lib/time";
import { useToast } from "../../state/toast";
import { Avatar } from "../../ui/Avatar";
import { Button } from "../../ui/Button";
import { supportErrorText } from "../support/useSupport";

/**
 * Admin → Users → Accounts: find people, see their standing at a glance,
 * suspend / restore / warn (with confirmation) and keep moderation notes.
 * Every action is checked and audit-logged by the database, not this screen.
 */
export function AdminAccounts() {
  const api = dataSource.admin!.moderation!;
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(params.get("u") ?? "");
  const [rows, setRows] = useState<AdminUserRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const search = useCallback(
    (q: string) => {
      setRows(null);
      api.searchUsers!(q).then(
        (r) => {
          setRows(r);
          // Opened from a link (?u=handle): show that person straight away.
          const exact = r.find((x) => x.handle.toLowerCase() === q.toLowerCase().replace(/^@/, ""));
          if (exact) setSelected(exact.id);
        },
        (e) => {
          setRows([]);
          toast(supportErrorText(e), "error");
        },
      );
    },
    [api, toast],
  );
  // Once, with the handle from the link (if any).
  const [initial] = useState(() => params.get("u") ?? "");
  useEffect(() => search(initial), [search, initial]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSelected(null);
    setParams(query.trim() ? { u: query.trim().replace(/^@/, "") } : {}, { replace: true });
    search(query.trim());
  };

  return (
    <section className="admin-card" aria-labelledby="acc-title">
      <h2 id="acc-title" className="admin-card__title">Accounts</h2>
      <form className="admin-inline" onSubmit={submit} role="search">
        <label className="visually-hidden" htmlFor="acc-q">Search by username or name</label>
        <input id="acc-q" className="field__input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search @username or name" autoComplete="off" />
        <Button type="submit" size="sm" variant="secondary">Search</Button>
      </form>
      {!rows ? (
        <p className="admin-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="admin-muted">No accounts match.</p>
      ) : (
        <ul className="admin-rows">
          {rows.map((u) => (
            <li key={u.id} className="admin-row">
              <button type="button" className="admin-account" aria-expanded={selected === u.id} onClick={() => setSelected(selected === u.id ? null : u.id)}>
                <Avatar name={u.name} src={u.avatarUrl} seed={u.id} size="sm" />
                <span className="admin-row__main">
                  <span className="admin-row__title">{u.name}</span>
                  <span className="admin-muted">
                    @{u.handle} · joined {timeAgo(u.joinedAt)} · {u.posts} posts · {u.followers} followers
                  </span>
                </span>
                <span className="admin-badges">
                  {u.isAdmin && <span className="admin-badge">Admin</span>}
                  {u.suspended && <span className="admin-badge admin-badge--danger">Suspended</span>}
                  {!u.emailVerified && <span className="admin-badge admin-badge--muted">Email not verified</span>}
                </span>
              </button>
              {selected === u.id && (
                <AccountDetail
                  userId={u.id}
                  onChanged={(d) => setRows((rs) => rs?.map((r) => (r.id === d.id ? { ...r, suspended: d.suspended, suspendedUntil: d.suspendedUntil } : r)) ?? rs)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const ACTION_LABEL: Record<string, string> = {
  note: "Note",
  "account.suspend": "Suspended",
  "account.unsuspend": "Restored",
  "account.warn": "Warned",
};

const DURATIONS = [
  { label: "1 day", days: 1 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "Until restored", days: 0 },
];

function AccountDetail({ userId, onChanged }: { userId: string; onChanged: (d: AdminUserDetail) => void }) {
  const api = dataSource.admin!.moderation!;
  const toast = useToast();
  const [d, setD] = useState<AdminUserDetail | null>(null);
  const [history, setHistory] = useState<AdminHistoryEntry[] | null>(null);
  const [reason, setReason] = useState("");
  const [days, setDays] = useState(7);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [detail, h] = await Promise.all([api.userDetail!(userId), api.history!(userId).catch(() => [])]);
    setD(detail);
    setHistory(h);
    return detail;
  }, [api, userId]);
  useEffect(() => void load().catch((e) => toast(supportErrorText(e), "error")), [load, toast]);

  const act = async (fn: () => Promise<void>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast(done);
      onChanged(await load());
    } catch (e) {
      toast(supportErrorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  if (!d) return <p className="admin-muted admin-account__detail">Loading…</p>;
  const r = d.reportsAgainst;
  return (
    <div className="admin-account__detail">
      <p>
        <Link to={`/u/${d.handle}`}>View profile</Link>
        {d.lastActive && <span className="admin-muted"> · last active {timeAgo(d.lastActive)}</span>}
      </p>
      {d.bio && <p className="admin-muted">{d.bio}</p>}
      <dl className="admin-stats admin-stats--compact">
        {(
          [
            ["Posts", d.posts],
            ["Replies", d.replies],
            ["Followers", d.followers],
            ["Following", d.following],
            ["Likes given", d.likesGiven],
            ["Moments (30 d)", d.moments30d],
            ["Reports against", r.posts + r.profile + r.messages + r.moments],
            ["…still open", r.open],
            ["Reports made", d.reportsMade],
          ] as [string, number][]
        ).map(([label, n]) => (
          <div key={label} className="admin-stats__item">
            <dt>{label}</dt>
            <dd>{n.toLocaleString()}</dd>
          </div>
        ))}
      </dl>

      {d.suspension ? (
        <div className="admin-account__standing is-suspended">
          <p>
            <strong>Suspended</strong> {d.suspension.until ? `until ${d.suspension.until.toLocaleString()}` : "until restored"} · since {timeAgo(d.suspension.since)}
          </p>
          <p className="admin-muted">Reason shown to them: {d.suspension.reason}</p>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => {
              if (!window.confirm(`Restore @${d.handle}? They'll be able to post, message and react again.`)) return;
              void act(() => api.unsuspend(d.id, note.trim()), `Restored @${d.handle}`);
            }}
          >
            Restore account
          </Button>
        </div>
      ) : d.isAdmin ? (
        <p className="admin-muted">Admins can't be suspended.</p>
      ) : (
        <form
          className="admin-user__form"
          onSubmit={(e) => {
            e.preventDefault();
            const label = DURATIONS.find((x) => x.days === days)!.label.toLowerCase();
            if (!window.confirm(`Suspend @${d.handle} (${label})? They'll see the reason and can't post, message or react until it ends.`)) return;
            void act(() => api.suspend(d.id, reason.trim(), days ? new Date(Date.now() + days * 86_400_000) : null), `Suspended @${d.handle}`).then(() => setReason(""));
          }}
        >
          <label className="visually-hidden" htmlFor={`sus-${d.id}`}>Reason (shown to them)</label>
          <input id={`sus-${d.id}`} className="field__input" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="Reason (shown to them)" />
          <label className="admin-filter">
            For
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {DURATIONS.map((x) => (
                <option key={x.days} value={x.days}>{x.label}</option>
              ))}
            </select>
          </label>
          <div className="admin-inline">
            <Button type="submit" size="sm" variant="danger" disabled={busy || reason.trim().length < 3}>Suspend</Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy || reason.trim().length < 3}
              onClick={() => {
                if (!window.confirm(`Send @${d.handle} this warning? They'll see it until they acknowledge it.`)) return;
                void act(() => api.warn(d.id, reason.trim()), `Warning sent to @${d.handle}`).then(() => setReason(""));
              }}
            >
              Warn instead
            </Button>
          </div>
        </form>
      )}

      {d.warnings.length > 0 && (
        <div>
          <h3 className="admin-subtitle">Warnings</h3>
          <ul className="admin-rows">
            {d.warnings.map((w, i) => (
              <li key={i} className="admin-muted">
                {timeAgo(w.at)} · {w.acknowledged ? "acknowledged" : "not yet seen"} · {w.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h3 className="admin-subtitle">Notes and history</h3>
        <form
          className="admin-inline"
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => api.addNote!("user", d.id, note.trim()), "Note saved").then(() => setNote(""));
          }}
        >
          <label className="visually-hidden" htmlFor={`note-${d.id}`}>Note (admins only)</label>
          <input id={`note-${d.id}`} className="field__input" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder="Add a note (admins only)" />
          <Button type="submit" size="sm" variant="secondary" disabled={busy || !note.trim()}>Save note</Button>
        </form>
        {!history ? null : history.length === 0 ? (
          <p className="admin-muted">No admin actions or notes yet.</p>
        ) : (
          <ul className="admin-rows">
            {history.map((h) => (
              <li key={h.id} className="admin-muted">
                {timeAgo(h.at)} · @{h.admin ?? "unknown"} · <strong>{ACTION_LABEL[h.action] ?? h.action}</strong>: {h.summary}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
