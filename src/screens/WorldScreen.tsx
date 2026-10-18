import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { ArrowLeft, ChevronDown, CircleAlert, Flag, Gift, Orbit, PenLine, Settings2, Star, Timer, Trophy } from "lucide-react";
import { useIsAdmin } from "../features/admin/useAdmin";
import { CancelWorld, WorldEditor } from "../features/worlds/WorldEditor";
import { useToast } from "../state/toast";
import { Composer } from "../features/composer/Composer";
import { describeError } from "../features/feed/errors";
import { FeedFooter } from "../features/feed/FeedFooter";
import { PostCard } from "../features/posts/PostCard";
import { FeedSkeleton } from "../features/posts/PostSkeleton";
import { countdown, countdownLong, entriesOpen, formatSpan, formatWhen, useNow, worldStatus } from "../features/worlds/time";
import { useLeaderboard, useWorld, useWorldChat, useWorldPosts } from "../features/worlds/useWorlds";
import { JoinButton, Participants, StatusPill, WorldCover } from "../features/worlds/WorldBits";
import { Leaderboard, PeopleHere, scoringText, WinnerCard, WorldChat } from "../features/worlds/WorldParts";
import { ScreenHeader } from "../shell/ScreenHeader";
import { useViewer } from "../state/session";
import { Button, IconButton } from "../ui/Button";
import { Skeleton } from "../ui/Skeleton";
import { StateMessage } from "../ui/StateMessage";
import { dataSource, type World } from "../data";
import { ReportForm } from "../features/posts/PostOptions";
import { Sheet } from "../ui/Sheet";
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
        actions={
          world ? (
            <>
              <WorldAdminButton world={world} onChanged={retry} />
              {dataSource.postTools && <WorldReportButton worldId={world.id} title={world.title} />}
            </>
          ) : undefined
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

  // Switching tabs brings the tab content into view instead of leaving it under the hero.
  const tabsRef = useRef<HTMLElement>(null);
  const firstTab = useRef(true);
  useEffect(() => {
    if (firstTab.current) {
      firstTab.current = false;
      return;
    }
    const el = tabsRef.current;
    if (el && el.getBoundingClientRect().top > window.innerHeight * 0.4) {
      window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top - el.offsetHeight - 8, behavior: "smooth" });
    }
  }, [tab]);

  return (
    <>
      <section className="world-hero" aria-labelledby="world-title">
        <WorldCover world={world} size="hero" />
        <div className="world-hero__body">
          <StatusPill world={world} now={now} />
          {status === "cancelled" && (
            <p className="world-cancelled" role="status">
              This World was cancelled{world.cancelReason ? `: ${world.cancelReason}` : "."} Posts made in it stay here to read.
            </p>
          )}
          <h2 id="world-title" className="world-hero__title">
            {world.title}
          </h2>
          <p className="world-hero__tagline">{world.tagline}</p>
          {/* Details only on the Live tab, so Chat/Entries/Leaderboard start near the top on phones. */}
          {tab === "live" && (
            <>
              {world.description && <Description text={world.description} />}
              <p className="world-hero__when">{formatSpan(world.startsAt, world.endsAt)}</p>
            </>
          )}
          <div className="world-hero__row">
            <Participants world={world} />
            <JoinButton world={world} now={now} />
          </div>
          {comp && (
            <details className="world-comp">
              <summary>
                <Trophy size={16} aria-hidden="true" />
                <span className="world-comp__summary">
                  <strong>Competition</strong>
                  {" · "}
                  {status === "upcoming"
                    ? "entries open at the start"
                    : entriesOpen(world, now)
                      ? <span aria-label={`entries close in ${countdownLong(comp.entriesCloseAt.getTime() - now)}`}>entries close in {countdown(comp.entriesCloseAt.getTime() - now)}</span>
                      : status === "live" ? "entries closed" : "finished"}
                </span>
                <span className="world-comp__more">How it works <ChevronDown size={16} aria-hidden="true" /></span>
              </summary>
            <dl>
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
            </details>
          )}
        </div>
      </section>

      {winner && <WinnerCard winner={winner} />}

      <nav className="tabs world-tabs" aria-label="World sections" ref={tabsRef}>
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
  if (status === "cancelled") return null;
  if (status === "finished") return <p className="world-note">This World has ended. Posts stay here to read.</p>;
  if (status === "upcoming")
    return (
      <p className="world-note">
        Opens in {countdown(world.startsAt.getTime() - now)}.{" "}
        {world.viewerJoined ? "You're in — you'll be able to post when it starts." : "Join now to be in from the first minute."}
      </p>
    );
  if (!world.viewerJoined) return <JoinPrompt world={world} now={now} entry={entry} />;
  return null;
}

