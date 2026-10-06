import { Link } from "react-router";
import { AtSign, Bell, CheckCheck, CircleAlert, Heart, MessageCircle, UserPlus } from "lucide-react";
import { describeError } from "../features/feed/errors";
import { FeedFooter } from "../features/feed/FeedFooter";
import { actionText, actorNames, describeGroup, groupHref, type NotificationGroup } from "../features/notifications/group";
import { useNotifications } from "../features/notifications/useNotifications";
import { timeAgo, timeAgoLong } from "../lib/time";
import { ScreenHeader } from "../shell/ScreenHeader";
import { useUnread } from "../state/notifications";
import { useViewer } from "../state/session";
import { useToast } from "../state/toast";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { Skeleton } from "../ui/Skeleton";
import { StateMessage } from "../ui/StateMessage";
import "./NotificationsScreen.css";

const MAX_AVATARS = 6;

export default function NotificationsScreen() {
  const list = useNotifications();
  const unread = useUnread();
  const toast = useToast();
  const anyUnread = (unread.unread ?? 0) > 0 || list.groups.some((g) => g.unread);

  const markAll = () => {
    list.markLocally("all");
    unread.markAllRead().catch(() => {
      list.unmarkLocally("all");
      toast("Couldn’t mark notifications as read. Try again.", "error");
    });
  };

  return (
    <>
      <ScreenHeader
        title="Notifications"
        actions={
          list.status === "ready" && list.groups.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={markAll} disabled={!anyUnread} icon={<CheckCheck size={18} aria-hidden="true" />}>
              Mark all read
            </Button>
          ) : null
        }
      />

      {list.status === "loading" && <NotificationSkeletons />}

      {list.status === "error" && (
        <StateMessage
          tone="error"
          icon={<CircleAlert size={24} />}
          {...describeError(list.error, "notifications")}
          action={<Button variant="secondary" onClick={list.retry}>Try again</Button>}
        />
      )}

      {list.status === "ready" && list.groups.length === 0 && (
        <StateMessage
          icon={<Bell size={24} />}
          title="No notifications yet"
          body="When people follow you, like or reply to your posts, or mention you, you'll see it here."
        />
      )}

      {list.status === "ready" && list.groups.length > 0 && (
        <>
          <ul className="notifications" aria-label="Notifications">
            {list.groups.map((g) => (
              <NotificationRow key={g.key} group={g} onOpen={() => {
                const unreadIds = g.items.filter((n) => !n.read).map((n) => n.id);
                if (unreadIds.length === 0) return;
                list.markLocally(unreadIds);
                unread.markRead(unreadIds, unreadIds.length).catch(() => list.unmarkLocally(unreadIds));
              }} />
            ))}
          </ul>
          <FeedFooter
            hasMore={list.hasMore}
            loading={list.loadingMore}
            onMore={list.loadMore}
            endLabel={list.groups.length > 4 ? "That's everything" : ""}
            loadingLabel="Loading more notifications"
          />
        </>
      )}
    </>
  );
}

const KIND_ICON = { like: Heart, follow: UserPlus, reply: MessageCircle, mention: AtSign } as const;

function NotificationRow({ group: g, onOpen }: { group: NotificationGroup; onOpen: () => void }) {
  const viewer = useViewer();
  const Icon = KIND_ICON[g.kind];
  const { first, second, others } = actorNames(g.actors);
  const preview = g.post ? previewOf(g) : null;
  const thumb = g.post?.media.find((m) => m.type === "image");
  const when = timeAgoLong(g.latestAt);
  // Screen readers get one sentence; the visual row carries the same words, plus the "Unread" text.
  const label = `${g.unread ? "Unread. " : ""}${describeGroup(g)}${preview ? `: ${preview}` : ""}. ${when}`;

  return (
    <li className={`notification notification--${g.kind}${g.unread ? " is-unread" : ""}`}>
      <Link to={groupHref(g, viewer.handle)} className="notification__link" aria-label={label} onClick={onOpen}>
        <span className="notification__icon" aria-hidden="true">
          <Icon size={22} strokeWidth={2} fill={g.kind === "like" ? "currentColor" : "none"} />
        </span>
        <span className="notification__body">
          <span className="notification__avatars" aria-hidden="true">
            {g.actors.slice(0, MAX_AVATARS).map((a) => (
              <Avatar key={a.id} name={a.name} src={a.avatarUrl} seed={a.id} size="sm" />
            ))}
          </span>
          <span className="notification__text" aria-hidden="true">
            <strong>{first}</strong>
            {second && (
              <>
                {" and "}
                <strong>{second}</strong>
              </>
            )}
            {others > 0 && ` and ${others} ${others === 1 ? "other" : "others"}`} {actionText(g)}
            <span className="notification__time">
              {" · "}
              <time dateTime={g.latestAt.toISOString()}>{timeAgo(g.latestAt)}</time>
            </span>
          </span>
          {preview && (
            <span className={`notification__preview${g.kind === "like" ? " is-own" : ""}`} aria-hidden="true">
              {preview}
            </span>
          )}
        </span>
        {thumb && (
          <img className="notification__thumb" src={thumb.url} alt="" loading="lazy" decoding="async" aria-hidden="true" />
        )}
        {g.unread && (
          <span className="notification__unread">
            <span className="notification__dot" aria-hidden="true" />
            <span className="visually-hidden">Unread</span>
          </span>
        )}
      </Link>
    </li>
  );
}

function previewOf(g: NotificationGroup): string | null {
  const post = g.post!;
  const text = post.text.trim();
  if (text) return text.length > 140 ? `${text.slice(0, 139)}…` : text;
  const n = post.media.length;
  return n ? (n === 1 ? "Photo" : `${n} photos`) : null;
}

function NotificationSkeletons() {
  return (
    <ul className="notifications" aria-label="Loading notifications" aria-busy="true">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <li key={i} className="notification" aria-hidden="true">
          <span className="notification__link">
            <span className="notification__icon"><Skeleton width={22} height={22} radius="50%" /></span>
            <span className="notification__body">
              <Skeleton width={32} height={32} radius="50%" />
              <Skeleton width={i % 2 ? 220 : 160} height={12} />
              <Skeleton width={i % 2 ? 120 : 200} height={10} />
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
