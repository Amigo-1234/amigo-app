import { useEffect, useRef } from "react";
import { PostSkeleton } from "../posts/PostSkeleton";
import { Button } from "../../ui/Button";

/** Infinite-scroll footer shared by every post list: loads ahead of the viewport, falls back to a button. */
export function FeedFooter({
  hasMore,
  loading,
  onMore,
  endLabel = "You're all caught up",
  loadingLabel = "Loading more posts",
}: {
  hasMore: boolean;
  loading: boolean;
  onMore: () => void;
  endLabel?: string;
  loadingLabel?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver((entries) => entries[0].isIntersecting && onMore(), { rootMargin: "800px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, onMore]);

  if (!hasMore) {
    return endLabel ? <p className="feed-end">{endLabel}</p> : null;
  }
  return (
    <div ref={ref}>
      {loading ? (
        <div role="status" aria-label={loadingLabel}>
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
