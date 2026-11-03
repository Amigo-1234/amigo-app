import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { dataSource, type ReservationSettings, type ReservationStatus, type UsernameReservation } from "../../data";
import { timeAgoLong } from "../../lib/time";
import { useViewer } from "../../state/session";
import { useToast } from "../../state/toast";
import { Button } from "../../ui/Button";

const STATUS: Record<ReservationStatus, string> = {
  pending: "Waiting for code",
  active: "Reserved",
  claimed: "Claimed",
  expired: "Expired",
  revoked: "Revoked",
  abandoned: "Not confirmed",
};
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—");
const errText = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

/**
 * Admin → Reservations: open or close the public page (reserve.amigoworld.com.ng),
 * review reservations (emails are shown here only, for disputes), revoke or extend
 * them, manage protected names, and give an account a name. Everything is
 * re-checked by the database and recorded in the audit log (without emails).
 */
export function AdminReservations() {
  const api = dataSource.admin?.reservations;
  const toast = useToast();
  const [settings, setSettings] = useState<ReservationSettings | null>(null);
  const [draft, setDraft] = useState({ holdDays: "180", maxPerEmail: "1" });
  const [rows, setRows] = useState<UsernameReservation[] | null>(null);
  const [status, setStatus] = useState<"live" | "all" | ReservationStatus>("live");
  const [query, setQuery] = useState("");
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const loadSettings = useCallback(() => {
    api?.settings().then(
      (s) => {
        setSettings(s);
        setDraft({ holdDays: String(s.holdDays), maxPerEmail: String(s.maxPerEmail) });
      },
      (e) => toast(errText(e), "error"),
    );
  }, [api, toast]);
  const load = useCallback(() => {
    api?.list(status, query.trim()).then(setRows, (e) => toast(errText(e), "error"));
  }, [api, status, query, toast]);
  useEffect(loadSettings, [loadSettings]);
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  if (!api) return null;

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    try {
      await fn();
      toast(ok);
      load();
      loadSettings();
    } catch (e) {
      toast(errText(e), "error");
    } finally {
      setBusy(null);
    }
  }
  const saveSettings = (open: boolean) =>
    run("settings", () => api.setSettings(open, Number(draft.holdDays), Number(draft.maxPerEmail)), open === settings?.open ? "Settings saved" : open ? "Reservations opened" : "Reservations closed");

  return (
    <>
      <section className="admin-card" aria-labelledby="ur-switch">
        <h2 id="ur-switch" className="admin-card__title">Username reservations</h2>
        {!settings ? (
          <p className="admin-muted">Loading…</p>
        ) : (
          <>
            <p className="admin-muted">
              {settings.open ? "Open: people can reserve a username at reserve.amigoworld.com.ng." : "Closed: the reservation page says reservations aren't open."}{" "}
              {settings.active} reserved · {settings.claimed} claimed.
            </p>
            <div className="admin-filter">
              <label>
                Hold for (days){" "}
                <input type="number" min={7} max={730} value={draft.holdDays} onChange={(e) => setDraft((d) => ({ ...d, holdDays: e.target.value }))} />
              </label>
              <label>
                Names per email{" "}
                <input type="number" min={1} max={5} value={draft.maxPerEmail} onChange={(e) => setDraft((d) => ({ ...d, maxPerEmail: e.target.value }))} />
              </label>
            </div>
            <div className="admin-row__actions">
              <Button size="sm" variant={settings.open ? "secondary" : "primary"} loading={busy === "settings"} onClick={() => saveSettings(!settings.open)}>
                {settings.open ? "Close reservations" : "Open reservations"}
              </Button>
              <Button size="sm" variant="secondary" disabled={busy === "settings"} onClick={() => saveSettings(settings.open)}>
                Save
              </Button>
            </div>
          </>
        )}
      </section>

      <section className="admin-card" aria-labelledby="ur-list">
        <h2 id="ur-list" className="admin-card__title">Reservations</h2>
        <p className="admin-muted">Emails are shown to admins only, to settle disputes. Revoking frees the name straight away.</p>
        <div className="admin-filter">
          <label>
            Show{" "}
            <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              <option value="live">Live (reserved or waiting)</option>
              <option value="all">All</option>
              {(Object.keys(STATUS) as ReservationStatus[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS[s]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Search{" "}
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Username or email" maxLength={80} />
          </label>
        </div>
        {!rows ? (
          <p className="admin-muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="admin-muted">No reservations.</p>
        ) : (
          <ul className="admin-rows">
            {rows.map((r) => (
              <li key={r.id} className="admin-row">
                <div className="admin-row__main">
                  <p>
                    <strong className="admin-row__title">@{r.username}</strong>{" "}
                    <span className={`admin-badge${r.status === "revoked" ? " admin-badge--danger" : r.status === "active" ? "" : " admin-badge--muted"}`}>{STATUS[r.status]}</span>
                  </p>
                  <p className="admin-muted">
                    {r.email} · asked {timeAgoLong(new Date(r.createdAt))}
                    {r.status === "active" && <> · held until {day(r.expiresAt)}</>}
                    {r.claimedHandle && (
                      <>
                        {" "}· now <Link to={`/u/${r.claimedHandle}`}>@{r.claimedHandle}</Link>
                      </>
                    )}
                  </p>
                  {r.closedReason && <p className="admin-muted">“{r.closedReason}”</p>}
                  {(r.status === "active" || r.status === "pending") && (
                    <label className="field">
                      <span className="field__label">Reason for revoking (required, for the audit log)</span>
                      <input className="field__input" value={reasons[r.id] ?? ""} maxLength={300} onChange={(e) => setReasons((x) => ({ ...x, [r.id]: e.target.value }))} />
                    </label>
                  )}
                </div>
                {(r.status === "active" || r.status === "pending") && (
                  <div className="admin-row__actions">
                    {r.status === "active" && (
                      <Button size="sm" variant="secondary" loading={busy === `x${r.id}`} onClick={() => run(`x${r.id}`, () => api.extend(r.id, 30), "Extended by 30 days")}>
                        +30 days
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="danger"
                      loading={busy === r.id}
                      disabled={(reasons[r.id] ?? "").trim().length < 3}
                      onClick={() => run(r.id, () => api.revoke(r.id, reasons[r.id] ?? ""), `@${r.username} is free again`)}
                    >
                      Revoke
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <ProtectedNames />
      <AssignName />
    </>
  );
}

function ProtectedNames() {
  const api = dataSource.admin!.reservations!;
  const toast = useToast();
  const [names, setNames] = useState<{ username: string; note: string | null }[] | null>(null);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [filter, setFilter] = useState("");
  const load = useCallback(() => api.protectedNames().then(setNames, (e) => toast(errText(e), "error")), [api, toast]);
  useEffect(() => {
    void load();
  }, [load]);
  const shown = (names ?? []).filter((n) => n.username.includes(filter.trim().toLowerCase()));
  return (
    <section className="admin-card" aria-labelledby="ur-protected">
      <h2 id="ur-protected" className="admin-card__title">Protected names</h2>
      <p className="admin-muted">Nobody can sign up with, rename to or reserve these. Existing accounts keep their names.</p>
      <form
        className="admin-filter"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.protect(name, note);
            toast(`@${name.trim().toLowerCase()} is protected`);
            setName("");
            setNote("");
            void load();
          } catch (err) {
            toast(errText(err), "error");
          }
        }}
      >
        <label>
          Name <input value={name} onChange={(e) => setName(e.target.value)} maxLength={24} placeholder="e.g. lagos_official" required />
        </label>
        <label>
          Note <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="Why (optional)" />
        </label>
        <Button size="sm" type="submit" disabled={!name.trim()}>
          Protect
        </Button>
      </form>
      <div className="admin-filter">
        <label>
          Filter <input value={filter} onChange={(e) => setFilter(e.target.value)} maxLength={24} />
        </label>
      </div>
      {!names ? (
        <p className="admin-muted">Loading…</p>
      ) : (
        <ul className="admin-rows">
          {shown.slice(0, 60).map((n) => (
            <li key={n.username} className="admin-row">
              <div className="admin-row__main">
                <p>
                  <strong>@{n.username}</strong> {n.note && <span className="admin-muted">· {n.note}</span>}
                </p>
              </div>
              <div className="admin-row__actions">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={async () => {
                    try {
                      await api.unprotect(n.username);
                      toast(`@${n.username} is no longer protected`);
                      void load();
                    } catch (err) {
                      toast(errText(err), "error");
                    }
                  }}
                >
                  Unprotect
                </Button>
              </div>
            </li>
          ))}
          {shown.length > 60 && <li className="admin-muted">…and {shown.length - 60} more. Filter to find one.</li>}
        </ul>
      )}
    </section>
  );
}

/** Disputes and official accounts: give an existing account a name (even a protected or reserved one). */
function AssignName() {
  const api = dataSource.admin!.reservations!;
  const users = dataSource.admin!.users;
  const viewer = useViewer();
  const toast = useToast();
  const [account, setAccount] = useState("");
  const [name, setName] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <section className="admin-card" aria-labelledby="ur-assign">
      <h2 id="ur-assign" className="admin-card__title">Give an account a username</h2>
      <p className="admin-muted">For official accounts and settled disputes. Any live reservation on the name is revoked. Recorded in the audit log.</p>
      <form
        className="admin-filter"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const found = await users.find(viewer.id, account.trim().replace(/^@/, "").toLowerCase());
            if (!found) throw new Error("No account with that username.");
            await api.assign(found.person.id, name, reason);
            toast(`@${found.person.handle} is now @${name.trim().toLowerCase()}`);
            setAccount("");
            setName("");
            setReason("");
          } catch (err) {
            toast(errText(err), "error");
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Account <input value={account} onChange={(e) => setAccount(e.target.value)} maxLength={25} placeholder="@current_username" required />
        </label>
        <label>
          New username <input value={name} onChange={(e) => setName(e.target.value)} maxLength={24} required />
        </label>
        <label>
          Reason <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} required />
        </label>
        <Button size="sm" type="submit" loading={busy} disabled={!account.trim() || !name.trim() || reason.trim().length < 3}>
          Give name
        </Button>
      </form>
    </section>
  );
}
