import { useEffect, useState } from "react";
import { dataSource, type PersonSummary } from "../data";
import { useViewer } from "../state/session";
import { useToast } from "../state/toast";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { Skeleton } from "../ui/Skeleton";

/** Desktop-only companion column. Uses the prototype's real follow graph. */
export function RightRail() {
  return (
    <aside className="rail" aria-label="Suggestions">
      <div className="rail__inner">
        <WhoToFollow />
        <p className="rail__foot">Amigo World · {new Date().getFullYear()}</p>
      </div>
    </aside>
  );
}

function WhoToFollow() {
  const viewer = useViewer();
  const toast = useToast();
  const [people, setPeople] = useState<PersonSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    // Only fetch when the rail is actually visible.
    if (!matchMedia("(min-width: 1200px)").matches) return;
    let cancelled = false;
    dataSource
      .getPeopleSuggestions(viewer.id, 4)
      .then((p) => !cancelled && setPeople(p))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [viewer.id]);

  async function toggle(p: PersonSummary) {
    setBusy(p.id);
    try {
      if (p.viewerFollows) await dataSource.unfollow(viewer.id, p.id);
      else await dataSource.follow(viewer.id, p.id);
      setPeople((list) => list?.map((x) => (x.id === p.id ? { ...x, viewerFollows: !x.viewerFollows } : x)) ?? null);
    } catch {
      toast("Couldn't update follow. Try again.", "error");
    } finally {
      setBusy(null);
    }
  }

  if (failed || (people && people.length === 0)) return null;

  return (
    <section className="rail-card" aria-labelledby="wtf-title">
      <h2 id="wtf-title" className="rail-card__title">
        People to follow
      </h2>
      <ul className="people">
        {people
          ? people.map((p) => (
              <li key={p.id} className="person">
                <Avatar name={p.name} src={p.avatarUrl} seed={p.id} size="md" />
                <div className="person__text">
                  <span className="person__name">{p.name}</span>
                  <span className="person__handle">@{p.handle}</span>
                </div>
                <Button
                  size="sm"
                  variant={p.viewerFollows ? "secondary" : "primary"}
                  loading={busy === p.id}
                  onClick={() => toggle(p)}
                  aria-label={`${p.viewerFollows ? "Unfollow" : "Follow"} ${p.name}`}
                >
                  {p.viewerFollows ? "Following" : "Follow"}
                </Button>
              </li>
            ))
          : [0, 1, 2].map((i) => (
              <li key={i} className="person" aria-hidden="true">
                <Skeleton width={42} height={42} radius="50%" />
                <div className="person__text" style={{ gap: 6 }}>
                  <Skeleton width={110} height={12} />
                  <Skeleton width={70} height={10} />
                </div>
              </li>
            ))}
      </ul>
    </section>
  );
}
