import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { ArrowLeft, Check, Copy, Download, KeyRound, LifeBuoy, ShieldCheck } from "lucide-react";
import { dataSource, type KeyBackupStatus } from "../data";
import { ScreenHeader } from "../shell/ScreenHeader";
import { useSecurity } from "../state/security";
import { useViewer } from "../state/session";
import { useToast } from "../state/toast";
import { Button, IconButton } from "../ui/Button";
import { Sheet } from "../ui/Sheet";
import "../features/messages/Security.css";

const RESTORE_ERRORS: Record<string, string> = {
  "bad-recovery-key": "That doesn't look like a recovery key. Check for typos — spaces don't matter.",
  "wrong-recovery-key": "That recovery key doesn't match your backup. If you changed it, use the newest one.",
  "no-backup": "There's no backup on your account yet.",
};

/** Settings → Message backup: encrypted key backup with a recovery key only the person has. */
export default function BackupScreen() {
  const api = dataSource.messages!.security!;
  const viewer = useViewer();
  const navigate = useNavigate();
  const toast = useToast();
  const { setup, verify } = useSecurity();
  const [status, setStatus] = useState<KeyBackupStatus | null>(null);
  const [reload, setReload] = useState(0);
  const [settingUp, setSettingUp] = useState(false);
  const [restoreKey, setRestoreKey] = useState("");
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.backupStatus(viewer.id).then((s) => !cancelled && setStatus(s), () => !cancelled && setStatus({ exists: false, keyCount: 0, thisDeviceHasKey: false }));
    return () => {
      cancelled = true;
    };
  }, [api, viewer.id, reload]);

  async function restore(e: FormEvent) {
    e.preventDefault();
    if (!restoreKey.trim()) return;
    setRestoring(true);
    setRestoreError(null);
    try {
      const r = await api.restoreBackup(viewer.id, restoreKey);
      toast(`Restored ${r.imported} message key${r.imported === 1 ? "" : "s"} — older messages can be read on this device now`);
      setRestoreKey("");
      setReload((n) => n + 1);
    } catch (err) {
      setRestoreError(RESTORE_ERRORS[(err as { code?: string }).code ?? ""] ?? "Couldn't restore. Try again.");
    } finally {
      setRestoring(false);
    }
  }

  return (
    <>
      <ScreenHeader
        title="Message backup"
        leading={
          <IconButton label="Back" className="back-btn" onClick={() => navigate("/settings")}>
            <ArrowLeft size={22} />
          </IconButton>
        }
      />
      <div className="sec-page">
        {api.simulated && <p className="sec-sim">Demo simulation — no real keys are backed up</p>}

        <section className="sec-card" aria-labelledby="backup-status">
          <h2 id="backup-status">
            <ShieldCheck size={20} aria-hidden="true" /> {status?.exists ? "Backup is on" : "Backup is off"}
          </h2>
          {!status ? (
            <p>Checking…</p>
          ) : !status.exists ? (
            <>
              <p>
                Back up the keys to your messages, encrypted with a <strong>recovery key</strong> only you have. If you lose all your devices,
                your recovery key lets you read your old messages on a new one. Amigo can't read the backup.
              </p>
              <div className="sec-card__actions">
                <Button onClick={() => setSettingUp(true)} icon={<KeyRound size={18} aria-hidden="true" />}>
                  Set up backup
                </Button>
              </div>
            </>
          ) : status.thisDeviceHasKey ? (
            <>
              <p>
                {status.keyCount} message key{status.keyCount === 1 ? "" : "s"} backed up. This device keeps the backup up to date.
              </p>
              <div className="sec-card__actions">
                <Button variant="secondary" onClick={() => setSettingUp(true)}>
                  Create a new recovery key
                </Button>
              </div>
            </>
          ) : (
            <p>
              Your account has a backup, but this device doesn't have its key yet. Enter your recovery key below to read older messages here
              {setup?.canVerifyWithOtherDevice ? ", or approve this device from one of your other devices" : ""}.
            </p>
          )}
        </section>

        {status?.exists && !status.thisDeviceHasKey && (
          <section className="sec-card" aria-labelledby="restore">
            <h2 id="restore">
              <KeyRound size={20} aria-hidden="true" /> Restore older messages
            </h2>
            <form onSubmit={restore} className="sheet-form" style={{ padding: 0 }}>
              <label className="field">
                <span className="field__label">Recovery key</span>
                <textarea
                  className="field__input sec-input"
                  rows={2}
                  value={restoreKey}
                  onChange={(e) => setRestoreKey(e.target.value)}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-invalid={!!restoreError}
                  aria-describedby={restoreError ? "restore-error" : undefined}
                />
              </label>
              {restoreError && (
                <p className="form-error" id="restore-error" role="alert">
                  {restoreError}
                </p>
              )}
              <div className="sec-card__actions">
                <Button type="submit" loading={restoring} disabled={!restoreKey.trim()}>
                  Restore
                </Button>
                {setup && !setup.deviceVerified && setup.canVerifyWithOtherDevice && (
                  <Button type="button" variant="secondary" onClick={() => verify("self")}>
                    Approve from another device instead
                  </Button>
                )}
              </div>
            </form>
          </section>
        )}

        <section className="sec-card" aria-labelledby="lost">
          <h2 id="lost">
            <LifeBuoy size={20} aria-hidden="true" /> If you lose your recovery key
          </h2>
          <ul>
            <li>Amigo can't recover it for you — it never leaves your devices.</li>
            <li>If you're still signed in on a device, create a new recovery key here. The old one stops working.</li>
            <li>If you lose your recovery key <strong>and</strong> all your devices, your old messages can't be read again. New messages still work.</li>
            <li>
              Resetting your password doesn't open your messages to anyone: a new sign-in can't read them until it's approved from one of your
              devices or has your recovery key.
            </li>
          </ul>
        </section>
      </div>

      <Sheet open={settingUp} onClose={() => setSettingUp(false)} label="Set up message backup">
        {settingUp && (
          <SetupBackup
            replacing={!!status?.exists}
            onDone={() => {
              setSettingUp(false);
              setReload((n) => n + 1);
            }}
            onCancel={() => setSettingUp(false)}
          />
        )}
      </Sheet>
    </>
  );
}

