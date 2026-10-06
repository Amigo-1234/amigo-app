import { useEffect, useState } from "react";
import { dataSource, type PersonSummary } from "../data";
import { useViewer } from "../state/session";
import { PersonRow } from "../features/profile/PersonRow";
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
  const [people, setPeople] = useState<PersonSummary[] | null>(null);
  const [failed, setFailed] = useState(false);

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

  if (failed || (people && people.length === 0)) return null;

  return (
    <section className="rail-card" aria-labelledby="wtf-title">
      <h2 id="wtf-title" className="rail-card__title">
        People to follow
      </h2>
      <ul className="people">
        {people
          ? people.map((p) => <PersonRow key={p.id} person={p} />)
          : [0, 1, 2].map((i) => (
              <li key={i} className="person-row" aria-hidden="true">
                <Skeleton width={42} height={42} radius="50%" />
                <div className="person-row__text" style={{ gap: 6 }}>
                  <Skeleton width={110} height={12} />
                  <Skeleton width={70} height={10} />
                </div>
              </li>
            ))}
      </ul>
    </section>
  );
}
