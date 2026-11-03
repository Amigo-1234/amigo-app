import { useEffect, useState } from "react";
import { Link } from "react-router";
import { BellRing, X } from "lucide-react";
import { dataSource } from "../../data";
import { enablePush, pushStatus, type PushStatus } from "../../lib/push";
import { useViewer } from "../../state/session";
import { useToast } from "../../state/toast";
import { Button, IconButton } from "../../ui/Button";
import { PUSH_DETAIL, pushErrorText } from "./pushCopy";
import { dismissPrompt, notificationPermission, promptDismissed, promptView } from "./promptRules";
import "./PushPrompt.css";

/**
 * Home's notification opt-in (rules in ./promptRules.ts). The browser's own permission
 * question appears only after "Enable notifications" is tapped; enablePush reuses this
 * device's existing subscription, so turning it on twice never registers it twice.
 */
export function PushPrompt() {
  const api = dataSource.push;
  const viewer = useViewer();
  const toast = useToast();
  const [dismissed, setDismissed] = useState(() => promptDismissed(viewer.id));
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api || dismissed) return;
    let live = true;
    pushStatus(api).then((s) => live && setStatus(s), () => live && setStatus("unsupported"));
    return () => {
      live = false;
    };
  }, [api, dismissed]);

  // After a failed attempt the browser may already say "granted": keep the card so the reason stays visible.
  const view = api ? (promptView(status, notificationPermission(), dismissed) ?? (error && !dismissed ? "ask" : null)) : null;
  if (!view) return null;

  const close = () => {
    dismissPrompt(viewer.id);
    setDismissed(true);
  };

  async function enable() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await enablePush(api!);
      if (next === "on") {
        toast("Notifications are on for this device");
        close();
      } else if (next === "denied") {
        setStatus("denied"); // explain how to allow them; the browser won't ask again
      } else {
        close(); // the browser's question was closed without an answer: treat it as "maybe later"
      }
    } catch (e) {
      console.warn("push:", e instanceof Error ? e.message : String(e));
      setError(pushErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  const title = view === "ask" ? "Know when your people reach out" : view === "denied" ? "Notifications are blocked" : "Get notifications on iPhone";
  const text =
    view === "ask"
      ? "Get a notification for new messages, replies and Worlds going live — even when Amigo is closed. Messages never show their text."
      : PUSH_DETAIL[view === "denied" ? "denied" : "ios-home-screen"];

  return (
    <section className="push-prompt" aria-labelledby="push-prompt-title">
      <span className="push-prompt__icon" aria-hidden="true">
        <BellRing size={20} />
      </span>
      <div className="push-prompt__body">
        <h2 id="push-prompt-title" className="push-prompt__title">
          {title}
        </h2>
        <p className="push-prompt__text">{text}</p>
        {error && (
          <p className="push-prompt__error" role="alert">
            {error}
          </p>
        )}
        <div className="push-prompt__actions">
          {view === "ask" ? (
            <>
              <Button size="sm" loading={busy} disabled={busy} onClick={() => void enable()}>
                Enable notifications
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={close}>
                Maybe later
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="secondary" onClick={close}>
                Got it
              </Button>
              <Link to="/settings/notifications" className="push-prompt__link" onClick={close}>
                Notification settings
              </Link>
            </>
          )}
        </div>
      </div>
      {view === "ask" && (
        <IconButton label="Close" size="sm" onClick={close} disabled={busy}>
          <X size={18} />
        </IconButton>
      )}
    </section>
  );
}
