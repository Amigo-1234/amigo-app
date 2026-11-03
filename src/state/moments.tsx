import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { dataSource, type MomentGroup } from "../data";
import { MomentComposerSheet } from "../features/moments/MomentComposer";
import { MomentViewer } from "../features/moments/MomentViewer";
import { useViewer } from "./session";

/** Moments are an optional backend capability (demo and Supabase). */
export const momentsEnabled = !!dataSource.moments;

interface MomentsState {
  /** null until loaded (or when Moments aren't available). */
  groups: MomentGroup[] | null;
  /** Opens the viewer at this person. Plays on through the following people unless `only` is given. */
  open: (authorId: string, only?: MomentGroup[]) => void;
  compose: () => void;
}

const MomentsContext = createContext<MomentsState>({ groups: null, open: () => {}, compose: () => {} });

export function MomentsProvider({ children }: { children: ReactNode }) {
  const viewer = useViewer();
  const api = dataSource.moments;
  const [groups, setGroups] = useState<MomentGroup[] | null>(null);
  const [viewing, setViewing] = useState<{ queue: MomentGroup[]; start: number } | null>(null);
  const [composing, setComposing] = useState(false);

  useEffect(() => {
    if (!api) return;
    return api.subscribeFeed(viewer.id, {
      onData: setGroups,
      onError: (e) => {
        console.error(e);
        setGroups([]);
      },
    });
  }, [api, viewer.id]);

  const open = useCallback(
    (authorId: string, only?: MomentGroup[]) => {
      const queue = only ?? groups ?? [];
      const start = queue.findIndex((g) => g.author.id === authorId);
      if (start >= 0 && queue[start].moments.length) setViewing({ queue, start });
    },
    [groups],
  );

  const value = useMemo(() => ({ groups, open, compose: () => setComposing(true) }), [groups, open]);

  return (
    <MomentsContext.Provider value={value}>
      {children}
      {api && viewing && <MomentViewer queue={viewing.queue} live={groups} start={viewing.start} onClose={() => setViewing(null)} />}
      {api && <MomentComposerSheet open={composing} onClose={() => setComposing(false)} />}
    </MomentsContext.Provider>
  );
}

export const useMoments = () => useContext(MomentsContext);
