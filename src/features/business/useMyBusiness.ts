import { useCallback, useEffect, useSyncExternalStore } from "react";
import { dataSource, type MyBusiness } from "../../data";
import { useViewer } from "../../state/session";

type State = { enabled: boolean; business: MyBusiness | null } | null;

/** Business profiles are an optional backend capability (Neon with media storage, or the demo). */
export const businessApi = dataSource.business;

// One shared answer per signed-in person, so menus on every post don't each ask the backend.
let state: State = null;
let forViewer: string | null = null;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function load(viewerId: string, force = false) {
  if (!businessApi) return;
  if (forViewer !== viewerId) {
    forViewer = viewerId;
    state = null;
    inFlight = null;
    emit();
  }
  if (inFlight && !force) return;
  const run = businessApi.mine().then(
    (s) => {
      if (forViewer === viewerId && inFlight === run) {
        state = s;
        emit();
      }
    },
    () => undefined,
  );
  inFlight = run;
}

/** Whether businesses are on, and the viewer's own business (null while loading or without one). */
export function useMyBusiness() {
  const viewer = useViewer();
  const snapshot = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => (forViewer === viewer.id ? state : null),
  );
  useEffect(() => load(viewer.id), [viewer.id]);
  const reload = useCallback(() => load(viewer.id, true), [viewer.id]);
  return { state: snapshot, reload };
}

// Business posts aren't on a live subscription: a page showing them reloads when one is deleted.
const postListeners = new Set<() => void>();
export const businessPostsChanged = () => postListeners.forEach((l) => l());
export function onBusinessPostsChanged(cb: () => void) {
  postListeners.add(cb);
  return () => {
    postListeners.delete(cb);
  };
}
