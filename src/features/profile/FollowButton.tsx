import { useEffect, useState } from "react";
import { dataSource } from "../../data";
import { useViewer } from "../../state/session";
import { useToast } from "../../state/toast";
import { Button } from "../../ui/Button";

/**
 * Optimistic follow toggle. Shows "Following" while followed; on hover/focus
 * it reads "Unfollow" so the destructive action is explicit.
 */
export function FollowButton({
  personId,
  personName,
  following: initial,
  size = "sm",
  onChange,
}: {
  personId: string;
  personName: string;
  following: boolean;
  size?: "sm" | "md";
  onChange?: (following: boolean) => void;
}) {
  const viewer = useViewer();
  const toast = useToast();
  const [following, setFollowing] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [hover, setHover] = useState(false);

  useEffect(() => setFollowing(initial), [initial]);

  if (personId === viewer.id) return null;

  async function toggle() {
    const next = !following;
    setFollowing(next);
    setBusy(true);
    try {
      if (next) await dataSource.follow(viewer.id, personId);
      else await dataSource.unfollow(viewer.id, personId);
      onChange?.(next);
    } catch {
      setFollowing(!next);
      toast(next ? `Couldn't follow ${personName}. Try again.` : `Couldn't unfollow ${personName}. Try again.`, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      size={size}
      variant={following ? (hover ? "danger" : "secondary") : "primary"}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void toggle();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      disabled={busy}
      aria-pressed={following}
      aria-label={`${following ? "Unfollow" : "Follow"} ${personName}`}
      className="follow-btn"
    >
      {following ? (hover ? "Unfollow" : "Following") : "Follow"}
    </Button>
  );
}
