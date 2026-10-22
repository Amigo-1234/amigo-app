import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ShieldAlert } from "lucide-react";
import { dataSource, type AccountStatus } from "../../data";
import "./SuspensionBanner.css";

/** Tells a suspended account why posting and messaging are off (the database enforces it). */
export function SuspensionBanner() {
  const [status, setStatus] = useState<AccountStatus | null>(null);
  useEffect(() => {
    if (!dataSource.accountStatus) return;
    let cancelled = false;
    // Once per visit; a failed check shows nothing (the server still enforces suspension).
    dataSource.accountStatus().then((s) => !cancelled && setStatus(s), () => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  if (!status) return null;
  const warning = status.warnings[0];
  if (!status.suspended && warning) {
    return (
      <div className="suspension-banner suspension-banner--warning" role="status">
        <ShieldAlert size={18} aria-hidden="true" />
        <p>
          <strong>A note from the Amigo team:</strong> {warning.message} Please review the <Link to="/legal/guidelines">Community Guidelines</Link>.{" "}
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setStatus({ ...status, warnings: status.warnings.slice(1) });
              void dataSource.acknowledgeWarning?.(warning.id).catch(() => undefined);
            }}
          >
            Got it
          </button>
        </p>
      </div>
    );
  }
  if (!status.suspended) return null;
  return (
    <div className="suspension-banner" role="status">
      <ShieldAlert size={18} aria-hidden="true" />
      <p>
        <strong>Your account is suspended{status.until ? ` until ${status.until.toLocaleString()}` : ""}.</strong> You can still read, report
        and manage your account, but you can't post, reply, like, follow or send messages.
        {status.reason ? ` Reason: ${status.reason}` : ""} See the <Link to="/legal/guidelines">Community Guidelines</Link>.
      </p>
    </div>
  );
}
