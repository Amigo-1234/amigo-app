import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { ArrowLeft, CircleAlert, Gift, Orbit, PenLine, Timer, Trophy } from "lucide-react";
import { Composer } from "../features/composer/Composer";
import { describeError } from "../features/feed/errors";
import { FeedFooter } from "../features/feed/FeedFooter";
import { PostCard } from "../features/posts/PostCard";
import { FeedSkeleton } from "../features/posts/PostSkeleton";
import { countdown, countdownLong, entriesOpen, formatWhen, useNow, worldStatus } from "../features/worlds/time";
import { useLeaderboard, useWorld, useWorldChat, useWorldPosts } from "../features/worlds/useWorlds";
import { JoinButton, Participants, StatusPill, WorldCover } from "../features/worlds/WorldBits";
import { Leaderboard, PeopleHere, scoringText, WinnerCard, WorldChat } from "../features/worlds/WorldParts";
import { ScreenHeader } from "../shell/ScreenHeader";
import { useViewer } from "../state/session";
import { Button, IconButton } from "../ui/Button";
import { Skeleton } from "../ui/Skeleton";
import { StateMessage } from "../ui/StateMessage";
import type { World } from "../data";
import "../features/worlds/Worlds.css";

type Tab = "live" | "entries" | "leaderboard" | "chat";

export default function WorldScreen() {
  const { slug = "" } = useParams();
  const navigate = useNavigate();
  const { state, retry } = useWorld(slug);
  const back = () => (window.history.state?.idx > 0 ? navigate(-1) : navigate("/worlds"));
  const world = state.status === "ready" ? state.data : null;

  return (
    <>
      <ScreenHeader
        title={world?.title ?? "World"}
        leading={
          <IconButton label="Back" onClick={back} className="back-btn">
            <ArrowLeft size={22} />
          </IconButton>
        }
      />
      {state.status === "loading" && (
        <div className="world-hero" aria-busy="true" aria-label="Loading World">
          <Skeleton width="100%" height={160} radius={0} />
          <div className="world-hero__body">
            <Skeleton width={120} height={14} />
            <Skeleton width={240} height={26} />
            <Skeleton width="80%" height={14} />
          </div>
        </div>
      )}
      {state.status === "error" && (
        <StateMessage tone="error" icon={<CircleAlert size={24} />} {...describeError(state.error, "this World")}
          action={<Button variant="secondary" onClick={retry}>Try again</Button>} />
      )}
      {state.status === "ready" && !world && (
        <StateMessage icon={<Orbit size={24} />} title="This World doesn't exist" body="The link may be wrong, or the event was removed."
          action={<Button variant="secondary" onClick={() => navigate("/worlds")}>See all Worlds</Button>} />
      )}
      {world && <WorldView world={world} />}
    </>
  );
}

