import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "../../ui/Button";
import "./UpdateBanner.css";

const MIN_GAP_MS = 10 * 60_000;
const FIRST_CHECK_MS = 60_000;

/**
 * Tells people when a newer build is live, so a Home Screen app resumed from
 * memory doesn't keep running old code. One tiny request (/version.json, not
 * cached) when the app comes back to the foreground, at most every 10 minutes —
 * never while hidden, never on a timer loop. It never reloads by itself: the
 * person taps Reload when they're ready, so nothing they're writing or
 * uploading is interrupted.
 */
export function UpdateBanner() {
  const [newer, setNewer] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    if (!import.meta.env.PROD) return;
    let last = 0;
    let stopped = false;
    const check = async () => {
      if (stopped || document.visibilityState !== "visible" || !navigator.onLine || Date.now() - last < MIN_GAP_MS) return;
      last = Date.now();
      try {
        const res = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) return;
        const { version } = (await res.json()) as { version?: string };
        if (version && version !== __APP_VERSION__ && !stopped) setNewer(version);
      } catch {
        // Offline or blocked: try again next time the app comes back.
      }
    };
    const first = setTimeout(check, FIRST_CHECK_MS);
    const onVisible = () => void check();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      stopped = true;
      clearTimeout(first);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, []);

  if (!newer || newer === dismissed) return null;
  return (
    <div className="update-banner" role="status">
      <RefreshCw size={18} aria-hidden="true" />
      <p>A new version of Amigo World is ready.</p>
      <Button size="sm" onClick={() => location.reload()}>
        Reload
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setDismissed(newer)}>
        Later
      </Button>
    </div>
  );
}
