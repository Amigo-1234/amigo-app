import { Link, useLocation } from "react-router";
import { ShieldAlert } from "lucide-react";
import { timeAgoLong } from "../../lib/time";
import { useSecurity } from "../../state/security";
import { Button } from "../../ui/Button";
import "./Security.css";

/**
 * Shown everywhere when a new device starts using your messages, so a sign-in
 * you didn't make (e.g. after someone reset your password) is noticed quickly.
 */
export function SignInNotice() {
  const { newDevices, acknowledgeDevices, removed } = useSecurity();
  const { pathname } = useLocation();

  if (removed) {
    return (
      <div className="sec-banner sec-banner--warn signin-notice" role="alert">
        <ShieldAlert size={18} aria-hidden="true" />
        <div className="sec-banner__text">
          <strong>This browser was removed from your messaging devices.</strong> It can't read new messages. If that was you, there's
          nothing to do. To use messages here again, set it up as a new device.
          <div className="sec-banner__actions">
            <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>
              Set up again
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!newDevices.length || pathname === "/settings/devices") return null;
  const d = newDevices[newDevices.length - 1];
  return (
    <div className="sec-banner sec-banner--warn signin-notice" role="status">
      <ShieldAlert size={18} aria-hidden="true" />
      <div className="sec-banner__text">
        <strong>New sign-in to your messages:</strong> {d.name}, {timeAgoLong(d.createdAt)}
        {newDevices.length > 1 ? ` (and ${newDevices.length - 1} more)` : ""}. If this wasn't you, remove it and change your password.
        <div className="sec-banner__actions">
          <Link to="/settings/devices" className="btn btn--secondary btn--sm">
            Review devices
          </Link>
          <Button size="sm" variant="ghost" onClick={acknowledgeDevices}>
            It was me
          </Button>
        </div>
      </div>
    </div>
  );
}
