import { useState } from "react";
import { CircleCheck, CircleX, ShieldCheck } from "lucide-react";
import { dataSource, type VerificationFlow } from "../../data";
import { useViewer } from "../../state/session";
import { Button } from "../../ui/Button";
import { Sheet } from "../../ui/Sheet";
import "./Security.css";

/**
 * Emoji verification (SAS): both screens show the same 7 emoji only if no one
 * is in the middle. The same sheet handles verifying a person and approving
 * one of your own devices.
 */
export function VerificationSheet({ flow, onClose }: { flow: VerificationFlow | null; onClose: () => void }) {
  const api = dataSource.messages?.security;
  const viewer = useViewer();
  const [busy, setBusy] = useState(false);
  if (!api) return null;

  const who = flow?.self ? "your other device" : flow?.peer?.name ?? "them";
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  const cancel = () => {
    if (flow && flow.state !== "done" && flow.state !== "cancelled") void api.cancelVerification(viewer.id, flow.id).catch(() => undefined);
    onClose();
  };

  return (
    <Sheet open={!!flow} onClose={cancel} label="Verification">
      {flow && (
        <div className="sheet-form verify" aria-live="polite">
          {api.simulated && <p className="sec-sim">Demo simulation — no real keys are involved</p>}

          {flow.state === "incoming" && (
            <>
              <ShieldCheck className="verify__icon" size={32} aria-hidden="true" />
              <h2 className="sheet-form__title">{flow.self ? "Approve a new sign-in?" : `${flow.peer?.name} wants to verify with you`}</h2>
              <p className="sheet-form__body">
                {flow.self
                  ? "One of your devices is asking to read your messages. Only continue if it's you — you'll compare emoji on both screens."
                  : "You'll both see a set of emoji. If they match, you know your conversation can't be read by anyone else."}
              </p>
              <div className="sheet-form__actions">
                <Button variant="ghost" onClick={cancel}>Not now</Button>
                <Button loading={busy} onClick={() => act(() => api.acceptVerification(viewer.id, flow.id))}>Continue</Button>
              </div>
            </>
          )}

          {(flow.state === "waiting" || flow.state === "starting") && (
            <>
              <span className="verify__spinner" aria-hidden="true" />
              <h2 className="sheet-form__title">{flow.state === "waiting" ? `Waiting for ${who}…` : "Connecting securely…"}</h2>
              <p className="sheet-form__body">
                {flow.state === "waiting"
                  ? flow.self
                    ? "Open Amigo World on a device you're already signed in on and accept the request there."
                    : `Ask ${flow.peer?.name} to open Amigo World. They'll see a request to verify.`
                  : "Setting up the emoji to compare."}
              </p>
              <div className="sheet-form__actions">
                <Button variant="ghost" onClick={cancel}>Cancel</Button>
              </div>
            </>
          )}

          {flow.state === "compare" && flow.emoji && (
            <>
              <h2 className="sheet-form__title">Compare emoji</h2>
              <p className="sheet-form__body">
                Check that {flow.self ? "your other device" : flow.peer?.name} shows the same emoji, in the same order.
                {!flow.self && " Compare in person or on a call — not over messages."}
              </p>
              <ol className="verify__emoji" aria-label="Emoji to compare">
                {flow.emoji.map((e, i) => (
                  <li key={i}>
                    <span className="verify__emoji-symbol" aria-hidden="true">{e.symbol}</span>
                    <span className="verify__emoji-name">{e.name}</span>
                  </li>
                ))}
              </ol>
              <div className="sheet-form__actions">
                <Button variant="ghost" disabled={busy} onClick={() => act(() => api.rejectVerification(viewer.id, flow.id))}>
                  They don't match
                </Button>
                <Button loading={busy} onClick={() => act(() => api.confirmVerification(viewer.id, flow.id))}>They match</Button>
              </div>
            </>
          )}

          {flow.state === "confirmed" && (
            <>
              <span className="verify__spinner" aria-hidden="true" />
              <h2 className="sheet-form__title">Waiting for {who} to confirm…</h2>
              <p className="sheet-form__body">They need to tap "They match" too.</p>
            </>
          )}

          {flow.state === "done" && (
            <>
              <CircleCheck className="verify__icon verify__icon--ok" size={36} aria-hidden="true" />
              <h2 className="sheet-form__title">{flow.self ? "This device is approved" : `${flow.peer?.name} is verified`}</h2>
              <p className="sheet-form__body">
                {flow.self
                  ? "It can now read and send your messages. If you use message backup, its key was shared with this device securely."
                  : "Your conversation is protected from anyone pretending to be them. If their security key ever changes, you'll be told."}
              </p>
              <div className="sheet-form__actions">
                <Button onClick={onClose}>Done</Button>
              </div>
            </>
          )}

          {flow.state === "cancelled" && (
            <>
              <CircleX className="verify__icon" size={36} aria-hidden="true" />
              <h2 className="sheet-form__title">{flow.cancelReason === "mismatch" ? "Not verified" : flow.cancelReason === "timeout" ? "Verification timed out" : "Verification cancelled"}</h2>
              <p className="sheet-form__body">
                {flow.cancelReason === "mismatch"
                  ? "The emoji didn't match, so nothing was marked as trusted. Try again — if it keeps happening, check with them another way."
                  : "Nothing was changed. You can start again any time."}
              </p>
              <div className="sheet-form__actions">
                <Button variant="secondary" onClick={onClose}>Close</Button>
              </div>
            </>
          )}
        </div>
      )}
    </Sheet>
  );
}