function WorldView({ world }: { world: World }) {
  const now = useNow(1000);
  const viewer = useViewer();
  const [params] = useSearchParams();
  const status = worldStatus(world, now);
  const comp = world.competition;
  const tabs: { id: Tab; label: string }[] = [
    { id: "live", label: "Live" },
    ...(comp ? [{ id: "entries" as Tab, label: "Entries" }, { id: "leaderboard" as Tab, label: "Leaderboard" }] : []),
    { id: "chat", label: "Chat" },
  ];
  const wanted = params.get("tab") as Tab | null;
  const tab: Tab = tabs.some((t) => t.id === wanted) ? wanted! : "live";
  const board = useLeaderboard(comp ? world.id : null);
  const rows = board.state.status === "ready" ? board.state.data : [];
  const mine = rows.find((r) => r.person.id === viewer.id);
  const winner = status === "finished" && rows[0] ? rows[0] : null;

  return (
    <>
      <section className="world-hero" aria-labelledby="world-title">
        <WorldCover world={world} size="hero" />
        <div className="world-hero__body">
          <StatusPill world={world} now={now} />
          <h2 id="world-title" className="world-hero__title">
            {world.title}
          </h2>
          <p className="world-hero__tagline">{world.tagline}</p>
          {world.description && <p className="world-hero__desc">{world.description}</p>}
          <p className="world-hero__when">
            {formatWhen(world.startsAt)} – {formatWhen(world.endsAt)}
          </p>
          <div className="world-hero__row">
            <Participants world={world} />
            <JoinButton world={world} now={now} />
          </div>
          {comp && (
            <dl className="world-comp">
              <div>
                <dt>
                  <Timer size={15} aria-hidden="true" /> Entries
                </dt>
                <dd>
                  {status === "upcoming"
                    ? `Open at the start, close ${formatWhen(comp.entriesCloseAt)}`
                    : entriesOpen(world, now)
                      ? <span aria-label={`Entries close in ${countdownLong(comp.entriesCloseAt.getTime() - now)}`}>Close in {countdown(comp.entriesCloseAt.getTime() - now)}</span>
                      : "Closed"}
                  {` · ${comp.entryLimit} per person`}
                </dd>
              </div>
              <div>
                <dt>
                  <Trophy size={15} aria-hidden="true" /> Scoring
                </dt>
                <dd>{scoringText(world)}</dd>
              </div>
              {comp.prize && (
                <div>
                  <dt>
                    <Gift size={15} aria-hidden="true" /> Prize
                  </dt>
                  <dd>{comp.prize}</dd>
                </div>
              )}
            </dl>
          )}
        </div>
      </section>

      {winner && <WinnerCard winner={winner} />}

      <nav className="tabs world-tabs" aria-label="World sections">
        {tabs.map((t) => (
          <Link
            key={t.id}
            to={t.id === "live" ? "?" : `?tab=${t.id}`}
            replace
            className="tab tab--link"
            aria-current={tab === t.id ? "page" : undefined}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === "live" && <LiveTab world={world} now={now} />}
      {tab === "entries" && comp && <EntriesTab world={world} now={now} entriesUsed={mine?.entries ?? 0} />}
      {tab === "leaderboard" && comp && (
        <>
          <p className="world-note">
            {status === "finished" ? "Final results." : status === "live" ? "Live standings — updates as people react." : "Standings appear once entries come in."}{" "}
            {scoringText(world)}.
          </p>
          <Leaderboard rows={rows} finished={status === "finished"} state={board.state.status} onRetry={board.retry} />
        </>
      )}
      {tab === "chat" && <ChatTab world={world} live={status === "live"} />}
    </>
  );
}

/** What a non-participant sees instead of a composer. */
function Callout({ world, now, entry }: { world: World; now: number; entry?: boolean }) {
  const status = worldStatus(world, now);
  if (status === "finished") return <p className="world-note">This World has ended. Posts stay here to read.</p>;
  if (status === "upcoming")
    return (
      <p className="world-note">
        Opens in {countdown(world.startsAt.getTime() - now)}.{" "}
        {world.viewerJoined ? "You're in — you'll be able to post when it starts." : "Join now to be in from the start."}
      </p>
    );
  if (!world.viewerJoined) return <p className="world-note">Join this World to {entry ? "submit an entry" : "post"} and chat.</p>;
  return null;
}

function PostList({ worldId, entriesOnly, emptyTitle, emptyBody }: { worldId: string; entriesOnly: boolean; emptyTitle: string; emptyBody: string }) {
  const posts = useWorldPosts(worldId, entriesOnly);
  if (posts.state.status === "error" && !posts.page)
    return <StateMessage tone="error" icon={<CircleAlert size={24} />} {...describeError(posts.state.error)} action={<Button variant="secondary" onClick={posts.retry}>Try again</Button>} />;
  if (!posts.page) return <FeedSkeleton />;
  if (posts.page.posts.length === 0) return <StateMessage icon={<PenLine size={24} />} title={emptyTitle} body={emptyBody} />;
  return (
    <>
      <div role="feed" aria-label={entriesOnly ? "Entries" : "Posts in this World"}>
        {posts.page.posts.map((p) => (
          <PostCard key={p.id} post={p} inWorld />
        ))}
      </div>
      <FeedFooter hasMore={posts.page.hasMore} loading={posts.loadingMore} onMore={posts.loadMore} endLabel="" />
    </>
  );
}

function LiveTab({ world, now }: { world: World; now: number }) {
  const live = worldStatus(world, now) === "live";
  return (
    <>
      {live && world.viewerJoined ? (
        <div className="world-composer">
          <Composer variant="inline" world={{ id: world.id, entry: false, placeholder: `Say something in ${world.title}…`, submitLabel: "Post" }} />
        </div>
      ) : (
        <Callout world={world} now={now} />
      )}
      <PeopleHere world={world} />
      <PostList worldId={world.id} entriesOnly={false} emptyTitle="Nothing posted yet" emptyBody={live ? "Be the first to post in this World." : "Posts show up here once the World is live."} />
    </>
  );
}

function EntriesTab({ world, now, entriesUsed }: { world: World; now: number; entriesUsed: number }) {
  const comp = world.competition!;
  const open = entriesOpen(world, now);
  const left = comp.entryLimit - entriesUsed;
  return (
    <>
      {open && world.viewerJoined && left > 0 && (
        <div className="world-composer">
          <Composer
            variant="inline"
            world={{ id: world.id, entry: true, placeholder: comp.entryLimit === 1 ? "Your entry — you get one, make it count…" : `Your entry (${left} left)…`, submitLabel: "Submit entry" }}
          />
        </div>
      )}
      {open && world.viewerJoined && left <= 0 && <p className="world-note">You've used your entry. Now get people reacting to it.</p>}
      {worldStatus(world, now) === "live" && !open && <p className="world-note">Entries are closed. Likes and replies still count until the World ends.</p>}
      <Callout world={world} now={now} entry />
      <PostList worldId={world.id} entriesOnly emptyTitle="No entries yet" emptyBody={open ? "Be the first to enter." : "Entries open when the World starts."} />
    </>
  );
}

function ChatTab({ world, live }: { world: World; live: boolean }) {
  const chat = useWorldChat(world.id);
  return (
    <WorldChat
      world={world}
      live={live}
      messages={chat.state.status === "ready" ? chat.state.data : []}
      state={chat.state.status}
      onRetry={chat.retry}
    />
  );
}
