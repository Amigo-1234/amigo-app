import { useCallback, useEffect, useState } from "react";
import { dataSource, type Post, type Profile, type ProfileTab } from "../../data";
import { useViewer } from "../../state/session";

type Load<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error"; error: unknown };

export function useProfile(handle: string) {
  const viewer = useViewer();
  const [state, setState] = useState<Load<Profile | null>>({ status: "loading" });
  const [key, setKey] = useState(0);

  useEffect(() => {
    const api = dataSource.profiles;
    if (!api) return;
    let cancelled = false;
    setState({ status: "loading" });
    api
      .getProfile(handle, viewer.id)
      .then((data) => !cancelled && setState({ status: "ready", data }))
      .catch((error) => !cancelled && setState({ status: "error", error }));
    return () => {
      cancelled = true;
    };
    // viewer.handle: refetch after the viewer edits their own profile.
  }, [handle, viewer.id, viewer.handle, viewer.name, viewer.avatarUrl, key]);

  const reload = useCallback(() => setKey((k) => k + 1), []);
  /** Local patch (e.g. follower count after following) without a round trip. */
  const patch = useCallback((fn: (p: Profile) => Profile) => {
    setState((s) => (s.status === "ready" && s.data ? { status: "ready", data: fn(s.data) } : s));
  }, []);

  return { state, reload, patch };
}

const PAGE = 15;

export function useProfilePosts(profileId: string | null, tab: ProfileTab) {
  const viewer = useViewer();
  const [limit, setLimit] = useState(PAGE);
  const [posts, setPosts] = useState<Post[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [key, setKey] = useState(0);

  useEffect(() => {
    setLimit(PAGE);
    setStatus("loading");
    setPosts([]);
  }, [profileId, tab]);

  useEffect(() => {
    const api = dataSource.profiles;
    if (!api || !profileId) return;
    return api.subscribeProfilePosts(profileId, viewer.id, tab, limit, {
      onData: (v) => {
        setPosts(v.posts);
        setHasMore(v.hasMore);
        setStatus("ready");
        setLoadingMore(false);
      },
      onError: (e) => {
        setError(e);
        setStatus("error");
        setLoadingMore(false);
      },
    });
  }, [profileId, tab, limit, viewer.id, key]);

  const loadMore = useCallback(() => {
    if (!hasMore || loadingMore) return;
    setLoadingMore(true);
    setLimit((l) => l + PAGE);
  }, [hasMore, loadingMore]);

  const retry = useCallback(() => {
    setStatus("loading");
    setKey((k) => k + 1);
  }, []);

  return { posts, hasMore, status, error, loadingMore, loadMore, retry };
}
