import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { dataSource, type MessagingDevice, type MessagingSetup, type VerificationFlow } from "../data";
import { VerificationSheet } from "../features/messages/VerificationSheet";
import { useViewer } from "./session";
import { useToast } from "./toast";

/** Devices, verification and key backup exist where messages are end-to-end encrypted (and in the demo, simulated). */
export const securityApi = dataSource.messages?.security ?? null;

interface SecurityState {
  /** null while loading (or no security on this backend). */
  setup: MessagingSetup | null;
  refreshSetup: () => void;
  devices: MessagingDevice[] | null;
  /** Sign-ins added after this device that you haven't acknowledged yet. */
  newDevices: MessagingDevice[];
  acknowledgeDevices: () => void;
  /** Opens the emoji verification sheet with someone (or "self" to approve this device). */
  verify: (peerId: string | "self") => Promise<void>;
  /** This device was removed from the account elsewhere. */
  removed: boolean;
}

const SecurityContext = createContext<SecurityState>({
  setup: null,
  refreshSetup: () => {},
  devices: null,
  newDevices: [],
  acknowledgeDevices: () => {},
  verify: async () => {},
  removed: false,
});

const ackKey = (viewerId: string) => `amigo.devices.seen.${viewerId}`;
function readAck(viewerId: string): Set<string> | null {
  try {
    const raw = localStorage.getItem(ackKey(viewerId));
    return raw ? new Set(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}
function writeAck(viewerId: string, ids: Iterable<string>) {
  try {
    localStorage.setItem(ackKey(viewerId), JSON.stringify([...ids]));
  } catch {
    /* private mode */
  }
}

export function SecurityProvider({ children }: { children: ReactNode }) {
  const viewer = useViewer();
  const toast = useToast();
  const api = securityApi;
  const [setup, setSetup] = useState<MessagingSetup | null>(null);
  const [setupKey, setSetupKey] = useState(0);
  const [devices, setDevices] = useState<MessagingDevice[] | null>(null);
  const [ack, setAck] = useState<Set<string> | null>(() => readAck(viewer.id));
  const [flows, setFlows] = useState<VerificationFlow[]>([]);
  const [openFlow, setOpenFlow] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [removed, setRemoved] = useState(false);

  const onError = useCallback((e: Error) => {
    if ((e as { code?: string }).code === "device-removed") setRemoved(true);
    // Background polling: a dropped request (offline, navigating away) is retried on the next tick.
    else console.warn("Messaging security check failed; will retry", e);
  }, []);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api.setup(viewer.id).then((s) => !cancelled && setSetup(s), onError);
    return () => {
      cancelled = true;
    };
  }, [api, viewer.id, setupKey, onError]);

  useEffect(() => {
    if (!api) return;
    return api.subscribeDevices(viewer.id, { onData: setDevices, onError });
  }, [api, viewer.id, onError]);

  useEffect(() => {
    if (!api) return;
    return api.subscribeVerifications(viewer.id, {
      onData: (list) => {
        setFlows(list);
        // Someone (or your other device) asks to verify: show it.
        const incoming = list.find((f) => f.state === "incoming");
        if (incoming) setOpenFlow((cur) => cur ?? incoming.id);
      },
      onError,
    });
  }, [api, viewer.id, onError]);

  // First run on this browser: devices older than this one count as seen; anything added after it is new.
  useEffect(() => {
    if (devices && !ack) {
      const current = devices.find((d) => d.current);
      if (!current) return;
      const seen = new Set(devices.filter((d) => d.createdAt.getTime() <= current.createdAt.getTime()).map((d) => d.id));
      writeAck(viewer.id, seen);
      setAck(seen);
    }
  }, [devices, ack, viewer.id]);

  const newDevices = useMemo(() => {
    if (!devices || !ack) return [];
    return devices.filter((d) => !d.current && !ack.has(d.id));
  }, [devices, ack]);

  const acknowledgeDevices = useCallback(() => {
    if (!devices) return;
    const all = new Set([...(ack ?? []), ...devices.map((d) => d.id)]);
    writeAck(viewer.id, all);
    setAck(all);
  }, [devices, ack, viewer.id]);

  const verify = useCallback(
    async (peerId: string | "self") => {
      if (!api) return;
      try {
        const id = await api.startVerification(viewer.id, peerId);
        setOpenFlow(id);
      } catch (e) {
        const code = (e as { code?: string }).code;
        toast(
          code === "no-other-device"
            ? peerId === "self"
              ? "No other verified device to approve this one."
              : "They need to open Amigo World on a device first."
            : "Couldn't start verification. Try again.",
          "error",
        );
      }
    },
    [api, viewer.id, toast],
  );

  const flow = flows.find((f) => f.id === openFlow && !dismissed.has(f.id)) ?? null;
  const close = useCallback(() => {
    if (openFlow) setDismissed((d) => new Set(d).add(openFlow));
    setOpenFlow(null);
  }, [openFlow]);

  // A finished verification can change what this device may do (approved) and how people show.
  useEffect(() => {
    if (flow?.state === "done") setSetupKey((k) => k + 1);
  }, [flow?.state]);

  const value = useMemo<SecurityState>(
    () => ({ setup, refreshSetup: () => setSetupKey((k) => k + 1), devices, newDevices, acknowledgeDevices, verify, removed }),
    [setup, devices, newDevices, acknowledgeDevices, verify, removed],
  );

  return (
    <SecurityContext.Provider value={value}>
      {children}
      {api && <VerificationSheet flow={flow} onClose={close} />}
    </SecurityContext.Provider>
  );
}

export const useSecurity = () => useContext(SecurityContext);
