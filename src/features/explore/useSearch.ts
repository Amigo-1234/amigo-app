import { useCallback, useEffect, useRef, useState } from "react";
import { dataSource, type ExploreFeed, type PersonSummary, type Post, type SearchTab } from "../../data";
import { useViewer } from "../../state/session";

type Status = "idle" | "loading" | "ready" | "error";

export interface SearchResults {
  people: PersonSummary[];
  posts: Post[];
  hasMore: boolean;
}

const EMPTY: SearchResults = { people: [], posts: [], hasMore: false };
const PAGE = 15;

/**
 * Runs the search for the (already debounced) query and tab. Stale responses
 * from earlier queries are ignored, so fast typing can't show old results.
 */
export function useSearch(query: string, tab: SearchTab) {
  const viewer = useViewer();
  const [status, setStatus] = useState<Status>("idle");
  const [results, setResults] = useState<SearchResults>(EMPTY);
  const [error, setError] = useState<unknown>(null);
  const [limit, setLimit] = useState(PAGE);
  const [loadingMore, setLoadingMore] = useState(false);
  const [key, setKey] = useState(0);
  const requestId = useRef(0);

  useEffect(() => {
    setLimit(PAGE);
  }, [query, tab]);

  useEffect(() => {
    const api = dataSource.discovery;
    const q = query.trim();
    if (!api || !q) {
      setStatus("idle");
      setResults(EMPTY);
      return;
    }
    const id = ++requestId.current;
    if (!loadingMore) setStatus("loading");

    const run = async (): Promise<SearchResults> => {
      switch (tab) {
        case "top": {
          const [people, posts] = await Promise.all([
            api.searchPeople(q, viewer.id, 3),
            api.searchPosts(q, viewer.id, { order: "top", limit }),
          ]);
          return { people, posts: posts.posts, hasMore: posts.hasMore };
        }
        case "people":
          return { people: await api.searchPeople(q, viewer.id, 50), posts: [], hasMore: false };
        case "posts": {
          const page = await api.searchPosts(q, viewer.id, { order: "latest", limit });
          return { people: [], posts: page.posts, hasMore: page.hasMore };
        }
        case "media": {
          const page = await api.searchPosts(q, viewer.id, { order: "latest", mediaOnly: true, limit: limit * 2 });
          return { people: [], posts: page.posts, hasMore: page.hasMore };
        }
      }
    };

    run()
      .then((r) => {
        if (id !== requestId.current) return;
        setResults(r);
        setStatus("ready");
      })
      .catch((e) => {
        if (id !== requestId.current) return;
        setError(e);
        setStatus("error");
      })
      .finally(() => id === requestId.current && setLoadingMore(false));
    // loadingMore intentionally not a dependency: it only shapes the loading state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, tab, limit, viewer.id, key]);

  const loadMore = useCallback(() => {
    if (!results.hasMore || loadingMore) return;
    setLoadingMore(true);
    setLimit((l) => l + PAGE);
  }, [results.hasMore, loadingMore]);

  const retry = useCallback(() => setKey((k) => k + 1), []);

  return { status, results, error, loadMore, loadingMore, retry };
}

export function useExploreFeed() {
  const viewer = useViewer();
  const [state, setState] = useState<{ status: "loading" } | { status: "ready"; feed: ExploreFeed } | { status: "error"; error: unknown }>({ status: "loading" });
  const [key, setKey] = useState(0);

  useEffect(() => {
    const api = dataSource.discovery;
    if (!api) return;
    let cancelled = false;
    setState({ status: "loading" });
    api
      .explore(viewer.id)
      .then((feed) => !cancelled && setState({ status: "ready", feed }))
      .catch((error) => !cancelled && setState({ status: "error", error }));
    return () => {
      cancelled = true;
    };
  }, [viewer.id, key]);

  return { state, retry: () => setKey((k) => k + 1) };
}
