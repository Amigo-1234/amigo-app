import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { ArrowLeft, BellRing, Check, Heart, Mail, Orbit, PanelTop, Smartphone, Trash2, Volume2 } from "lucide-react";
import { dataSource, type NotificationPrefs, type PushDevice } from "../data";
import { alertPrefs, playAlertSound, setAlertPrefs, type AlertPrefs } from "../features/inapp/alertPrefs";
import { PUSH_DETAIL, pushErrorText } from "../features/notifications/pushCopy";
import { disablePush, enablePush, pushStatus, type PushStatus } from "../lib/push";
import { timeAgoLong } from "../lib/time";
import { ScreenHeader } from "../shell/ScreenHeader";
import { useViewer } from "../state/session";
import { useToast } from "../state/toast";
import { Button, IconButton } from "../ui/Button";
import { Skeleton } from "../ui/Skeleton";
import "./SettingsScreen.css";
import "../features/onboarding/Onboarding.css";

/**
 * Settings → Notifications: how Amigo gets your attention, on one screen.
 *
 *   - While Amigo is open: banners and sounds (this device, localStorage).
 *   - Push: this device on or off, then what to be pushed about (the account, all devices).
 *   - Your devices: the ones that get pushes, each removable.
 *
 * Same tiles as Settings → Interests. Behaviour is unchanged from when these rows sat
 * in Settings itself; only the layout is new.
 */
export default function NotificationSettingsScreen() {
  const navigate = useNavigate();
  const back = () => (window.history.state?.idx > 0 ? navigate(-1) : navigate("/settings"));
  return (
    <>
      <ScreenHeader
        title="Notifications"
        leading={
          <IconButton label="Back" onClick={back} className="back-btn">
            <ArrowLeft size={22} />
          </IconButton>
        }
      />
      <div className="settings notif-settings">
        <InAppAlertSettings />
        {dataSource.push && <PushSettings />}
      </div>
    </>
  );
}

/** An on/off tile, styled like an interest. The visible "On"/"Off" means colour isn't the only cue. */
function Tile({ icon: Icon, label, on, onClick }: { icon: typeof Mail; label: string; on: boolean; onClick: () => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} className={`onb-interest notif-tile${on ? " is-on" : ""}`} onClick={onClick}>
      <span className="onb-interest__icon" aria-hidden="true">
        {on ? <Check size={18} strokeWidth={3} /> : <Icon size={18} />}
      </span>
      <span className="notif-tile__text">
        {label}
        <span className="notif-tile__state" aria-hidden="true">
          {on ? "On" : "Off"}
        </span>
      </span>
    </button>
  );
}

/** Banners and sounds while the app is open — this device only. */
function InAppAlertSettings() {
  const [prefs, setPrefs] = useState(alertPrefs);
  const toggle = (k: keyof AlertPrefs) => {
    const next = setAlertPrefs({ [k]: !prefs[k] });
    setPrefs(next);
    if (k === "sounds" && next.sounds) playAlertSound("message");
  };
  return (
    <section className="settings-section" aria-labelledby="notif-open">
      <h3 id="notif-open" className="settings-section__title">
        While Amigo is open
      </h3>
      <div className="onb-interests notif-grid" role="group" aria-labelledby="notif-open">
        <Tile icon={PanelTop} label="Banners" on={prefs.banners} onClick={() => toggle("banners")} />
        <Tile icon={Volume2} label="Sounds" on={prefs.sounds} onClick={() => toggle("sounds")} />
      </div>
      <p className="settings-panel__text notif-note">
        This device only. Banners show new messages and activity at the top; sounds play once you've tapped somewhere (browsers require it).
      </p>
    </section>
  );
}

