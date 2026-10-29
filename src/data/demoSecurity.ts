/**
 * Messaging security for the demo — a SIMULATION. The demo has no real keys
 * (its messages aren't encrypted), so devices, emoji verification and key
 * backup here only walk through the same screens and states the real,
 * end-to-end encrypted backend has (src/data/supabase/e2e.ts). The UI labels
 * it as simulated (`simulated: true`).
 *
 * Seeded so every state can be seen: a verified iPhone, a brand-new
 * unverified sign-in (triggers the new-device notice), Mira already verified,
 * and Kofi whose security key "changed" after you verified him.
 */
import type { Author, KeyBackupStatus, MessagingDevice, MessagingSecurityApi, PeerTrust, Subscription, VerificationFlow } from "./types";
import { SecurityError } from "./types";
import { describeDevice } from "../lib/device";

export interface SecurityContext {
  author: (id: string) => Author;
  watch: <T>(sub: Subscription<T>, read: () => T) => () => void;
  later: <T>(fn: () => T, ms?: number) => Promise<T>;
  emit: () => void;
  /** ?demo=newdevice: this browser starts as a new, unapproved device. */
  newDevice: boolean;
}

/** A few of the SAS emoji (the real list has 64; the library picks them in the real backend). */
const EMOJI: [string, string][] = [
  ["🐶", "Dog"], ["🐱", "Cat"], ["🦁", "Lion"], ["🐎", "Horse"], ["🦄", "Unicorn"], ["🐷", "Pig"], ["🐘", "Elephant"],
  ["🐰", "Rabbit"], ["🐼", "Panda"], ["🐓", "Rooster"], ["🐧", "Penguin"], ["🐢", "Turtle"], ["🐟", "Fish"], ["🐙", "Octopus"],
  ["🦋", "Butterfly"], ["🌷", "Flower"], ["🌳", "Tree"], ["🌵", "Cactus"], ["🍄", "Mushroom"], ["🌏", "Globe"], ["🌙", "Moon"],
  ["☁️", "Cloud"], ["🔥", "Fire"], ["🍌", "Banana"], ["🍎", "Apple"], ["🍓", "Strawberry"], ["🌽", "Corn"], ["🍕", "Pizza"],
  ["🎂", "Cake"], ["❤️", "Heart"], ["😀", "Smiley"], ["🤖", "Robot"], ["🎩", "Hat"], ["👓", "Glasses"], ["🔧", "Spanner"],
  ["🎅", "Santa"], ["👍", "Thumbs up"], ["☂️", "Umbrella"], ["⌛", "Hourglass"], ["⏰", "Clock"], ["🎁", "Gift"], ["💡", "Light bulb"],
];

const MIN = 60_000;
const pickEmoji = () => Array.from({ length: 7 }, () => EMOJI[Math.floor(Math.random() * EMOJI.length)]).map(([symbol, name]) => ({ symbol, name }));
const randomKey = () => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes = crypto.getRandomValues(new Uint8Array(43));
  return Array.from(bytes, (b) => alphabet[b % 64]).join("").replace(/(.{4})/g, "$1 ").trim();
};
const clean = (k: string) => k.replace(/\s+/g, "");

interface Saved {
  devices: MessagingDevice[];
  deviceVerified: boolean;
  trust: Record<string, PeerTrust>;
  backupKey: string | null;
  backupThisDevice: boolean;
}

