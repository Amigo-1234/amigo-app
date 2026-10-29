import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { X } from "lucide-react";
import { dataSource, type PendingLegal } from "../../data";
import { AuthHeading, AuthLayout } from "../auth";
import { Button } from "../../ui/Button";
import { LoadingScreen } from "../../ui/Loader";
import "./LegalGate.css";

const DISMISSED = "amigo.legal.dismissed";
const dismissedKey = (p: PendingLegal) => `${p.slug}@${p.version}`;

function dismissed(): string[] {
  try {
    return JSON.parse(localStorage.getItem(DISMISSED) ?? "[]");
  } catch {
    return [];
  }
}

/**
 * Before the app: anything this account must accept (it never accepted the
 * Terms/Privacy, or a material change was published). Non-material updates
 * show as a dismissible notice instead. If the check itself fails (offline,
 * server error) the app doesn't open unchecked: it says so and retries — on
 * its own when the connection comes back, or with a tap.
 */
/** Not agreeing: sign out, or delete the account right here (Settings isn't reachable before agreeing). */
function LeaveOptions() {
  const [deleting, setDeleting] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="legal-gate__leave">
      <p className="legal-gate__fine">Don't agree? You can sign out, or delete your account and everything in it.</p>
      <div className="legal-gate__leave-actions">
        <Button variant="ghost" onClick={() => void dataSource.signOut()}>
          Sign out
        </Button>
        {dataSource.deleteAccount && (
          <Button variant="ghost" onClick={() => setDeleting((d) => !d)} aria-expanded={deleting}>
            Delete my account
          </Button>
        )}
      </div>
      {deleting && (
        <form
          className="legal-gate__delete"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!password) return;
            setBusy(true);
            setError(null);
            try {
              await dataSource.deleteAccount!(password);
            } catch {
              setError("Couldn't delete the account. Check your password and try again.");
              setBusy(false);
            }
          }}
        >
          <label className="field">
            <span className="field__label">Your password, to confirm. This permanently deletes your account, posts and messages.</span>
            <input className="field__input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {error && (
            <p className="auth__error" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" variant="danger" loading={busy} disabled={!password}>
            Delete my account permanently
          </Button>
        </form>
      )}
    </div>
  );
}

export function LegalGate({ children }: { children: ReactNode }) {
  const api = dataSource.legal;
  const [pending, setPending] = useState<PendingLegal[] | null>(api ? null : []);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<string[]>(dismissed);

  useEffect(() => {
    if (!api) return;
    let live = true;
    setFailed(false);
    api.pending().then(
      (p) => live && setPending(p),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [api, attempt]);
  useEffect(() => {
    if (!failed) return;
    const again = () => setAttempt((n) => n + 1);
    const t = setTimeout(again, 8000);
    window.addEventListener("online", again);
    return () => {
      clearTimeout(t);
      window.removeEventListener("online", again);
    };
  }, [failed]);

  const required = pending?.filter((p) => p.required) ?? [];
  const notices = (pending ?? []).filter((p) => !p.required && !hidden.includes(dismissedKey(p)));

  if (pending === null && failed)
    return (
      <AuthLayout stepKey="legal-check">
        <AuthHeading title="Can't reach Amigo" sub="We need to check our terms with the server before you continue. Check your connection." />
        <Button size="lg" block onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </Button>
        <LeaveOptions />
      </AuthLayout>
    );
  if (pending === null) return <LoadingScreen />;

  if (required.length) {
    const accept = async () => {
      setBusy(true);
      setError(null);
      try {
        await api!.accept(required.map((p) => ({ slug: p.slug, version: p.version })));
        setPending((list) => (list ?? []).filter((p) => !p.required));
      } catch {
        setError("Couldn't save that. Check your connection and try again.");
      } finally {
        setBusy(false);
      }
    };
    return (
      <AuthLayout stepKey="legal-gate">
        <AuthHeading title="Before you continue" sub="Please review and accept these to keep using Amigo." />
        <ul className="legal-gate__list">
          {required.map((p) => (
            <li key={p.slug}>
              <Link to={`/legal/${p.slug}`} target="_blank" rel="noopener">
                {p.title}
              </Link>
              <span>Version {p.version}</span>
              {p.summary && <p>{p.summary}</p>}
            </li>
          ))}
        </ul>
        {error && (
          <p className="auth__error" role="alert">
            {error}
          </p>
        )}
        <Button size="lg" block loading={busy} disabled={busy} onClick={accept}>
          I agree
        </Button>
        <LeaveOptions />
      </AuthLayout>
    );
  }

  return (
    <>
      {notices.length > 0 && (
        <div className="legal-notice" role="status">
          <p>
            We've updated{" "}
            {notices.map((p, i) => (
              <span key={p.slug}>
                {i > 0 && (i === notices.length - 1 ? " and " : ", ")}
                <Link to={`/legal/${p.slug}`}>{p.title}</Link>
              </span>
            ))}
            .
          </p>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => {
              const next = [...hidden, ...notices.map(dismissedKey)];
              setHidden(next);
              try {
                localStorage.setItem(DISMISSED, JSON.stringify(next));
              } catch {
                /* private mode */
              }
            }}
          >
            <X size={18} />
          </button>
        </div>
      )}
      {children}
    </>
  );
}
