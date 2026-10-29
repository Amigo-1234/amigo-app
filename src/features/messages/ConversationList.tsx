import { NavLink } from "react-router";
import { Check, CheckCheck, CircleAlert, Image as ImageIcon, Mail, SquarePen } from "lucide-react";
import type { Conversation } from "../../data";
import { timeAgo, timeAgoLong } from "../../lib/time";
import { Avatar } from "../../ui/Avatar";
import { Button } from "../../ui/Button";
import { Skeleton } from "../../ui/Skeleton";
import { StateMessage } from "../../ui/StateMessage";
import { VerifiedBadge } from "../../ui/VerifiedBadge";
import { describeError } from "../feed/errors";
import { useConversations } from "./useMessages";

export function ConversationList({ onNew }: { onNew: () => void }) {
  const list = useConversations();

  if (list.status === "loading") return <ConversationSkeletons />;
  if (list.status === "error") {
    return (
      <StateMessage
        tone="error"
        icon={<CircleAlert size={24} />}
        {...describeError(list.error, "your messages")}
        action={<Button variant="secondary" onClick={list.retry}>Try again</Button>}
      />
    );
  }
  if (list.items.length === 0) {
    return (
      <StateMessage
        icon={<Mail size={24} />}
        title="No messages yet"
        body="Start a private conversation with someone — from here or from their profile."
        action={<Button onClick={onNew} icon={<SquarePen size={18} aria-hidden="true" />}>New message</Button>}
      />
    );
  }
  return (
    <ul className="convo-list" aria-label="Conversations">
      {list.items.map((c) => (
        <ConversationRow key={c.id} conversation={c} />
      ))}
    </ul>
  );
}

function ConversationRow({ conversation: c }: { conversation: Conversation }) {
  const last = c.lastMessage;
  const unread = c.unreadCount > 0;
  const preview = !last
    ? "No messages yet"
    : last.undecryptable
      ? "Encrypted message"
      : last.text || (last.hasImage ? "Photo" : "");
  const label = [
    c.peer.name,
    unread ? `${c.unreadCount} unread` : null,
    last ? `${last.fromViewer ? "You: " : ""}${preview}, ${timeAgoLong(last.createdAt)}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <li>
      <NavLink to={`/messages/${c.id}`} className={`convo-row${unread ? " is-unread" : ""}`} aria-label={label}>
        <Avatar name={c.peer.name} src={c.peer.avatarUrl} seed={c.peer.id} size="md" />
        <span className="convo-row__body">
          <span className="convo-row__top">
            <span className="convo-row__name">
              {c.peer.name}
              <VerifiedBadge verified={c.peer.verified} size={15} />
            </span>
            {last && <time className="convo-row__time" dateTime={last.createdAt.toISOString()}>{timeAgo(last.createdAt)}</time>}
          </span>
          <span className="convo-row__preview">
            {last?.fromViewer && (last.status === "read" ? <CheckCheck size={15} aria-hidden="true" className="convo-row__tick is-read" /> : <Check size={15} aria-hidden="true" className="convo-row__tick" />)}
            {last?.hasImage && !last.undecryptable && <ImageIcon size={15} aria-hidden="true" />}
            <span className="convo-row__snippet">
              {last?.fromViewer ? "You: " : ""}
              {preview}
            </span>
            {c.blockedByViewer && <span className="convo-row__flag">Blocked</span>}
            {unread && <span className="convo-row__unread" aria-hidden="true">{c.unreadCount > 99 ? "99+" : c.unreadCount}</span>}
          </span>
        </span>
      </NavLink>
    </li>
  );
}

function ConversationSkeletons() {
  return (
    <ul className="convo-list" aria-label="Loading conversations" aria-busy="true">
      {Array.from({ length: 5 }, (_, i) => (
        <li key={i} className="convo-row convo-row--skeleton">
          <Skeleton width={44} height={44} radius="var(--radius-full)" />
          <span className="convo-row__body">
            <Skeleton width="40%" height={14} />
            <Skeleton width="75%" height={12} />
          </span>
        </li>
      ))}
    </ul>
  );
}
