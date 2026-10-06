import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { dataSource, type Post } from "../../data";
import { useViewer } from "../../state/session";

export type FeedTab = "latest" | "following";

const PAGE = 15;
/** Following is filtered client-side from the latest posts (no composite index needed yet). */
const FOLLOWING_SCAN_CAP = 200;
const REVEAL_SCROLL_THRESHOLD = 240;

type Status = "loading" | "ready" | "error";

export function useFeed(tab: FeedTab) {
  const viewer = useViewer();
  const [limit, setLimit] = useState(PAGE);
  const [all, setAll] = useState<Post[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<Error | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [following, setFollowing] = useState<Set<string> | null>(null);

  // Posts by others that arrived while the reader was scrolled down are held
  // back behind a "new posts" pill instead of shoving the timeline around.
  const [revealedAfter, setRevealedAfter] = useState<number | null>(null);

  // Reset when the tab changes.
  useEffect(() => {
    setLimit(PAGE);
    setRevealedAfter(null);
  }, [tab]);

  useEffect(() => {
    if (tab !== "following") return;
    let cancelled = false;
    setFollowing(null);
    dataSource
      .getFollowingIds(viewer.id)
      .then((ids) => !cancelled && setFollowing(ids))
      .catch((e) => {
        if (cancelled) return;
        setError(e);
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [tab, viewer.id, retryKey]);

  useEffect(() => {
    setError(null);
    const unsub = dataSource.subscribeLatestPosts(viewer.id, limit, {
      onData: ({ posts, hasMore }) => {
        setAll(posts);
        setHasMore(hasMore);
        setStatus("ready");
        setLoadingMore(false);
      },
      onError: (e) => {
        console.error(e);
        setError(e);
        setStatus("error");
        setLoadingMore(false);
      },
    });
    return unsub;
  }, [viewer.id, limit, retryKey]);

  // First successful load marks everything currently present as seen.
  useEffect(() => {
    if (status === "ready" && revealedAfter === null) {
      setRevealedAfter(newestTime(all));
    }
  }, [status, all, revealedAfter]);

  const scoped = useMemo(() => {
    if (tab === "latest") return all;
    if (!following) return [];
    return all.filter((p) => following.has(p.author.id) || p.author.id === viewer.id);
  }, [tab, all, following, viewer.id]);

  const { visible, pending } = useMemo(() => {
    if (revealedAfter === null) return { visible: scoped, pending: [] as Post[] };
    const visible: Post[] = [];
    const pending: Post[] = [];
    for (const p of scoped) {
      const t = p.createdAt?.getTime() ?? Date.now();
      if (t > revealedAfter && p.author.id !== viewer.id) pending.push(p);
      else visible.push(p);
    }
    return { visible, pending };
  }, [scoped, revealedAfter, viewer.id]);

  const revealPending = useCallback(() => {
    setRevealedAfter(newestTime(all));
  }, [all]);

  // Auto-reveal when the reader is already at the top.
  const pendingCount = pending.length;
  const allRef = useRef(all);
  allRef.current = all;
  useEffect(() => {
    if (pendingCount === 0) return;
    if (window.scrollY < REVEAL_SCROLL_THRESHOLD) setRevealedAfter(newestTime(allRef.current));
  }, [pendingCount]);

  const canScanMore = tab === "latest" ? hasMore : hasMore && limit < FOLLOWING_SCAN_CAP;

  const loadMore = useCallback(() => {
    if (!canScanMore || loadingMore) return;
    setLoadingMore(true);
    setLimit((l) => l + PAGE);
  }, [canScanMore, loadingMore]);

  // Following: keep scanning until a page's worth of matches shows up.
  useEffect(() => {
    if (tab === "following" && following && status === "ready" && !loadingMore && scoped.length < PAGE && canScanMore) {
      loadMore();
    }
  }, [tab, following, status, loadingMore, scoped.length, canScanMore, loadMore]);

  const retry = useCallback(() => {
    setStatus("loading");
    setRetryKey((k) => k + 1);
  }, []);

  const effectiveStatus: Status = status === "ready" && tab === "following" && !following ? "loading" : status;

  return {
    status: effectiveStatus,
    error,
    posts: visible,
    pending,
    revealPending,
    hasMore: canScanMore,
    loadingMore,
    loadMore,
    retry,
    followingCount: following?.size ?? null,
  };
}

function newestTime(posts: Post[]): number {
  let max = 0;
  for (const p of posts) max = Math.max(max, p.createdAt?.getTime() ?? Date.now());
  return max || Date.now();
}
