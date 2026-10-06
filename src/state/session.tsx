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