function SetupBackup({ replacing, onDone, onCancel }: { replacing: boolean; onDone: () => void; onCancel: () => void }) {
  const api = dataSource.messages!.security!;
  const viewer = useViewer();
  const toast = useToast();
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  async function create() {
    setBusy(true);
    try {
      setKey(await api.setUpBackup(viewer.id));
    } catch {
      toast("Couldn't set up backup. Try again.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
      setCopied(true);
    } catch {
      toast("Couldn't copy — select the key and copy it instead", "error");
    }
  }

  function download() {
    if (!key) return;
    const text = `Amigo World message recovery key\n\n${key}\n\nKeep this somewhere safe, like a password manager. Anyone with this key and your account can read your message history.\n`;
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: "amigo-recovery-key.txt" });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (!key) {
    return (
      <div className="sheet-form">
        <h2 className="sheet-form__title">{replacing ? "Create a new recovery key?" : "Set up message backup"}</h2>
        <p className="sheet-form__body">
          {replacing
            ? "Your current recovery key will stop working. Your backup is re-created with the new key."
            : "Your device will create a recovery key. You'll need it to read your old messages if you ever lose all your devices. Amigo never sees it."}
        </p>
        <div className="sheet-form__actions">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button loading={busy} onClick={create}>
            {replacing ? "Create new key" : "Create recovery key"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="sheet-form">
      <h2 className="sheet-form__title">Save your recovery key</h2>
      <p className="sheet-form__body">
        Store it somewhere safe, like a password manager. It's shown only now. Anyone with this key and your account could read your message
        history, so don't share it.
      </p>
      <p className="recovery-key" aria-label="Recovery key">
        {key}
      </p>
      <div className="sec-card__actions">
        <Button variant="secondary" size="sm" onClick={copy} icon={copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}>
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button variant="secondary" size="sm" onClick={download} icon={<Download size={16} aria-hidden="true" />}>
          Download
        </Button>
      </div>
      <label className="choice">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>I've saved my recovery key somewhere safe</span>
      </label>
      <div className="sheet-form__actions">
        <Button disabled={!saved} onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