/** Non-members of a live World: say what joining gets you (the Join button sits just above in the hero). */
function JoinPrompt({ world, now, entry }: { world: World; now: number; entry?: boolean }) {
  const canEnter = entriesOpen(world, now);
  const what = entry ? "submit an entry, post and chat" : canEnter ? "post, chat and enter the competition" : "post and chat";
  return (
    <div className="join-prompt">
      <p>
        <strong>You're looking in.</strong> Join to {what} with {world.participantCount.toLocaleString()} people.
      </p>
    </div>
  );
}

function Description({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 140;
  return (
    <p className={`world-hero__desc${long && !open ? " is-clamped" : ""}`}>
      {text}
      {long && (
        <button type="button" className="world-hero__more" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? "Less" : "More"}
        </button>
      )}
    </p>
  );
}

function PostList({ worldId, entriesOnly, emptyTitle, emptyBody, picks }: { worldId: string; entriesOnly: boolean; emptyTitle: string; emptyBody: string; picks?: Picks }) {
  const posts = useWorldPosts(worldId, entriesOnly);
  if (posts.state.status === "error" && !posts.page)
    return <StateMessage tone="error" icon={<CircleAlert size={24} />} {...describeError(posts.state.error)} action={<Button variant="secondary" onClick={posts.retry}>Try again</Button>} />;
  if (!posts.page) return <FeedSkeleton />;
  if (posts.page.posts.length === 0) return <StateMessage icon={<PenLine size={24} />} title={emptyTitle} body={emptyBody} />;
  return (
    <>
      <div role="feed" aria-label={entriesOnly ? "Entries" : "Posts in this World"}>
        {posts.page.posts.map((p) =>
          picks ? (
            <div key={p.id} className="world-entry">
              <PostCard post={p} inWorld />
              <div className="world-entry__admin">
                <Button size="sm" variant={picks.ids.has(p.id) ? "secondary" : "ghost"} icon={<Star size={15} aria-hidden="true" />} onClick={() => picks.toggle(p.id)}>
                  {picks.ids.has(p.id) ? "Amigo pick ✓ (remove)" : "Make Amigo pick"}
                </Button>
              </div>
            </div>
          ) : (
            <PostCard key={p.id} post={p} inWorld />
          ),
        )}
      </div>
      <FeedFooter hasMore={posts.page.hasMore} loading={posts.loadingMore} onMore={posts.loadMore} endLabel="" />
    </>
  );
}

function LiveTab({ world, now }: { world: World; now: number }) {
  const live = worldStatus(world, now) === "live";
  return (
    <>
      {live && world.viewerJoined && entriesOpen(world, now) && (
        <p className="world-note world-note--nudge">
          Entries close in {countdown(world.competition!.entriesCloseAt.getTime() - now)} —{" "}
          <Link to="?tab=entries" replace>
            submit yours
          </Link>
        </p>
      )}
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
  const picks = useAdminPicks(world, now);
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
      <PostList
        worldId={world.id}
        entriesOnly
        picks={picks ?? undefined}
        emptyTitle="No entries yet"
        emptyBody={open ? "Be the first to enter." : "Entries open when the World starts."}
      />
    </>
  );
}

function ChatTab({ world, live }: { world: World; live: boolean }) {
  const chat = useWorldChat(world.id);
  const isAdmin = useIsAdmin();
  const toast = useToast();
  const admin = isAdmin ? dataSource.worlds?.admin : undefined;
  return (
    <WorldChat
      world={world}
      live={live}
      onRemove={
        admin
          ? async (id) => {
              await admin.removeChatMessage(id).then(
                () => (toast("Message removed"), chat.retry()),
                () => toast("Couldn't remove it. Try again.", "error"),
              );
            }
          : undefined
      }
      messages={chat.state.status === "ready" ? chat.state.data : []}
      state={chat.state.status}
      onRetry={chat.retry}
    />
  );
}

