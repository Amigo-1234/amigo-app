import { useState, type FormEvent } from "react";
import { ShieldCheck } from "lucide-react";
import { dataSource } from "../../data";
import { useSecurity } from "../../state/security";
import { useViewer } from "../../state/session";
import { useToast } from "../../state/toast";
import { Button } from "../../ui/Button";
import { Sheet } from "../../ui/Sheet";
import "./Security.css";

const KEY_ERRORS: Record<string, string> = {
  "bad-recovery-key": "That doesn't look like a recovery key. Check for typos — spaces don't matter.",
  "wrong-recovery-key": "That recovery key doesn't match your backup.",
  "no-backup": "Your account has no message backup — leave the recovery key empty to continue.",
};

/**
 * Shown instead of Messages on a device that isn't approved yet. A new sign-in
 * (even with the right password) can't read anything until one of your
 * devices approves it — or you reset secure messaging here.
 */
export function DeviceGate() {
  const { setup, verify, refreshSetup } = useSecurity();
  const [resetting, setResetting] = useState(false);
  const simulated = dataSource.messages?.security?.simulated;
  const canApprove = !!setup?.canVerifyWithOtherDevice;

  return (
    <div className="device-gate">
      {simulated && <p className="sec-sim">Demo simulation — no real keys are involved</p>}
      <ShieldCheck size={36} aria-hidden="true" className="verify__icon" />
      <h2>Confirm it's you</h2>
      <p>
        This is a new device for your messages. To keep them private, approve it from a device where you're already signed in — you'll
        compare emoji on both screens.
      </p>
      <div className="device-gate__actions">
        {canApprove && <Button onClick={() => verify("self")}>Approve from another device</Button>}
        <Button variant={canApprove ? "ghost" : "primary"} onClick={() => setResetting(true)}>
          {canApprove ? "I can't use my other devices" : "Set up secure messaging here"}
        </Button>
      </div>
      <p className="sec-intro">Someone who learns your password still can't read your messages without one of your devices or your recovery key.</p>

      <Sheet open={resetting} onClose={() => setResetting(false)} label="Reset secure messaging">
        {resetting && (
          <ResetSheet
            onDone={() => {
              setResetting(false);
              refreshSetup();
            }}
            onCancel={() => setResetting(false)}
          />
        )}
      </Sheet>
    </div>
  );
}

function ResetSheet({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const api = dataSource.messages!.security!;
  const viewer = useViewer();
  const toast = useToast();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let restored = 0;
      if (key.trim()) restored = (await api.restoreBackup(viewer.id, key)).imported;
      await api.resetIdentity(viewer.id);
      toast(restored ? `Secure messaging is set up here — ${restored} message keys restored` : "Secure messaging is set up on this device");
      onDone();
    } catch (err) {
      setError(KEY_ERRORS[(err as { code?: string }).code ?? ""] ?? "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="sheet-form" onSubmit={go}>
      <h2 className="sheet-form__title">Reset secure messaging?</h2>
      <ul className="sheet-form__body" style={{ margin: 0, paddingLeft: "1.2em", display: "grid", gap: 4 }}>
        <li>This device gets a new security key and can send and receive messages.</li>
        <li>People you talk to will see that your security key changed. Anyone who verified you will be asked to check again.</li>
        <li>Your other devices will need to be approved again.</li>
        <li>Without your recovery key, older messages stay unreadable here. New messages work either way.</li>
      </ul>
      <label className="field">
        <span className="field__label">Recovery key (optional — restores older messages)</span>
        <textarea
          className="field__input sec-input"
          rows={2}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={!!error}
        />
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="sheet-form__actions">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={busy}>
          Reset and continue
        </Button>
      </div>
    </form>
  );
}
