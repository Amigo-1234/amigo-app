import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Check, Trophy, UsersRound } from "lucide-react";
import { dataSource, type World } from "../../data";
import { useViewer } from "../../state/session";
import { useToast } from "../../state/toast";
import { Avatar } from "../../ui/Avatar";
import { Button } from "../../ui/Button";
import { countdown, statusLine, worldStatus } from "./time";
import { worldErrorText } from "./useWorlds";

const fmt = new Intl.NumberFormat();

/** "LIVE" / "Starts in 3h 10m" / "Ended …" — the dot and the word carry status, not color alone. */
export function StatusPill({ world, now }: { world: World; now: number }) {
  const s = statusLine(world, now);
  return (
    <span className={`world-status world-status--${s.status}`}>
      {s.status === "live" && (
        <span className="world-status__live">
          <span className="world-status__dot" aria-hidden="true" />
          Live
        </span>
      )}
      <span aria-hidden="true">{s.text}</span>
      <span className="visually-hidden">{s.spoken}</span>
    </span>
  );
}

export function WorldCover({ world, size }: { world: World; size: "card" | "hero" }) {
  const [failed, setFailed] = useState(false);
  // Fallback: a gradient derived from the slug, so every World has a distinct look without an image.
  let h = 0;
  for (const c of world.slug) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (
    <div className={`world-cover world-cover--${size}`} style={{ "--world-hue": h } as React.CSSProperties} aria-hidden="true">
      {world.coverUrl && !failed && <img src={world.coverUrl} alt="" loading={size === "card" ? "lazy" : "eager"} decoding="async" onError={() => setFailed(true)} />}
    </div>
  );
}

export function Participants({ world }: { world: World }) {
  return (
    <span className="world-people">
      {world.participantsPreview.length > 0 && (
        <span className="world-people__faces" aria-hidden="true">
          {world.participantsPreview.map((p) => (
            <Avatar key={p.id} name={p.name} src={p.avatarUrl} seed={p.id} size="xs" />
          ))}
        </span>
      )}
      <UsersRound size={15} aria-hidden="true" className="world-people__icon" />
      <span>
        {fmt.format(world.participantCount)} {world.participantCount === 1 ? "person" : "people"}
        {world.viewerJoined ? " · you're in" : ""}
      </span>
    </span>
  );
}

/** Join / leave. Joining is allowed until the World ends; finished Worlds show no button. */
export function JoinButton({ world, now, size = "md", onChange }: { world: World; now: number; size?: "sm" | "md"; onChange?: () => void }) {
  const viewer = useViewer();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const joined = optimistic ?? world.viewerJoined;
  // Drop the optimistic value once the data agrees.
  useEffect(() => {
    if (optimistic !== null && world.viewerJoined === optimistic) setOptimistic(null);
  }, [optimistic, world.viewerJoined]);
  if (worldStatus(world, now) === "finished") return null;

  const toggle = async () => {
    const next = !joined;
    setBusy(true);
    setOptimistic(next);
    try {
      await (next ? dataSource.worlds!.join(world.id, viewer.id) : dataSource.worlds!.leave(world.id, viewer.id));
      if (next) toast(`You joined ${world.title}`);
      onChange?.();
    } catch (e) {
      setOptimistic(null);
      toast(worldErrorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return joined ? (
    <Button variant="secondary" size={size} onClick={toggle} disabled={busy} icon={<Check size={16} aria-hidden="true" />} aria-label={`Joined ${world.title}. Leave`}>
      Joined
    </Button>
  ) : (
    <Button size={size} onClick={toggle} disabled={busy} aria-label={`Join ${world.title}`}>
      Join World
    </Button>
  );
}

export function WorldCard({ world, now, onChange }: { world: World; now: number; onChange?: () => void }) {
  const status = worldStatus(world, now);
  const comp = world.competition;
  return (
    <li className={`world-card world-card--${status}`}>
      <Link to={`/worlds/${world.slug}`} className="world-card__link">
        <WorldCover world={world} size="card" />
        <span className="world-card__body">
          <StatusPill world={world} now={now} />
          <span className="world-card__title">{world.title}</span>
          <span className="world-card__tagline">{world.tagline}</span>
          {comp && (
            <span className="world-card__comp">
              <Trophy size={14} aria-hidden="true" />
              Competition
              {status === "live" && now < comp.entriesCloseAt.getTime() && <> · entries close in {countdown(comp.entriesCloseAt.getTime() - now)}</>}
            </span>
          )}
          <Participants world={world} />
        </span>
      </Link>
      <div className="world-card__action">
        <JoinButton world={world} now={now} size="sm" onChange={onChange} />
      </div>
    </li>
  );
}
