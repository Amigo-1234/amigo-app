import { BadgeCheck } from "lucide-react";
import "./VerifiedBadge.css";

/** The verified mark beside a name. Shape + label, not color alone. Renders nothing for unverified people. */
export function VerifiedBadge({ verified, size = 16 }: { verified?: boolean; size?: number }) {
  if (!verified) return null;
  return (
    <span className="verified-badge" role="img" aria-label="Verified" title="Verified by Amigo">
      <BadgeCheck size={size} strokeWidth={2.4} aria-hidden="true" />
    </span>
  );
}
