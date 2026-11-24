import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { Plus, Share, X } from "lucide-react";
import { dataSource } from "../../data";
import { canPromptInstall, isIOS, isStandalone, promptInstall } from "../../lib/install";
import { useComposer } from "../../state/composer";
import { useViewer } from "../../state/session";
import { Button } from "../../ui/Button";
import { tourDone } from "./Tour";
import "./InstallBubble.css";

/**
 * "Add Amigo to your Home Screen" bubble on Home, for people using the app in a browser:
 * iPhone/iPad Safari get the Share → Add to Home Screen steps (iOS has no install prompt);
 * Android/Chrome get an Install button. Never in the installed app, never during the tour.
 * "Not now" hides it for two weeks on this device.
 */
const KEY = "amigo:install-bubble";
const SNOOZE_MS = 14 * 24 * 3600 * 1000;

function snoozed(): boolean {
  try {
    return Date.now() < Number(localStorage.getItem(KEY) ?? 0);
  } catch {
    return true;
  }
}
function snooze() {
  try {
    localStorage.setItem(KEY, String(Date.now() + SNOOZE_MS));
  } catch {
    /* ignore */
  }
}

export function InstallBubble() {
  const viewer = useViewer();
  const composer = useComposer();
  const { pathname } = useLocation();
  const [kind, setKind] = useState<"ios" | "prompt" | null>(null);

  useEffect(() => {
    if (pathname !== "/" || composer.open || isStandalone() || snoozed()) return setKind(null);
    if (dataSource.kind === "demo" && !/[?&]install\b/.test(location.search)) return;
    // Wait until the first-visit tour is finished, then a moment more.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = setInterval(() => {
      if (!tourDone(viewer.id) || document.querySelector(".tour")) return;
      clearInterval(check);
      timer = setTimeout(() => setKind(isIOS() ? "ios" : canPromptInstall() ? "prompt" : null), 2500);
    }, 1000);
    return () => {
      clearInterval(check);
      if (timer) clearTimeout(timer);
    };
  }, [pathname, composer.open, viewer.id]);

  if (!kind) return null;
  const close = () => {
    snooze();
    setKind(null);
  };

  return (
    <div className="install-bubble" role="dialog" aria-labelledby="install-title">
      <button type="button" className="install-bubble__close" onClick={close} aria-label="Not now">
        <X size={18} />
      </button>
      <img className="install-bubble__icon" src="/icons/icon-192.png" alt="" onError={(e) => (e.currentTarget.style.display = "none")} />
      <div className="install-bubble__text">
        <p id="install-title" className="install-bubble__title">
          Add Amigo World to your Home Screen
        </p>
        {kind === "ios" ? (
          <ol className="install-bubble__steps">
            <li>
              Tap <Share size={15} className="install-bubble__glyph" aria-label="Share" /> <strong>Share</strong> in Safari's toolbar (on newer iPhones, tap <strong>⋯</strong> first).
            </li>
            <li>
              Choose <Plus size={15} className="install-bubble__glyph" aria-hidden="true" /> <strong>Add to Home Screen</strong>, then <strong>Add</strong>.
            </li>
          </ol>
        ) : (
          <p className="install-bubble__body">Open it like an app, full screen, straight from your Home Screen.</p>
        )}
        <div className="install-bubble__actions">
          {kind === "prompt" && (
            <Button
              type="button"
              size="sm"
              onClick={async () => {
                const done = await promptInstall();
                if (done) close();
                else setKind(null);
              }}
            >
              Install
            </Button>
          )}
          <Button type="button" size="sm" variant={kind === "prompt" ? "ghost" : "secondary"} onClick={close}>
            {kind === "ios" ? "Got it" : "Not now"}
          </Button>
        </div>
      </div>
    </div>
  );
}
