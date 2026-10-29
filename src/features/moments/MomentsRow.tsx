import { Plus } from "lucide-react";
import { useMoments } from "../../state/moments";
import { useViewer } from "../../state/session";
import { Avatar } from "../../ui/Avatar";
import { Skeleton } from "../../ui/Skeleton";
import "./Moments.css";

/** The row of people with Moments at the top of Home. You first (or "Add"), then unseen, newest first. */
export function MomentsRow() {
  const viewer = useViewer();
  const { groups, open, compose } = useMoments();
  const mine = groups?.find((g) => g.isViewer);
  const others = groups?.filter((g) => !g.isViewer) ?? [];

  return (
    <ul className="moments-row" aria-label="Moments">
      <li>
        <span className="moment-bubble">
          <span className={`moment-ring${mine ? "" : " moment-ring--none"}`} style={{ position: "relative" }}>
            <button
              type="button"
              className="moment-avatar-btn"
              onClick={() => (mine ? open(viewer.id) : compose())}
              aria-label={mine ? `Your Moments, ${mine.moments.length}` : "Add a Moment"}
            >
              <Avatar name={viewer.name} src={viewer.avatarUrl} seed={viewer.id} size="lg" />
            </button>
            <button type="button" className="moment-bubble__add" onClick={compose} aria-label="Add a Moment" title="Add a Moment">
              <Plus size={14} strokeWidth={3} aria-hidden="true" />
            </button>
          </span>
          <span className="moment-bubble__name">{mine ? "Your Moment" : "Add yours"}</span>
        </span>
      </li>
      {groups === null
        ? Array.from({ length: 4 }, (_, i) => (
            <li key={i} className="moment-bubble" aria-hidden="true">
              <Skeleton width={64} height={64} radius="50%" />
              <Skeleton width={48} height={10} />
            </li>
          ))
        : others.map((g) => (
            <li key={g.author.id}>
              <button
                type="button"
                className={`moment-bubble${g.hasUnseen ? " is-unseen" : ""}`}
                onClick={() => open(g.author.id)}
                aria-label={`${g.author.name}'s Moments${g.hasUnseen ? ", new" : ""}`}
              >
                <span className={`moment-ring${g.hasUnseen ? " is-unseen" : ""}`}>
                  <Avatar name={g.author.name} src={g.author.avatarUrl} seed={g.author.id} size="lg" />
                </span>
                <span className="moment-bubble__name">{g.author.name.split(" ")[0]}</span>
              </button>
            </li>
          ))}
    </ul>
  );
}
