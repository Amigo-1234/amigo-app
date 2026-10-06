import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { CircleAlert, MessageCircle, Send, Trophy } from "lucide-react";
import { dataSource, WORLD_CHAT_MAX_LENGTH, type LeaderboardEntry, type PersonSummary, type World, type WorldChatMessage } from "../../data";
import { timeAgo, timeAgoLong } from "../../lib/time";
import { useViewer } from "../../state/session";
import { useToast } from "../../state/toast";
import { Avatar } from "../../ui/Avatar";
import { Button } from "../../ui/Button";
import { Skeleton } from "../../ui/Skeleton";
import { StateMessage } from "../../ui/StateMessage";
import { describeError } from "../feed/errors";
import { FollowButton } from "../profile/FollowButton";
import { profileHref } from "../profile/links";
import { PersonRow } from "../profile/PersonRow";
import { worldErrorText } from "./useWorlds";

const pts = (n: number) => `${n} ${n === 1 ? "pt" : "pts"}`;

export function scoringText(w: World): string {
  const s = w.competition!.scoring;
  const parts = [`Like ${pts(s.reaction)}`, `Reply ${pts(s.reply)}`];
  if (s.hostPick > 0) parts.push(`Amigo pick +${s.hostPick}`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------- leaderboard

export function Leaderboard({
  rows,
  finished,
  onRetry,
  state,
}: {
  rows: LeaderboardEntry[];
  finished: boolean;
  state: "loading" | "ready" | "error";
  onRetry: () => void;
}) {
  const viewer = useViewer();
  if (state === "loading") return <ListSkeleton label="Loading leaderboard" />;
  if (state === "error")
    return <StateMessage tone="error" icon={<CircleAlert size={24} />} {...describeError(null, "the leaderboard")} action={<Button variant="secondary" onClick={onRetry}>Try again</Button>} />;
  if (rows.length === 0)
    return <StateMessage icon={<Trophy size={24} />} title="No entries yet" body={finished ? "Nobody entered this one." : "Submit an entry to get on the board."} />;
  return (
    <ol className="leaderboard" aria-label={finished ? "Final results" : "Live standings"}>
      {rows.map((r) => {
        const href = profileHref(r.person.handle);
        const me = r.person.id === viewer.id;
        return (
          <li key={r.person.id} className={`leaderboard__row${r.rank <= 3 ? ` is-top is-top-${r.rank}` : ""}${me ? " is-me" : ""}`}>
            <span className="leaderboard__rank" aria-label={`Rank ${r.rank}`}>
              {r.rank}
            </span>
            {href ? (
              <Link to={href} className="leaderboard__person">
                <Avatar name={r.person.name} src={r.person.avatarUrl} seed={r.person.id} size="sm" />
                <span className="leaderboard__names">
                  <span className="leaderboard__name">
                    {r.person.name}
                    {me && <span className="leaderboard__you"> (you)</span>}
                  </span>
                  <span className="leaderboard__handle">@{r.person.handle}</span>
                </span>
              </Link>
            ) : (
              <span className="leaderboard__person">{r.person.name}</span>
            )}
            <span className="leaderboard__points">
              <strong>{r.points}</strong> {r.points === 1 ? "pt" : "pts"}
            </span>
            {!me && <FollowButton personId={r.person.id} personName={r.person.name} following={r.viewerFollows} />}
          </li>
        );
      })}
    </ol>
  );
}

/** Final winner state for a finished competition. */
export function WinnerCard({ winner }: { winner: LeaderboardEntry }) {
  const viewer = useViewer();
  const href = profileHref(winner.person.handle);
  const me = winner.person.id === viewer.id;
  return (
    <section className="winner" aria-label="Winner">
      <Trophy size={28} aria-hidden="true" className="winner__icon" />
      <Avatar name={winner.person.name} src={winner.person.avatarUrl} seed={winner.person.id} size="lg" />
      <div className="winner__text">
        <span className="winner__label">Winner</span>
        {href ? (
          <Link to={href} className="winner__name">
            {winner.person.name}
          </Link>
        ) : (
          <span className="winner__name">{winner.person.name}</span>
        )}
        <span className="winner__meta">
          @{winner.person.handle} · {pts(winner.points)}
        </span>
      </div>
      {!me && <FollowButton personId={winner.person.id} personName={winner.person.name} following={winner.viewerFollows} />}
    </section>
  );
}

// ---------------------------------------------------------------- people

/** "Meet people here": participants, people you don't follow yet first. */
export function PeopleHere({ world }: { world: World }) {
  const viewer = useViewer();
  const [people, setPeople] = useState<PersonSummary[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    dataSource.worlds!.listParticipants(world.id, viewer.id, 5).then((p) => !cancelled && setPeople(p)).catch(() => !cancelled && setPeople([]));
    return () => {
      cancelled = true;
    };
  }, [world.id, viewer.id, world.participantCount]);
  if (!people || people.length === 0) return null;
  return (
    <section className="people-here" aria-labelledby={`people-${world.id}`}>
      <h3 id={`people-${world.id}`} className="people-here__title">
        Meet people here
      </h3>
      <ul className="people-here__list">
        {people.map((p) => (
          <PersonRow key={p.id} person={p} />
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------- chat

export function WorldChat({
  world,
  live,
  messages,
  state,
  onRetry,
}: {
  world: World;
  live: boolean;
  messages: WorldChatMessage[];
  state: "loading" | "ready" | "error";
  onRetry: () => void;
}) {
  const viewer = useViewer();
  const toast = useToast();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const stick = useRef(true);

  // Follow new messages when the reader is at the bottom; don't yank them if they scrolled up.
  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const canChat = live && world.viewerJoined;
  const send = async (e: FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await dataSource.worlds!.sendChat(world.id, viewer, body);
      setText("");
      stick.current = true;
    } catch (err) {
      toast(worldErrorText(err), "error");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="world-chat">
      {state === "loading" && <ListSkeleton label="Loading chat" />}
      {state === "error" && (
        <StateMessage tone="error" icon={<CircleAlert size={24} />} {...describeError(null, "chat")} action={<Button variant="secondary" onClick={onRetry}>Try again</Button>} />
      )}
      {state === "ready" && messages.length === 0 && (
        <StateMessage icon={<MessageCircle size={24} />} title="No messages yet" body={live ? "Say hi to the room." : "Chat opens when the World goes live."} />
      )}
      {state === "ready" && messages.length > 0 && (
        <ol
          ref={listRef}
          className="world-chat__list"
          role="log"
          aria-live="polite"
          aria-label={`Chat in ${world.title}`}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          {messages.map((m) => {
            const href = profileHref(m.author.handle);
            const mine = m.author.id === viewer.id;
            return (
              <li key={m.id} className={`chat-msg${mine ? " chat-msg--mine" : ""}`}>
                {href ? (
                  <Link to={href} className="chat-msg__avatar" tabIndex={-1} aria-hidden="true">
                    <Avatar name={m.author.name} src={m.author.avatarUrl} seed={m.author.id} size="sm" />
                  </Link>
                ) : (
                  <Avatar name={m.author.name} src={m.author.avatarUrl} seed={m.author.id} size="sm" />
                )}
                <div className="chat-msg__body">
                  <span className="chat-msg__meta">
                    {href ? <Link to={href} className="chat-msg__name">{m.author.name}</Link> : <span className="chat-msg__name">{m.author.name}</span>}
                    <time dateTime={m.createdAt.toISOString()} aria-label={timeAgoLong(m.createdAt)}>
                      {timeAgo(m.createdAt)}
                    </time>
                  </span>
                  <p className="chat-msg__text">{m.text}</p>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {canChat ? (
        <form className="world-chat__form" onSubmit={send} aria-label="Send a chat message">
          <label htmlFor="world-chat-input" className="visually-hidden">
            Message
          </label>
          <input
            id="world-chat-input"
            className="world-chat__input"
            value={text}
            maxLength={WORLD_CHAT_MAX_LENGTH}
            onChange={(e) => setText(e.target.value)}
            placeholder="Say something…"
            autoComplete="off"
            enterKeyHint="send"
          />
          <Button type="submit" size="sm" disabled={!text.trim() || sending} aria-label="Send" icon={<Send size={16} aria-hidden="true" />}>
            Send
          </Button>
        </form>
      ) : (
        <p className="world-chat__note">
          {live ? "Join this World to chat." : messages.length ? "Chat has closed." : ""}
        </p>
      )}
    </div>
  );
}

function ListSkeleton({ label }: { label: string }) {
  return (
    <ul className="list-skeleton" aria-label={label} aria-busy="true">
      {[0, 1, 2, 3].map((i) => (
        <li key={i} aria-hidden="true">
          <Skeleton width={36} height={36} radius="50%" />
          <span style={{ display: "grid", gap: 6, flex: 1 }}>
            <Skeleton width={140} height={12} />
            <Skeleton width={200} height={10} />
          </span>
        </li>
      ))}
    </ul>
  );
}
