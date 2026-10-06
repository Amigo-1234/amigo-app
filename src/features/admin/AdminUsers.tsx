import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { dataSource, type PersonSummary, type Verification, type VerificationType } from "../../data";
import { timeAgo } from "../../lib/time";
import { useViewer } from "../../state/session";
import { useToast } from "../../state/toast";
import { Avatar } from "../../ui/Avatar";
import { Button } from "../../ui/Button";
import { VerifiedBadge } from "../../ui/VerifiedBadge";
import { supportErrorText } from "../support/useSupport";

const TYPES: { id: VerificationType; label: string }[] = [
  { id: "notable", label: "Notable person" },
  { id: "creator", label: "Creator" },
  { id: "business", label: "Business" },
  { id: "organization", label: "Organization" },
  { id: "amigo", label: "Amigo team" },
];
const typeLabel = (t: VerificationType) => TYPES.find((x) => x.id === t)?.label ?? t;

type Found = { person: PersonSummary; verification: Verification | null };

/** Admin → Users. Only verification for now; account management comes later. */
export function AdminUsers() {
  const viewer = useViewer();
  const toast = useToast();
  const users = dataSource.admin!.users;
  const [handle, setHandle] = useState("");
  const [found, setFound] = useState<Found | null | undefined>(undefined);
  const [verified, setVerified] = useState<{ person: PersonSummary; verification: Verification }[] | null>(null);
  const [type, setType] = useState<VerificationType>("creator");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const loadList = useCallback(() => void users.listVerified(viewer.id).then(setVerified), [users, viewer.id]);
  useEffect(loadList, [loadList]);

  const lookup = async (h: string) => setFound(await users.find(viewer.id, h));
  const find = (e: FormEvent) => {
    e.preventDefault();
    void lookup(handle);
  };

  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast(ok);
      setNote("");
      if (found) await lookup(found.person.handle);
      loadList();
    } catch (e) {
      toast(supportErrorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="admin-card" aria-labelledby="users-verify">
        <h2 id="users-verify" className="admin-card__title">Verification</h2>
        <p className="admin-muted">
          Only admins can verify people; nobody can verify themselves. The badge is public; the type and note are visible to admins only.
          There's no application flow yet — verify people you've checked yourself.
        </p>
        <form className="admin-inline" onSubmit={find}>
          <label className="visually-hidden" htmlFor="users-handle">Username</label>
          <input id="users-handle" className="field__input" value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="@username" />
          <Button type="submit" size="sm" variant="secondary" disabled={!handle.trim()}>Find</Button>
        </form>
        {found === null && <p className="admin-muted">No one with that username.</p>}
        {found && (
          <div className="admin-user">
            <div className="admin-user__who">
              <Avatar name={found.person.name} src={found.person.avatarUrl} seed={found.person.id} size="md" />
              <div>
                <Link to={`/u/${found.person.handle}`} className="admin-row__title">
                  {found.person.name}
                  <VerifiedBadge verified={found.person.verified} />
                </Link>
                <span className="admin-muted"> @{found.person.handle}</span>
                {found.person.bio && <p className="admin-muted">{found.person.bio}</p>}
              </div>
            </div>
            {found.verification ? (
              <>
                <p className="admin-user__status">
                  <strong>Verified</strong> · {typeLabel(found.verification.type)} · {timeAgo(found.verification.verifiedAt)}
                  {found.verification.verifiedBy && <> by @{found.verification.verifiedBy.handle}</>}
                </p>
                {found.verification.note && <p className="admin-muted">Note: {found.verification.note}</p>}
              </>
            ) : (
              <p className="admin-user__status">Not verified</p>
            )}
            <form
              className="admin-user__form"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() => users.verify(viewer.id, found.person.id, type, note), `@${found.person.handle} verified`);
              }}
            >
              <label className="admin-filter">
                Type
                <select value={type} onChange={(e) => setType(e.target.value as VerificationType)}>
                  {TYPES.map((t) => (
                    <option key={t.id} value={t.id}>{t.label}</option>
                  ))}
                </select>
              </label>
              <label className="visually-hidden" htmlFor="users-note">Reason (admins only)</label>
              <input id="users-note" className="field__input" value={note} maxLength={280} onChange={(e) => setNote(e.target.value)} placeholder="Reason / how it was checked (admins only)" />
              <div className="admin-inline">
                <Button type="submit" size="sm" disabled={busy}>{found.verification ? "Update verification" : "Verify"}</Button>
                {found.verification && (
                  <Button
                    type="button"
                    size="sm"
                    variant="danger"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(`Remove @${found.person.handle}'s verification?`)) void run(() => users.unverify(viewer.id, found.person.id, note), "Verification removed");
                    }}
                  >
                    Remove verification
                  </Button>
                )}
              </div>
            </form>
          </div>
        )}
      </section>

      <section className="admin-card" aria-labelledby="users-verified">
        <h2 id="users-verified" className="admin-card__title">Verified people</h2>
        {!verified ? (
          <p className="admin-muted">Loading…</p>
        ) : verified.length === 0 ? (
          <p className="admin-muted">No one is verified yet.</p>
        ) : (
          <ul className="admin-rows">
            {verified.map(({ person, verification }) => (
              <li key={person.id} className="admin-row">
                <div className="admin-row__main">
                  <button type="button" className="admin-row__title admin-linkish" onClick={() => { setHandle(person.handle); void lookup(person.handle); }}>
                    {person.name}
                    <VerifiedBadge verified />
                  </button>
                  <span className="admin-muted">
                    @{person.handle} · {typeLabel(verification.type)} · {timeAgo(verification.verifiedAt)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="admin-muted">Searching, suspending and managing accounts isn't built yet.</p>
    </>
  );
}
