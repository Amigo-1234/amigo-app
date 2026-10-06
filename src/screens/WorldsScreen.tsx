import { CircleAlert, Orbit } from "lucide-react";
import { describeError } from "../features/feed/errors";
import { useNow, worldStatus } from "../features/worlds/time";
import { useWorldList } from "../features/worlds/useWorlds";
import { WorldCard } from "../features/worlds/WorldBits";
import { ScreenHeader } from "../shell/ScreenHeader";
import { Button } from "../ui/Button";
import { Skeleton } from "../ui/Skeleton";
import { StateMessage } from "../ui/StateMessage";
import type { World } from "../data";
import "../features/worlds/Worlds.css";

export default function WorldsScreen() {
  const { state, retry, refresh } = useWorldList();
  const now = useNow(1000);

  const sections =
    state.status === "ready"
      ? (() => {
          const by = (s: string) => state.data.filter((w) => worldStatus(w, now) === s);
          const live = by("live").sort((a, b) => a.endsAt.getTime() - b.endsAt.getTime());
          const upcoming = by("upcoming").sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
          const finished = by("finished").sort((a, b) => b.endsAt.getTime() - a.endsAt.getTime());
          return [
            { id: "live", title: "Live now", worlds: live },
            { id: "upcoming", title: "Upcoming", worlds: upcoming },
            { id: "finished", title: "Finished", worlds: finished },
          ].filter((s) => s.worlds.length > 0) as { id: string; title: string; worlds: World[] }[];
        })()
      : [];

  return (
    <>
      <ScreenHeader title="Worlds" />
      <p className="worlds-intro">Live events on Amigo. Join in, post, chat and meet people — some Worlds are competitions.</p>

      {state.status === "loading" && (
        <ul className="world-list" aria-label="Loading Worlds" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <li key={i} className="world-card" aria-hidden="true">
              <span className="world-card__link">
                <Skeleton width="100%" height={120} radius={12} />
                <span className="world-card__body">
                  <Skeleton width={90} height={12} />
                  <Skeleton width={200} height={18} />
                  <Skeleton width={260} height={12} />
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {state.status === "error" && (
        <StateMessage tone="error" icon={<CircleAlert size={24} />} {...describeError(state.error, "Worlds")}
          action={<Button variant="secondary" onClick={retry}>Try again</Button>} />
      )}

      {state.status === "ready" && sections.length === 0 && (
        <StateMessage icon={<Orbit size={24} />} title="No Worlds yet" body="Amigo hosts live events here. Check back soon." />
      )}

      {sections.map((s) => (
        <section key={s.id} className="world-section" aria-labelledby={`worlds-${s.id}`}>
          <h2 className="world-section__title" id={`worlds-${s.id}`}>
            {s.title}
          </h2>
          <ul className="world-list">
            {s.worlds.map((w) => (
              <WorldCard key={w.id} world={w} now={now} onChange={refresh} />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