type Picks = { ids: Set<string>; toggle: (postId: string) => void };

/** Admins, in a running competition: which entries Amigo picked, and toggling them. */
function useAdminPicks(world: World, now: number): Picks | null {
  const isAdmin = useIsAdmin();
  const toast = useToast();
  const admin = dataSource.worlds?.admin;
  const st = worldStatus(world, now);
  const enabled = !!isAdmin && !!admin && !!world.competition && (st === "live" || st === "upcoming") && world.competition.scoring.hostPick > 0;
  const [ids, setIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (enabled) void admin!.picks(world.id).then((p) => setIds(new Set(p)), () => undefined);
  }, [enabled, admin, world.id]);
  if (!enabled) return null;
  return {
    ids,
    toggle: (postId) => {
      const on = !ids.has(postId);
      setIds((s) => {
        const n = new Set(s);
        if (on) n.add(postId);
        else n.delete(postId);
        return n;
      });
      admin!.setHostPick(world.id, postId, on).then(
        () => toast(on ? "Marked as an Amigo pick" : "Amigo pick removed"),
        (e) => {
          toast(e instanceof Error ? e.message : "Couldn't change it. Try again.", "error");
          setIds((s) => {
            const n = new Set(s);
            if (on) n.delete(postId);
            else n.add(postId);
            return n;
          });
        },
      );
    },
  };
}

/** Admins: edit or cancel this World from its own page. */
function WorldAdminButton({ world, onChanged }: { world: World; onChanged: () => void }) {
  const isAdmin = useIsAdmin();
  const now = useNow(30_000);
  const navigate = useNavigate();
  const [open, setOpen] = useState<null | "menu" | "edit" | "cancel">(null);
  const st = worldStatus(world, now);
  if (!isAdmin || !dataSource.worlds?.admin || (st !== "upcoming" && st !== "live")) return null;
  return (
    <>
      <IconButton label={`Manage ${world.title}`} onClick={() => setOpen("menu")}>
        <Settings2 size={20} />
      </IconButton>
      <Sheet open={open === "menu"} onClose={() => setOpen(null)} label="Manage World">
        <div className="sheet-menu">
          <button className="sheet-menu__item" onClick={() => setOpen("edit")}>
            <PenLine size={20} aria-hidden="true" /> Edit World
          </button>
          <button className="sheet-menu__item sheet-menu__item--danger" onClick={() => setOpen("cancel")}>
            <CircleAlert size={20} aria-hidden="true" /> Cancel World
          </button>
          <Button variant="ghost" block onClick={() => setOpen(null)}>
            Close
          </Button>
        </div>
      </Sheet>
      <Sheet open={open === "edit"} onClose={() => setOpen(null)} label="Edit World" fullscreenOnMobile>
        {open === "edit" && (
          <WorldEditor
            world={world}
            onDone={(saved) => {
              setOpen(null);
              if (!saved) return;
              if (saved.slug !== world.slug) navigate(`/worlds/${saved.slug}`, { replace: true });
              else onChanged();
            }}
          />
        )}
      </Sheet>
      <Sheet open={open === "cancel"} onClose={() => setOpen(null)} label="Cancel World">
        {open === "cancel" && (
          <CancelWorld
            world={world}
            onDone={(done) => {
              setOpen(null);
              if (done) onChanged();
            }}
          />
        )}
      </Sheet>
    </>
  );
}

function WorldReportButton({ worldId, title }: { worldId: string; title: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton label={`Report ${title}`} onClick={() => setOpen(true)}>
        <Flag size={20} />
      </IconButton>
      <Sheet open={open} onClose={() => setOpen(false)} label="Report World">
        {open && <ReportForm target="world" targetId={worldId} what="this World" onDone={() => setOpen(false)} />}
      </Sheet>
    </>
  );
}
