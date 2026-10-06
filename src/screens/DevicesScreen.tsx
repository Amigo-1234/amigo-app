import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ArrowLeft, Laptop, Monitor, ShieldCheck, Smartphone, Tablet } from "lucide-react";
import { dataSource, type MessagingDevice } from "../data";
import { timeAgoLong } from "../lib/time";
import { ScreenHeader } from "../shell/ScreenHeader";
import { useSecurity } from "../state/security";
import { useViewer } from "../state/session";
import { useToast } from "../state/toast";
import { Button, IconButton } from "../ui/Button";
import { Sheet } from "../ui/Sheet";
import { Skeleton } from "../ui/Skeleton";
import "../features/messages/Security.css";

function DeviceIcon({ name }: { name: string }) {
  if (/iPhone|Android/.test(name)) return <Smartphone size={20} aria-hidden="true" />;
  if (/iPad/.test(name)) return <Tablet size={20} aria-hidden="true" />;
  if (/macOS|Windows|Linux|ChromeOS/.test(name)) return <Laptop size={20} aria-hidden="true" />;
  return <Monitor size={20} aria-hidden="true" />;
}

/** Settings → Your devices: every device that can read your messages. */
export default function DevicesScreen() {
  const api = dataSource.messages!.security!;
  const viewer = useViewer();
  const navigate = useNavigate();
  const toast = useToast();
  const { devices, newDevices, acknowledgeDevices, setup, verify } = useSecurity();
  const [removing, setRemoving] = useState<MessagingDevice | null>(null);
  const [busy, setBusy] = useState(false);
  // Highlight what was new while this page is open (it's marked as seen when you leave).
  const [newIds, setNewIds] = useState<Set<string>>(() => new Set(newDevices.map((d) => d.id)));
  useEffect(() => {
    if (newDevices.some((d) => !newIds.has(d.id))) setNewIds((s) => new Set([...s, ...newDevices.map((d) => d.id)]));
  }, [newDevices, newIds]);

  // Seeing the list counts as having seen new sign-ins (they stay highlighted until you leave).
  const ackRef = useRef(acknowledgeDevices);
  ackRef.current = acknowledgeDevices;
  useEffect(() => () => ackRef.current(), []);

  async function remove() {
    if (!removing) return;
    setBusy(true);
    try {
      await api.removeDevice(viewer.id, removing.id);
      toast(`Removed ${removing.name}`);
      setRemoving(null);
    } catch {
      toast("Couldn't remove that device. Try again.", "error");
    } finally {
      setBusy(false);
    }
  }

  const current = devices?.find((d) => d.current);

  return (
    <>
      <ScreenHeader
        title="Your devices"
        leading={
          <IconButton label="Back" className="back-btn" onClick={() => navigate("/settings")}>
            <ArrowLeft size={22} />
          </IconButton>
        }
      />
      <div className="sec-page">
        {api.simulated && <p className="sec-sim">Demo simulation — these devices are examples</p>}
        <p className="sec-intro">
          These devices can read your messages. Remove any you don't recognise — then change your password. New devices must be approved
          from one of your verified devices before they receive your messages.
        </p>

        {current && setup && !setup.deviceVerified && (
          <div className="sec-banner sec-banner--warn" role="status">
            <ShieldCheck size={18} aria-hidden="true" />
            <div className="sec-banner__text">
              <strong>This device isn't approved yet.</strong> Approve it from another device where you're signed in to read and send messages here.
              {setup.canVerifyWithOtherDevice && (
                <div className="sec-banner__actions">
                  <Button size="sm" onClick={() => verify("self")}>Approve this device</Button>
                </div>
              )}
            </div>
          </div>
        )}

        {!devices ? (
          <ul className="device-list" aria-busy="true" aria-label="Loading devices">
            {[0, 1].map((i) => (
              <li key={i} className="device-row">
                <Skeleton width={40} height={40} radius="var(--radius-md)" />
                <span className="device-row__body">
                  <Skeleton width="45%" height={14} />
                  <Skeleton width="65%" height={12} />
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <ul className="device-list" aria-label="Devices">
            {[...devices]
              .sort((a, b) => Number(b.current) - Number(a.current) || (b.lastActiveAt?.getTime() ?? 0) - (a.lastActiveAt?.getTime() ?? 0))
              .map((d) => (
                <li key={d.id} className={`device-row${newIds.has(d.id) ? " is-new" : ""}`}>
                  <span className="device-row__icon">
                    <DeviceIcon name={d.name} />
                  </span>
                  <span className="device-row__body">
                    <span className="device-row__name">
                      {d.name}
                      {d.current && <span className="chip-tag chip-tag--current">This device</span>}
                      {newIds.has(d.id) && <span className="chip-tag chip-tag--warn">New</span>}
                      {d.verified ? (
                        <span className="trust trust--verified">
                          <ShieldCheck size={13} aria-hidden="true" /> Verified
                        </span>
                      ) : (
                        <span className="chip-tag">Not verified</span>
                      )}
                    </span>
                    <span className="device-row__meta">
                      {d.current ? "Active now" : d.lastActiveAt ? `Active ${timeAgoLong(d.lastActiveAt)}` : "Not active yet"} · Added {timeAgoLong(d.createdAt)}
                    </span>
                  </span>
                  {!d.current && (
                    <Button size="sm" variant="secondary" onClick={() => setRemoving(d)}>
                      Remove
                    </Button>
                  )}
                </li>
              ))}
          </ul>
        )}
        <p className="sec-intro">
          "Verified" means the device was approved by your account (by comparing emoji with another of your devices). Unverified devices
          don't receive your messages.
        </p>
      </div>

      <Sheet open={!!removing} onClose={() => setRemoving(null)} label="Remove device">
        {removing && (
          <div className="sheet-form">
            <h2 className="sheet-form__title">Remove {removing.name}?</h2>
            <p className="sheet-form__body">
              It will stop receiving your messages straight away and be signed out of messages. If you didn't add it, change your password
              too — and if you use message backup, create a new recovery key so the old one stops working.
            </p>
            <div className="sheet-form__actions">
              <Button variant="ghost" onClick={() => setRemoving(null)}>
                Cancel
              </Button>
              <Button variant="danger" loading={busy} onClick={remove}>
                Remove
              </Button>
            </div>
          </div>
        )}
      </Sheet>
    </>
  );
}
