import { limitText } from "../feed/errors";
import { useEffect, useState } from "react";
import { dataSource } from "../../data";
import { useViewer } from "../../state/session";
import { useToast } from "../../state/toast";
import { Button } from "../../ui/Button";

/**
 * Optimistic follow toggle, from both directions of the relationship:
 *   Follow       neither follows the other (or only you'd start it)
 *   Follow Back  they follow you, you don't follow them
 *   Following    you follow them (whether or not they follow you); under a
 *                mouse it reads "Unfollow" so the destructive action is explicit
 *                (its accessible name always says "Unfollow …")
 * Nothing on your own profile. One request at a time; a failure puts the
 * previous state back.
 */
export function FollowButton({
  personId,
  personName,
  following: initial,
  followsYou = false,
  size = "sm",
  onChange,
}: {
  personId: string;
  personName: string;
  following: boolean;
  /** They follow the viewer: an unfollowed button reads "Follow Back". */
  followsYou?: boolean;
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
    if (busy) return;
    const next = !following;
    setFollowing(next);
    setHover(false); // show the new state ("Following"), not the hover hint
    setBusy(true);
    try {
      if (next) await dataSource.follow(viewer.id, personId);
      else await dataSource.unfollow(viewer.id, personId);
      onChange?.(next);
    } catch (e) {
      setFollowing(!next);
      toast(limitText(e) ?? (next ? `Couldn't follow ${personName}. Try again.` : `Couldn't unfollow ${personName}. Try again.`), "error");
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
      // "Unfollow" hint for a real mouse hover only: a tap on a phone also fires
      // enter/focus events, which would replace "Following" right after tapping.
      onPointerEnter={(e) => e.pointerType === "mouse" && setHover(true)}
      onPointerLeave={() => setHover(false)}
      disabled={busy}
      aria-pressed={following}
      aria-label={`${following ? "Unfollow" : followsYou ? "Follow back" : "Follow"} ${personName}`}
      className="follow-btn"
    >
      {following ? (hover ? "Unfollow" : "Following") : followsYou ? "Follow Back" : "Follow"}
    </Button>
  );
}
