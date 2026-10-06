import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { dataSource, type Viewer } from "../data";

type SessionState = { status: "loading" } | { status: "signedOut" } | { status: "signedIn"; viewer: Viewer };

const SessionContext = createContext<SessionState>({ status: "loading" });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: "loading" });
  useEffect(
    () => dataSource.onViewerChanged((viewer) => setState(viewer ? { status: "signedIn", viewer } : { status: "signedOut" })),
    [],
  );
  return <SessionContext.Provider value={state}>{children}</SessionContext.Provider>;
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