export function createDemoSecurity(ctx: SecurityContext) {
  const now = Date.now();
  let devices: MessagingDevice[] = [
    { id: "DEMOBROWSER", name: describeDevice(), current: true, verified: !ctx.newDevice, createdAt: new Date(now - 30 * 24 * 60 * MIN), lastActiveAt: new Date(now) },
    { id: "DEMOIPHONE", name: "Safari on iPhone", current: false, verified: true, createdAt: new Date(now - 90 * 24 * 60 * MIN), lastActiveAt: new Date(now - 2 * 60 * MIN) },
    { id: "DEMONEW", name: "Firefox on Windows", current: false, verified: false, createdAt: new Date(now - 12 * MIN), lastActiveAt: new Date(now - 12 * MIN) },
  ];
  let deviceVerified = !ctx.newDevice;
  const trust: Record<string, PeerTrust> = { mira: "verified", kofi: "changed-verified" };
  let backupKey: string | null = null;
  let backupThisDevice = false;

  let flows: VerificationFlow[] = [];
  const flowListeners = new Set<() => void>();
  const emitFlows = () => {
    flowListeners.forEach((l) => l());
    ctx.emit();
  };
  const setFlow = (id: string, patch: Partial<VerificationFlow>) => {
    flows = flows.map((f) => (f.id === id ? { ...f, ...patch } : f));
    emitFlows();
  };
  let seq = 0;

  /** The other side of a simulated verification: picks up, shows emoji, confirms. */
  function simulateOtherSide(id: string) {
    setTimeout(() => setFlow(id, { state: "starting" }), 900);
    setTimeout(() => setFlow(id, { state: "compare", emoji: pickEmoji() }), 1700);
  }

  function finish(f: VerificationFlow) {
    if (f.self) {
      deviceVerified = true;
      devices = devices.map((d) => (d.current ? { ...d, verified: true } : d));
      if (backupKey) backupThisDevice = true; // the approving device hands over the backup key
    } else if (f.peer) {
      trust[f.peer.id] = "verified";
    }
  }

  const api: MessagingSecurityApi = {
    simulated: true,

    setup: () =>
      ctx.later(() => ({ deviceVerified, canVerifyWithOtherDevice: devices.some((d) => !d.current && d.verified) }), 200),

    subscribeDevices: (_viewerId, sub) => ctx.watch(sub, () => devices.map((d) => ({ ...d }))),

    removeDevice: (_viewerId, deviceId) =>
      ctx.later(() => {
        if (devices.find((d) => d.id === deviceId)?.current) throw new SecurityError("unknown", "Use sign out for this device");
        devices = devices.filter((d) => d.id !== deviceId);
        ctx.emit();
      }, 400),

    peerTrust: (_viewerId, peerId) => ctx.later(() => trust[peerId] ?? "unverified", 150),

    acceptIdentityChange: (_viewerId, peerId) =>
      ctx.later(() => {
        if (trust[peerId] === "changed" || trust[peerId] === "changed-verified") trust[peerId] = "unverified";
        ctx.emit();
      }, 200),

    startVerification: (_viewerId, peerId) =>
      ctx.later(() => {
        if (peerId === "self" && !devices.some((d) => !d.current && d.verified)) throw new SecurityError("no-other-device");
        const id = `demo-flow-${seq++}`;
        flows = [
          ...flows.filter((f) => f.state !== "done" && f.state !== "cancelled"),
          { id, peer: peerId === "self" ? null : ctx.author(peerId), self: peerId === "self", weStarted: true, state: "waiting" },
        ];
        emitFlows();
        simulateOtherSide(id);
        return id;
      }, 300),

    subscribeVerifications(_viewerId, sub) {
      const l = () => sub.onData(flows.map((f) => ({ ...f })));
      flowListeners.add(l);
      setTimeout(l, 100);
      return () => flowListeners.delete(l);
    },

    acceptVerification: (_viewerId, flowId) =>
      ctx.later(() => {
        setFlow(flowId, { state: "starting" });
        setTimeout(() => setFlow(flowId, { state: "compare", emoji: pickEmoji() }), 800);
      }, 200),

    confirmVerification: (_viewerId, flowId) =>
      ctx.later(() => {
        setFlow(flowId, { state: "confirmed" });
        setTimeout(() => {
          const f = flows.find((x) => x.id === flowId);
          if (!f || f.state !== "confirmed") return;
          finish(f);
          setFlow(flowId, { state: "done", emoji: undefined });
        }, 1200);
      }, 200),

    rejectVerification: (_viewerId, flowId) => ctx.later(() => setFlow(flowId, { state: "cancelled", cancelReason: "mismatch", emoji: undefined }), 200),
    cancelVerification: (_viewerId, flowId) => ctx.later(() => setFlow(flowId, { state: "cancelled", cancelReason: "cancelled", emoji: undefined }), 200),

    backupStatus: () =>
      ctx.later((): KeyBackupStatus => ({ exists: !!backupKey, keyCount: backupKey ? 23 : 0, thisDeviceHasKey: !!backupKey && backupThisDevice }), 200),

    setUpBackup: () =>
      ctx.later(() => {
        backupKey = randomKey();
        backupThisDevice = true;
        ctx.emit();
        return backupKey;
      }, 600),

    restoreBackup: (_viewerId, recoveryKey) =>
      ctx.later(() => {
        if (!backupKey) throw new SecurityError("no-backup");
        const k = clean(recoveryKey);
        if (!/^[A-Za-z0-9+/]{43}$/.test(k)) throw new SecurityError("bad-recovery-key");
        if (k !== clean(backupKey)) throw new SecurityError("wrong-recovery-key");
        backupThisDevice = true;
        ctx.emit();
        return { imported: 23, total: 23 };
      }, 900),

    resetIdentity: () =>
      ctx.later(() => {
        deviceVerified = true;
        devices = devices.map((d) => ({ ...d, verified: d.current }));
        ctx.emit();
      }, 600),
  };

  return {
    api,
    /** Sending to someone whose verified identity changed pauses until you OK it (as on the real backend). */
    trustOf: (peerId: string): PeerTrust => trust[peerId] ?? "unverified",
    deviceVerified: () => deviceVerified,
    hooks: {
      /** Someone asks to verify with you (e.g. __amigoDemo.security.incoming("leo")). */
      incoming(peerId: string) {
        flows = [...flows, { id: `demo-flow-${seq++}`, peer: ctx.author(peerId), self: false, weStarted: false, state: "incoming" }];
        emitFlows();
      },
      /** A new sign-in appears on your account. */
      newSignIn(name = "Chrome on Android") {
        devices = [...devices, { id: `DEMO${seq++}`, name, current: false, verified: false, createdAt: new Date(), lastActiveAt: new Date() }];
        ctx.emit();
      },
      keyChanged(peerId: string, wasVerified = true) {
        trust[peerId] = wasVerified ? "changed-verified" : "changed";
        ctx.emit();
      },
      trust: (peerId: string) => trust[peerId] ?? "unverified",
      /** Pretend this device doesn't hold the backup key (to try restoring). */
      loseBackupKey() {
        backupThisDevice = false;
        ctx.emit();
      },
    },
    persist: {
      export: (): Saved => ({ devices, deviceVerified, trust: { ...trust }, backupKey, backupThisDevice }),
      import: (s: Saved) => {
        devices = s.devices.map((d) => ({ ...d, createdAt: new Date(d.createdAt), lastActiveAt: d.lastActiveAt ? new Date(d.lastActiveAt) : null }));
        if (!ctx.newDevice) deviceVerified = s.deviceVerified;
        Object.keys(trust).forEach((k) => delete trust[k]);
        Object.assign(trust, s.trust);
        backupKey = s.backupKey;
        backupThisDevice = s.backupThisDevice;
      },
    },
  };
}
