import { RotateCcw } from "lucide-react";
import { usePublishing } from "../state/publishing";
import { Button } from "../ui/Button";
import "./PublishStatusBar.css";

/** Off-Home progress for posts being published (Home shows them inline instead). */
export function PublishStatusBar() {
  const { pending, retry, discard } = usePublishing();
  const sending = pending.filter((p) => p.status === "sending").length;
  const failed = pending.filter((p) => p.status === "failed");
  if (!sending && !failed.length) return null;

  return (
    <div className="publish-bar" role="status" aria-live="polite">
      {failed.length > 0 ? (
        <>
          <span className="publish-bar__text">{failed.length === 1 ? "Your post didn't go through." : `${failed.length} posts didn't go through.`}</span>
          <Button size="sm" variant="primary" icon={<RotateCcw size={15} aria-hidden="true" />} onClick={() => failed.forEach((p) => retry(p.localId))}>
            Retry
          </Button>
          <Button size="sm" variant="ghost" onClick={() => failed.forEach((p) => discard(p.localId))}>
            Discard
          </Button>
        </>
      ) : (
        <>
          <span className="publish-bar__spinner" aria-hidden="true" />
          <span className="publish-bar__text">Posting…</span>
        </>
      )}
    </div>
  );
}
