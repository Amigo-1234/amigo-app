import { Component, useEffect, type ReactNode } from "react";
import { useRouteError } from "react-router";
import { reportError } from "../lib/errorReport";

/** Last line of defence: a crash shows a way out instead of a blank screen. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    reportError("render", error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="crash" role="alert">
        <h1>Something went wrong</h1>
        <p>Amigo hit an unexpected problem. Your messages and posts are safe.</p>
        <button type="button" className="btn btn--primary btn--md" onClick={() => location.reload()}>
          Reload
        </button>
        <a href="/" className="crash__home">
          Go to Home
        </a>
      </main>
    );
  }
}

/** Router-level errors (a screen failed to render or a lazy chunk failed to load). */
export function RouteError() {
  const error = useRouteError();
  useEffect(() => reportError("render", error), [error]);
  // A new deployment replaced the chunk this tab expected: a reload fixes it.
  const stale = /dynamically imported module|Importing a module script failed|Failed to fetch/i.test(String((error as Error)?.message ?? ""));
  return (
    <main className="crash" role="alert">
      <h1>{stale ? "Amigo was updated" : "Something went wrong"}</h1>
      <p>{stale ? "Reload to get the latest version." : "This screen hit an unexpected problem. Your messages and posts are safe."}</p>
      <button type="button" className="btn btn--primary btn--md" onClick={() => location.reload()}>
        Reload
      </button>
      <a href="/" className="crash__home">
        Go to Home
      </a>
    </main>
  );
}
