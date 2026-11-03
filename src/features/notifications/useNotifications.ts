import { useCallback, useEffect, useMemo, useState } from "react";
import { dataSource, type AppNotification } from "../../data";
import { useViewer } from "../../state/session";
import { groupNotifications } from "./group";

const PAGE = 20;

type Status = "loading" | "ready" | "error";

export function useNotifications() {
  const viewer = useViewer();
  const api = dataSource.notifications;
  const [limit, setLimit] = useState(PAGE);
  const [items, setItems] = useState<AppNotification[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<Error | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  // Marked read here but not yet confirmed by the backend.
  const [readLocally, setReadLocally] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!api) return;
    return api.subscribeNotifications(viewer.id, limit, {
      onData: (page) => {
        setItems(page.items);
        setHasMore(page.hasMore);
        setStatus("ready");
        setError(null);
        setLoadingMore(false);
      },
      onError: (e) => {
        console.error(e);
        setError(e);
        setStatus("error");
        setLoadingMore(false);
      },
    });
  }, [api, viewer.id, limit, retryKey]);

  const merged = useMemo(
    () => (readLocally.size ? items.map((n) => (readLocally.has(n.id) && !n.read ? { ...n, read: true } : n)) : items),
    [items, readLocally],
  );
  const groups = useMemo(() => groupNotifications(merged), [merged]);

  const markLocally = useCallback((ids: string[] | "all") => {
    setReadLocally((prev) => new Set([...prev, ...(ids === "all" ? items.map((n) => n.id) : ids)]));
  }, [items]);

  const unmarkLocally = useCallback((ids: string[] | "all") => {
    setReadLocally((prev) => {
      if (ids === "all") return new Set();
      const next = new Set(prev);
      ids.forEach((id) => next.delete(id));
      return next;
    });
  }, []);

  const loadMore = useCallback(() => {
    if (!hasMore || loadingMore) return;
    setLoadingMore(true);
    setLimit((l) => l + PAGE);
  }, [hasMore, loadingMore]);

  const retry = useCallback(() => {
    setStatus("loading");
    setRetryKey((k) => k + 1);
  }, []);

  return { status, error, groups, hasMore, loadingMore, loadMore, retry, markLocally, unmarkLocally };
}
