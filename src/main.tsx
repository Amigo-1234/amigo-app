import "./lib/install";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/bricolage-grotesque";
import "./styles/tokens.css";
import "./styles/base.css";
import "./ui/Button.css";
import "./ui/forms.css";
import App from "./App";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { installErrorReporting } from "./lib/errorReport";
import { installPerfReporting } from "./lib/perf";
import { dataSource } from "./data";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
installErrorReporting();
installPerfReporting(dataSource.reportPerf);

// Minimal worker: an offline page for failed page loads, nothing else cached
// (see public/sw.js). Registering also replaces the old cache-first worker.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  const register = () => void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  // The data layer's top-level await can delay this module past the load event.
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register);
}