/** Locked-screen notifications for this device, what to be notified about, and your other devices. */
function PushSettings() {
  const api = dataSource.push!;
  const viewer = useViewer();
  const toast = useToast();
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [prefs, setPrefs] = useState<NotificationPrefs | null | "failed">(null);
  const [devices, setDevices] = useState<PushDevice[] | null>(null);

  useEffect(() => {
    let live = true;
    pushStatus(api).then((s) => live && setStatus(s), () => live && setStatus("unsupported"));
    api.prefs(viewer.id).then((p) => live && setPrefs(p), () => live && setPrefs("failed"));
    return () => {
      live = false;
    };
  }, [api, viewer.id]);
  const loadDevices = () => api.devices(viewer.id).then(setDevices, () => setDevices([]));
  useEffect(() => void loadDevices(), [status]); // eslint-disable-line react-hooks/exhaustive-deps

  async function toggle() {
    if (busy || !status) return;
    setBusy(true);
    try {
      if (status === "on") {
        await disablePush(api);
        setStatus("off");
        toast("Notifications turned off on this device");
      } else {
        const next = await enablePush(api);
        setStatus(next);
        if (next === "on") toast("Notifications are on for this device");
        else if (next === "denied") toast("Notifications are blocked — allow them in your settings", "error");
      }
    } catch (e) {
      // The reason only (e.g. "Registration failed - push service error"); no keys or endpoints.
      console.warn("push:", e instanceof Error ? e.message : String(e));
      toast(pushErrorText(e), "error");
      setStatus(await pushStatus(api).catch(() => "unsupported" as const));
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    const r = await api.sendTest();
    if (r === "sent") toast("Test sent — it should arrive in a few seconds");
    else if (r === "wait") toast("Wait a few seconds before sending another test");
    else toast("Couldn't send a test. Try again.", "error");
  }

  async function setPref(key: keyof NotificationPrefs, value: boolean) {
    setPrefs((p) => (p && p !== "failed" ? { ...p, [key]: value } : p));
    await api.setPrefs({ [key]: value }).catch(() => {
      setPrefs((p) => (p && p !== "failed" ? { ...p, [key]: !value } : p));
      toast("Couldn't save that. Try again.", "error");
    });
  }

  const canToggle = status === "on" || status === "off";
  return (
    <>
      <section className="settings-section" aria-labelledby="notif-push">
        <h3 id="notif-push" className="settings-section__title">
          Push notifications
        </h3>
        <div className="settings-card">
          <button type="button" className="settings-row settings-row--action" onClick={canToggle ? toggle : () => undefined}>
            <span className="settings-row__icon" aria-hidden="true">
              <BellRing size={20} />
            </span>
            <span className="settings-row__text">
              <span className="settings-row__title">On this device</span>
              <span className="settings-row__detail">{status ? PUSH_DETAIL[status] : "Checking…"}</span>
            </span>
            {busy ? (
              <span className="btn__spinner settings-row__spin" aria-hidden="true" />
            ) : canToggle ? (
              <span className={`settings-switch${status === "on" ? " is-on" : ""}`} role="switch" aria-checked={status === "on"} aria-label="Push notifications on this device" />
            ) : null}
          </button>
          {status === "on" && (
            <div className="settings-panel">
              <div className="settings-panel__actions">
                <Button size="sm" variant="secondary" onClick={sendTest}>
                  Send a test notification
                </Button>
              </div>
            </div>
          )}
        </div>
        {prefs !== "failed" && (
          <>
            <p id="notif-about" className="settings-panel__text notif-label">
              Push me about
            </p>
            {prefs ? (
              <div className="onb-interests notif-grid" role="group" aria-labelledby="notif-push notif-about">
                <Tile icon={Mail} label="New messages" on={prefs.messages} onClick={() => void setPref("messages", !prefs.messages)} />
                <Tile icon={Heart} label="Likes, replies and follows" on={prefs.social} onClick={() => void setPref("social", !prefs.social)} />
                {dataSource.worlds && <Tile icon={Orbit} label="Worlds" on={prefs.worlds} onClick={() => void setPref("worlds", !prefs.worlds)} />}
              </div>
            ) : (
              <div className="onb-interests notif-grid" aria-busy="true">
                <Skeleton height={52} />
                <Skeleton height={52} />
                <Skeleton height={52} />
              </div>
            )}
            <p className="settings-panel__text notif-note">
              Applies to all your devices. Message notifications never include the message itself — only that you have a new one. Likes, replies and
              follows also cover mentions and support on your Support Hub requests, grouped when lots happen at once. Worlds: when one you joined goes
              live, or is cancelled.
            </p>
          </>
        )}
      </section>
      {devices && devices.length > 0 && (
        <section className="settings-section" aria-labelledby="notif-devices">
          <h3 id="notif-devices" className="settings-section__title">
            Devices that get your notifications
          </h3>
          <div className="settings-card">
            <div className="settings-panel">
              <ul className="settings-devices">
                {devices.map((d) => (
                  <li key={d.id}>
                    <Smartphone size={18} aria-hidden="true" />
                    <span>
                      <span className="settings-devices__name">{d.label || "Device"}</span>
                      <span className="settings-devices__when">Active {timeAgoLong(d.lastSeenAt)}</span>
                    </span>
                    <IconButton
                      label={`Stop notifications on ${d.label || "this device"}`}
                      onClick={async () => {
                        await api.removeDevice(d.id).catch(() => toast("Couldn't remove it. Try again.", "error"));
                        await loadDevices();
                        setStatus(await pushStatus(api));
                      }}
                    >
                      <Trash2 size={18} />
                    </IconButton>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
