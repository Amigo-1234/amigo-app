import { useEffect, useRef } from "react";
import { Link, useSearchParams } from "react-router";
import { ArrowUp, Bell, CircleAlert, Feather, UsersRound, WifiOff } from "lucide-react";
import { Composer } from "../features/composer/Composer";
import { describeError } from "../features/feed/errors";
import { useFeed, type FeedTab } from "../features/feed/useFeed";
import { PostCard } from "../features/posts/PostCard";
import { FeedSkeleton, PostSkeleton } from "../features/posts/PostSkeleton";
import { ScreenHeader } from "../shell/ScreenHeader";
import { useComposer } from "../state/composer";
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
          <Link to="/notifications" className="icon-btn icon-btn--md mobile-only" aria-label="Notifications" title="Notifications">
            <Bell size={22} aria-hidden="true" />
          </Link>
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
        {feed.status === "loading" && <FeedSkeleton />}

        {feed.status === "error" && (
          <StateMessage
            tone="error"
            icon={navigator.onLine ? <CircleAlert size={24} /> : <WifiOff size={24} />}
            {...describeError(feed.error)}
            action={<Button variant="secondary" onClick={feed.retry}>Try again</Button>}
          />
        )}

        {feed.status === "ready" && feed.posts.length === 0 && !feed.loadingMore && (
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

function FeedFooter({ hasMore, loading, onMore }: { hasMore: boolean; loading: boolean; onMore: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver((entries) => entries[0].isIntersecting && onMore(), { rootMargin: "800px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, onMore]);

  if (!hasMore) {
    return <p className="feed-end">You're all caught up</p>;
  }
  return (
    <div ref={ref}>
      {loading ? (
        <div role="status" aria-label="Loading more posts">
          <PostSkeleton />
        </div>
      ) : (
        <div className="feed-more">
          <Button variant="ghost" onClick={onMore}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
