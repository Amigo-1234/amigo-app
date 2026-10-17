import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { X } from "lucide-react";
import { dataSource, type PendingLegal } from "../../data";
import { AuthHeading, AuthLayout } from "../auth";
import { Button } from "../../ui/Button";
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
 * show as a dismissible notice instead. A failed check never blocks the app.
 */
export function LegalGate({ children }: { children: ReactNode }) {
  const api = dataSource.legal;
  const [pending, setPending] = useState<PendingLegal[] | null>(api ? null : []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<string[]>(dismissed);

  useEffect(() => {
    if (!api) return;
    void api.pending().then(setPending, () => setPending([]));
  }, [api]);

  const required = pending?.filter((p) => p.required) ?? [];
  const notices = (pending ?? []).filter((p) => !p.required && !hidden.includes(dismissedKey(p)));

  if (pending === null) return null;

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
        <p className="legal-gate__fine">If you don't agree, you can delete your account in Settings → Account, or contact us.</p>
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
