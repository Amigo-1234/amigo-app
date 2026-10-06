import { Link, useSearchParams } from "react-router";
import { ArrowUp, Bell, CircleAlert, Feather, HandHeart, Mail, UsersRound, WifiOff } from "lucide-react";
import { supportEnabled } from "../features/support/useSupport";
import { Composer } from "../features/composer/Composer";
import { describeError } from "../features/feed/errors";
import { useFeed, type FeedTab } from "../features/feed/useFeed";
import { PostCard } from "../features/posts/PostCard";
import { FeedSkeleton } from "../features/posts/PostSkeleton";
import { FeedFooter } from "../features/feed/FeedFooter";
import { messagesInBottomBar } from "../shell/nav";
import { ScreenHeader } from "../shell/ScreenHeader";
import { useComposer } from "../state/composer";
import { pendingAsPost, usePublishing } from "../state/publishing";
import { messagesEnabled, messagesLabel, useUnreadMessages } from "../state/messages";
import { badgeText, notificationsEnabled, notificationsLabel, useUnread } from "../state/notifications";
import { useViewer } from "../state/session";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { StateMessage } from "../ui/StateMessage";
import "./HomeScreen.css";

const TABS: { id: FeedTab; label: string }[] = [
  { id: "latest", label: "Latest" },
  { id: "following", label: "Following" },
];

export default function HomeScreen() {
  const [params, setParams] = useSearchParams();
  const tab: FeedTab = params.get("tab") === "following" ? "following" : "latest";
  const feed = useFeed(tab);
  const composer = useComposer();
  const viewer = useViewer();
  const publishing = usePublishing();
  const { unread } = useUnread();
  const badge = notificationsEnabled ? badgeText(unread) : null;
  const unreadMessages = useUnreadMessages();
  const messagesBadge = badgeText(unreadMessages);
  // Optimistic posts, until the real post shows up in the feed.
  const feedIds = new Set(feed.posts.map((p) => p.id));
  const pending = publishing.pending.filter((p) => !(p.status === "sent" && p.postId && feedIds.has(p.postId)));

  const setTab = (t: FeedTab) => {
    setParams(t === "latest" ? {} : { tab: t }, { replace: true });
    window.scrollTo({ top: 0 });
  };

  return (
    <>
      <ScreenHeader
        title="Home"
        brandOnMobile
        actions={
          <>
          {supportEnabled && (
            <Link to="/support" className="icon-btn icon-btn--md mobile-only" aria-label="Support Hub" title="Support Hub">
              <HandHeart size={22} aria-hidden="true" />
            </Link>
          )}
          {/* On phones Worlds takes Messages' bottom-bar slot, so Messages lives here. */}
          {messagesEnabled && !messagesInBottomBar && (
            <Link to="/messages" className="icon-btn icon-btn--md mobile-only" aria-label={messagesLabel(unreadMessages)} title="Messages">
              <span className="nav-icon">
                <Mail size={22} aria-hidden="true" />
                {messagesBadge && <span className="nav-badge" aria-hidden="true">{messagesBadge}</span>}
              </span>
            </Link>
          )}
          <Link to="/notifications" className="icon-btn icon-btn--md mobile-only" aria-label={notificationsLabel(unread)} title="Notifications">
            <span className="nav-icon">
              <Bell size={22} aria-hidden="true" />
              {badge && <span className="nav-badge" aria-hidden="true">{badge}</span>}
            </span>
          </Link>
          </>
        }
      >
        <div className="tabs" role="tablist" aria-label="Feed">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls="feed-panel"
              className="tab"
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </ScreenHeader>

      <div className="home-composer">
        <Composer variant="inline" />
      </div>

      {feed.pending.length > 0 && (
        <div className="new-posts">
          <button
            className="new-posts__pill"
            onClick={() => {
              feed.revealPending();
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
          >
            <ArrowUp size={16} aria-hidden="true" />
            <span className="new-posts__avatars" aria-hidden="true">
              {feed.pending.slice(0, 3).map((p) => (
                <Avatar key={p.id} name={p.author.name} src={p.author.avatarUrl} seed={p.author.id} size="xs" />
              ))}
            </span>
            {feed.pending.length === 1 ? "1 new post" : `${feed.pending.length} new posts`}
          </button>
        </div>
      )}

      <section id="feed-panel" role="tabpanel" aria-labelledby={`tab-${tab}`} aria-busy={feed.status === "loading"}>
        {pending.map((p) => (
          <PostCard
            key={p.localId}
            post={pendingAsPost(p, viewer)}
            pending={{ status: p.status, onRetry: () => publishing.retry(p.localId), onDiscard: () => publishing.discard(p.localId) }}
          />
        ))}

        {feed.status === "loading" && <FeedSkeleton />}

        {feed.status === "error" && (
          <StateMessage
            tone="error"
            icon={navigator.onLine ? <CircleAlert size={24} /> : <WifiOff size={24} />}
            {...describeError(feed.error)}
            action={<Button variant="secondary" onClick={feed.retry}>Try again</Button>}
          />
        )}

        {feed.status === "ready" && feed.posts.length === 0 && pending.length === 0 && !feed.loadingMore && (
          tab === "following" ? (
            <StateMessage
              icon={<UsersRound size={24} />}
              title={feed.followingCount ? "Quiet in here" : "Your people, all in one place"}
              body={
                feed.followingCount
                  ? "The people you follow haven't posted recently. Check Latest to see what everyone's sharing."
                  : "Follow people to see their posts here. Start with Latest to find someone worth following."
              }
              action={<Button variant="secondary" onClick={() => setTab("latest")}>Browse Latest</Button>}
            />
          ) : (
            <StateMessage
              icon={<Feather size={24} />}
              title="Nothing posted yet"
              body="Be the first. Say hi, share a photo, start something."
              action={<Button onClick={() => composer.setOpen(true)}>Write a post</Button>}
            />
          )
        )}

        {feed.posts.length > 0 && feed.status !== "error" && (
          <div className="feed">
            {feed.posts.map((p) => (
              <PostCard key={p.id} post={p} />
            ))}
            <FeedFooter hasMore={feed.hasMore} loading={feed.loadingMore} onMore={feed.loadMore} />
          </div>
        )}
      </section>
    </>
  );
}
