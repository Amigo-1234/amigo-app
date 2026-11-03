import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { dataSource, type Viewer } from "../data";

type SessionState =
  | { status: "loading" }
  | { status: "signedOut" }
  | { status: "signedIn"; viewer: Viewer }
  /** Arrived through a password-reset link: must choose a new password first. */
  | { status: "recovery" };

const SessionContext = createContext<SessionState>({ status: "loading" });
const RecoveryDoneContext = createContext<() => void>(() => {});

/** Call after the new password is saved to continue into the app. */
export const useFinishRecovery = () => useContext(RecoveryDoneContext);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: "loading" });
  const [recovering, setRecovering] = useState(false);
  useEffect(
    () => dataSource.onViewerChanged((viewer) => setState(viewer ? { status: "signedIn", viewer } : { status: "signedOut" })),
    [],
  );
  useEffect(() => dataSource.onPasswordRecovery?.(() => setRecovering(true)), []);

  // Signed in: keep this device's notifications registered to this account (never prompts), once the app has settled.
  const viewerId = state.status === "signedIn" ? state.viewer.id : null;
  useEffect(() => {
    if (!viewerId || !dataSource.push) return;
    const t = setTimeout(() => void import("../lib/push").then((m) => m.refreshPush(dataSource.push!)).catch(() => undefined), 5000);
    return () => clearTimeout(t);
  }, [viewerId]);

  // Signed in: every few minutes (while visible) ask the server to open Worlds that have started and tell their members.
  useEffect(() => {
    const tick = dataSource.worlds?.tick;
    if (!viewerId || !tick) return;
    const run = () => document.visibilityState === "visible" && void tick().catch(() => undefined);
    const first = setTimeout(run, 8000);
    const every = setInterval(run, 5 * 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [viewerId]);

  const value: SessionState = recovering && state.status === "signedIn" ? { status: "recovery" } : state;
  return (
    <SessionContext.Provider value={value}>
      <RecoveryDoneContext.Provider value={() => setRecovering(false)}>{children}</RecoveryDoneContext.Provider>
    </SessionContext.Provider>
  );
}

export function useSession() {
  return useContext(SessionContext);
}

/** For screens rendered inside the signed-in shell. */
export function useViewer(): Viewer {
  const s = useContext(SessionContext);
  if (s.status !== "signedIn") throw new Error("useViewer used outside the signed-in app");
  return s.viewer;
}
