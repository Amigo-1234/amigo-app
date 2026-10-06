import { useCallback, useEffect, useState } from "react";
import { dataSource, WorldError, type LeaderboardEntry, type Post, type World, type WorldChatMessage } from "../../data";
import { useViewer } from "../../state/session";

export const worldsEnabled = !!dataSource.worlds;

type Load<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error"; error: unknown };

export function useWorldList() {
  const viewer = useViewer();
  const [state, setState] = useState<Load<World[]>>({ status: "loading" });
  const [key, setKey] = useState(0);
  const [silent, setSilent] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setState((s) => (s.status === "ready" ? s : { status: "loading" }));
    dataSource.worlds!
      .listWorlds(viewer.id)
      .then((data) => !cancelled && setState({ status: "ready", data }))
      .catch((error) => !cancelled && setState({ status: "error", error }));
    return () => {
      cancelled = true;
    };
  }, [viewer.id, key, silent]);
  return {
    state,
    retry: () => {
      setState({ status: "loading" });
      setKey((k) => k + 1);
    },
    /** Refetch without a loading state (after joining from the list). */
    refresh: () => setSilent((k) => k + 1),
  };
}

/** Subscribe helper for the live World views. */
function useLive<T>(subscribe: ((sub: { onData: (v: T) => void; onError: (e: Error) => void }) => () => void) | null, deps: unknown[]) {
  const [state, setState] = useState<Load<T>>({ status: "loading" });
  const [key, setKey] = useState(0);
  useEffect(() => {
    if (!subscribe) return;
    setState({ status: "loading" });
    return subscribe({
      onData: (data) => setState({ status: "ready", data }),
      onError: (error) => setState({ status: "error", error }),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, key]);
  return { state, retry: useCallback(() => setKey((k) => k + 1), []) };
}

export function useWorld(slug: string) {
  const viewer = useViewer();
  return useLive<World | null>((sub) => dataSource.worlds!.subscribeWorld(slug, viewer.id, sub), [slug, viewer.id]);
}

const PAGE = 15;

export function useWorldPosts(worldId: string | null, entriesOnly: boolean) {
  const viewer = useViewer();
  const [limit, setLimit] = useState(PAGE);
  const live = useLive<{ posts: Post[]; hasMore: boolean }>(
    worldId ? (sub) => dataSource.worlds!.subscribeWorldPosts(worldId, viewer.id, { entriesOnly, limit }, sub) : null,
    [worldId, viewer.id, entriesOnly, limit],
  );
  // Keep showing the previous page while the next one loads.
  const [last, setLast] = useState<{ posts: Post[]; hasMore: boolean } | null>(null);
  useEffect(() => {
    if (live.state.status === "ready") setLast(live.state.data);
  }, [live.state]);
  useEffect(() => {
    setLimit(PAGE);
    setLast(null);
  }, [worldId, entriesOnly]);
  const loadingMore = live.state.status === "loading" && last !== null;
  return {
    ...live,
    page: live.state.status === "ready" ? live.state.data : last,
    loadingMore,
    loadMore: useCallback(() => setLimit((l) => l + PAGE), []),
  };
}

export function useLeaderboard(worldId: string | null) {
  const viewer = useViewer();
  return useLive<LeaderboardEntry[]>(worldId ? (sub) => dataSource.worlds!.subscribeLeaderboard(worldId, viewer.id, sub) : null, [worldId, viewer.id]);
}

export function useWorldChat(worldId: string | null) {
  return useLive<WorldChatMessage[]>(worldId ? (sub) => dataSource.worlds!.subscribeChat(worldId, 100, sub) : null, [worldId]);
}

/** Human copy for World rule errors. */
export function worldErrorText(e: unknown): string {
  if (e instanceof WorldError) {
    switch (e.code) {
      case "not-joined":
        return "Join this World first.";
      case "not-live":
        return "This World isn't live right now.";
      case "entries-closed":
        return "Entries are closed.";
      case "entry-limit":
        return "You've already used your entry.";
      case "not-competition":
        return "This World doesn't have a competition.";
    }
  }
  return "Something went wrong. Try again.";
}
