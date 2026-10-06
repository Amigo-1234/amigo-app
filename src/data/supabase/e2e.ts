/**
 * End-to-end encryption for direct messages.
 *
 * Protocol: Olm (double ratchet, device to device) + Megolm (one outbound
 * session per conversation and sending device), with Matrix cross-signing,
 * SAS emoji verification and megolm key backup — all implemented by
 * vodozemac / matrix-sdk-crypto in the official
 * @matrix-org/matrix-sdk-crypto-wasm. We write no cryptography: this module
 * only moves the library's requests to and from Supabase (migrations
 * 20261006200000_messages.sql and 20261006210000_messaging_security.sql).
 *
 * What the server ever receives from here: public device keys, one-time
 * public keys, public cross-signing keys and signatures, Olm ciphertext
 * (to-device), Megolm ciphertext (messages), verification protocol messages
 * (public ECDH keys, commitments, MACs) and backup ciphertext encrypted to the
 * backup's public key. Private keys, the recovery key and message text never
 * leave the device.
 *
 * Conversation keys are only shared with devices their owner has verified
 * (cross-signed) — so someone who resets your password and signs in on a new
 * device gets nothing until one of your devices approves it.
 *
 * Self-contained on purpose (type-only imports), so Node tests can load it.
 * See docs/architecture/MESSAGES.md for the design and its limits.
 */
import type * as Sdk from "@matrix-org/matrix-sdk-crypto-wasm";

type Crypto = typeof Sdk;

/** The Supabase calls this module needs (an RPC caller and the device's mail). */
export interface E2EBackend {
  rpc<T>(fn: string, args: Record<string, unknown>): Promise<T>;
  /** This device's undelivered to-device mail, oldest first. */
  fetchToDevice(deviceId: string): Promise<{ id: number; sender_id: string; event_type: string; content: unknown }[]>;
  uploadAttachment?(path: string, data: Uint8Array): Promise<void>;
  downloadAttachment?(path: string): Promise<Uint8Array>;
}

export const mxid = (userId: string) => `@${userId}:amigo.world`;
export const userFromMxid = (id: string) => /^@([0-9a-f-]{36}):amigo\.world$/.exec(id)?.[1] ?? null;
const roomOf = (conversationId: string) => `!${conversationId}:amigo.world`;
const BACKUP_ALGORITHM = "m.megolm_backup.v1.curve25519-aes-sha2";

/** What travels inside the ciphertext. */
export interface MessagePayload {
  msgtype: "m.text" | "m.image";
  body: string;
  /** Reply relation and the photo's location + key are private, so they live in here too. */
  "amigo.reply_to"?: string | null;
  "amigo.image"?: { path: string; info: string; width: number; height: number; mimetype: string } | null;
}

export type DecryptResult =
  | { ok: true; payload: MessagePayload; senderMismatch: boolean; unverifiedDevice?: boolean }
  | { ok: false; reason: "missing-key" | "invalid" };

export interface StoredMessage {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: unknown;
  created_at: string;
}

export interface E2EOptions {
  crypto: Crypto;
  backend: E2EBackend;
  userId: string;
  deviceId: string;
  /** Shown in "Your devices" (e.g. "Chrome on Windows"). */
  deviceName?: string;
  /** Browser: IndexedDB store name + passphrase. Omit for an in-memory store (tests). */
  storeName?: string;
  storePassphrase?: string;
}

/** Thrown with code DM009 when this device was removed from the account elsewhere. */
export class E2EError extends Error {
  constructor(
    readonly code: "device-removed" | "device-unverified" | "identity-changed" | "bad-recovery-key" | "wrong-recovery-key" | "no-backup" | "no-other-device",
    message?: string,
  ) {
    super(message ?? code);
  }
}

/** How this device stands with your own identity. */
export interface OwnSecurity {
  /** This device is verified (cross-signed) and receives conversation keys. */
  deviceVerified: boolean;
  /** You have other verified devices that could approve this one. */
  canVerifyWithOtherDevice: boolean;
}

/** How someone else's identity looks from here. */
export type PeerTrust =
  | "verified" // you verified them and nothing changed since
  | "unverified" // normal default
  | "changed-verified" // you had verified them and their security key changed (sending is paused until you OK it)
  | "changed"; // their security key changed since you first saw it (wasn't verified)

export interface MyDevice {
  deviceId: string;
  name: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  current: boolean;
  verified: boolean;
}

export interface VerificationView {
  flowId: string;
  otherUserId: string;
  otherDeviceId: string | null;
  self: boolean;
  weStarted: boolean;
  state: "incoming" | "waiting" | "starting" | "compare" | "confirmed" | "done" | "cancelled";
  emoji?: { symbol: string; name: string }[];
  /** Matrix cancel code, e.g. m.mismatched_sas, m.user, m.timeout. */
  cancelReason?: string;
}

export interface BackupState {
  /** A backup exists on the server. */
  exists: boolean;
  version: string | null;
  keyCount: number;
  /** This device holds the backup key (can restore and back up). */
  thisDeviceHasKey: boolean;
}

/** A random device id: 10 upper-case letters, like other Matrix-protocol clients. */
export function newDeviceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => String.fromCharCode(65 + (b % 26))).join("");
}

/** "AbCd EfGh …" — easier to copy and compare. Spaces are ignored when typed back in. */
export const formatRecoveryKey = (k: string) => k.replace(/(.{4})/g, "$1 ").trim();
const cleanRecoveryKey = (k: string) => k.replace(/\s+/g, "");

export class E2EDevice {
  private queue: Promise<unknown> = Promise.resolve();
  private changesSince = "-infinity";
  /** Outgoing verification requests to several of someone's devices: the first to answer wins. */
  private fanout = new Map<string, string[]>();
  private lastTouch = 0;
  /** People with verification traffic for us, so their requests are looked up even if we don't track them yet. */
  private verificationPeers = new Set<string>();
  /** The library forgets finished requests; remember how each ended so the UI can say so. */
  private seen = new Map<string, VerificationView>();
  private confirmed = new Set<string>();
  private mismatched = new Set<string>();

  private constructor(
    private readonly c: Crypto,
    private readonly machine: Sdk.OlmMachine,
    private readonly backend: E2EBackend,
    readonly userId: string,
    readonly deviceId: string,
    private readonly deviceName: string | undefined,
  ) {}

  static async start(o: E2EOptions): Promise<E2EDevice> {
    await o.crypto.initAsync();
    const machine = await o.crypto.OlmMachine.initialize(
      new o.crypto.UserId(mxid(o.userId)),
      new o.crypto.DeviceId(o.deviceId),
      o.storeName,
      o.storePassphrase,
    );
    const d = new E2EDevice(o.crypto, machine, o.backend, o.userId, o.deviceId, o.deviceName);
    await d.serial(async () => {
      await d.machine.updateTrackedUsers([d.me()]);
      await d.sync();
      await d.ensureIdentity();
      await d.touch(true);
      await d.refreshBackupLocked();
    });
    return d;
  }

  private me() {
    return new this.c.UserId(mxid(this.userId));
  }

  /** One crypto operation at a time: the library's request/response flow isn't re-entrant. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    try {
      return await this.backend.rpc<T>(fn, args);
    } catch (e) {
      if ((e as { code?: string }).code === "DM009") throw new E2EError("device-removed");
      throw e;
    }
  }

  /** Sends one library request and reports the server's answer back to it. */
  private async send(req: { id?: string; type: Sdk.RequestType; body: string } | undefined) {
    if (!req) return;
    const { RequestType } = this.c;
    const body = JSON.parse(req.body);
    let response: unknown = {};
    switch (req.type) {
      case RequestType.KeysUpload:
        response = await this.rpc("e2e_upload_keys", {
          p_device: this.deviceId,
          p_device_keys: body.device_keys ?? null,
          p_one_time_keys: body.one_time_keys ?? null,
          p_fallback_keys: body.fallback_keys ?? null,
        });
        break;
      case RequestType.KeysQuery:
        response = await this.rpc("e2e_query_keys", { p_users: Object.keys(body.device_keys ?? {}) });
        break;
      case RequestType.KeysClaim:
        response = await this.rpc("e2e_claim_keys", { p_request: body.one_time_keys ?? {} });
        break;
      case RequestType.ToDevice:
        await this.rpc("e2e_send_to_device", { p_event_type: (req as Sdk.ToDeviceRequest).event_type, p_messages: body.messages ?? {} });
        break;
      case RequestType.SignatureUpload:
        response = await this.rpc("e2e_upload_signatures", { p_signatures: body });
        break;
      case RequestType.KeysBackup:
        try {
          response = await this.rpc("e2e_backup_put", { p_version: (req as Sdk.KeysBackupRequest).version, p_rooms: body.rooms ?? {} });
        } catch (e) {
          // The backup was replaced from another device: stop using the old one.
          if ((e as { code?: string }).code === "DM010") await this.machine.disableBackup();
          else throw e;
          return;
        }
        break;
      // Room messages (in-room verification) aren't used: nothing to send.
      default:
        break;
    }
    if (req.id) await this.machine.markRequestAsSent(req.id, req.type, JSON.stringify(response ?? {}));
  }

  /** Sends whatever the library wants to send (key uploads, key queries, key-sharing mail, signatures). */
  private async flush() {
    for (let round = 0; round < 5; round++) {
      const requests = await this.machine.outgoingRequests();
      if (requests.length === 0) return;
      for (const req of requests) await this.send(req);
    }
  }

  /** Reads this device's mail, device-list changes; advances verifications; backs up new keys. */
  private async sync() {
    const mail = await this.backend.fetchToDevice(this.deviceId);
    const changes = await this.rpc<{ user_id: string; changed_at: string }[]>("e2e_device_changes", { p_since: this.changesSince });
    const counts = await this.rpc<{ signed_curve25519: number; unused_fallback: boolean }>("e2e_key_counts", { p_device: this.deviceId });
    const events = mail.map((m) => ({ type: m.event_type, sender: mxid(m.sender_id), content: m.content }));
    const newPeers = mail.filter((m) => m.event_type.startsWith("m.key.verification.") && !this.verificationPeers.has(m.sender_id));
    for (const m of newPeers) this.verificationPeers.add(m.sender_id);
    if (newPeers.length) {
      // Know their devices before the request is processed.
      await this.machine.updateTrackedUsers(newPeers.map((m) => new this.c.UserId(mxid(m.sender_id))));
      await this.flush();
    }
    const changed = changes.map((c) => new this.c.UserId(c.user_id));
    await this.machine.receiveSyncChanges(
      JSON.stringify(events),
      new this.c.DeviceLists(changed, []),
      new Map([["signed_curve25519", counts.signed_curve25519]]),
      new Set(counts.unused_fallback ? ["signed_curve25519"] : []),
    );
    if (changes.length) this.changesSince = changes.map((c) => c.changed_at).sort().at(-1)!;
    if (mail.length) await this.rpc("e2e_ack_to_device", { p_device: this.deviceId, p_up_to: mail[mail.length - 1].id });
    await this.flush();
    await this.takeBackupKeyFromInbox();
    await this.advanceVerifications();
    await this.backupNewKeys();
  }

  /** Pull new keys and verification steps now (e.g. on a Realtime ping for to-device mail). */
  refresh(): Promise<void> {
    return this.serial(async () => {
      await this.sync();
      await this.touch(false);
    });
  }

  private async touch(force: boolean) {
    if (!force && Date.now() - this.lastTouch < 5 * 60_000) return;
    this.lastTouch = Date.now();
    await this.rpc("e2e_touch_device", { p_device: this.deviceId, p_name: this.deviceName ?? null });
  }

  // ------------------------------------------------------------- identity

  /**
   * First device of an account: create the account's cross-signing identity.
   * Later devices: start unverified until approved from a verified device
   * (or the person resets their identity).
   */
  private async ensureIdentity() {
    const status = await this.machine.crossSigningStatus();
    if (status.hasMaster && status.hasSelfSigning) return;
    const own = await this.machine.getIdentity(this.me());
    if (!own) await this.bootstrap(false);
  }

  private async bootstrap(reset: boolean) {
    const b = await this.machine.bootstrapCrossSigning(reset);
    if (b.uploadKeysRequest) await this.send(b.uploadKeysRequest);
    const keys = JSON.parse(b.uploadSigningKeysRequest.body);
    await this.rpc("e2e_upload_signing_keys", {
      p_master: keys.master_key ?? null,
      p_self_signing: keys.self_signing_key ?? null,
      p_user_signing: keys.user_signing_key ?? null,
    });
    await this.send(b.uploadSignaturesRequest);
    await this.sync();
  }

  ownSecurity(): Promise<OwnSecurity> {
    return this.serial(async () => {
      await this.sync();
      return this.ownSecurityLocked();
    });
  }

  private async ownSecurityLocked(): Promise<OwnSecurity> {
    const mine = await this.machine.getUserDevices(this.me());
    const self = mine.get(new this.c.DeviceId(this.deviceId));
    const deviceVerified = !!self?.isCrossSignedByOwner();
    const others = mine.devices().filter((d) => d.deviceId.toString() !== this.deviceId && d.isCrossSignedByOwner());
    return { deviceVerified, canVerifyWithOtherDevice: others.length > 0 };
  }

  /**
   * "I can't use another device": create a new identity on this device. People
   * who verified you are told your security key changed; your other devices
   * must be approved again. History is restored separately with the recovery key.
   */
  resetIdentity(): Promise<void> {
    return this.serial(() => this.bootstrap(true));
  }

  peerTrust(peerId: string): Promise<PeerTrust> {
    return this.serial(async () => {
      await this.machine.updateTrackedUsers([new this.c.UserId(mxid(peerId))]);
      await this.sync();
      const id = await this.machine.getIdentity(new this.c.UserId(mxid(peerId)));
      if (!id || !("identityNeedsUserApproval" in id)) return "unverified";
      if (id.hasVerificationViolation()) return "changed-verified";
      if (id.isVerified()) return "verified";
      if (id.identityNeedsUserApproval()) return "changed";
      return "unverified";
    });
  }

  /** "OK" on a changed security key: keep talking without re-verifying (you can verify again later). */
  acceptIdentityChange(peerId: string): Promise<void> {
    return this.serial(async () => {
      const id = await this.machine.getIdentity(new this.c.UserId(mxid(peerId)));
      if (!id || !("identityNeedsUserApproval" in id)) return;
      if (id.hasVerificationViolation()) await id.withdrawVerification();
      else if (id.identityNeedsUserApproval()) await id.pinCurrentMasterKey();
    });
  }

  // ---------------------------------------------------------- verification

  /** Emoji verification with someone (all their verified devices are asked; the first to answer is used) or with your own other devices. */
  startVerification(peerId: string | "self"): Promise<string> {
    return this.serial(async () => {
      const { VerificationMethod } = this.c;
      await this.sync();
      if (peerId === "self") {
        const own = await this.machine.getIdentity(this.me());
        if (!own || !("trustsOurOwnDevice" in own)) throw new E2EError("no-other-device");
        const [req, out] = await own.requestVerification([VerificationMethod.SasV1]);
        await this.send(out);
        return req.flowId;
      }
      const user = new this.c.UserId(mxid(peerId));
      await this.machine.updateTrackedUsers([new this.c.UserId(mxid(peerId))]);
      await this.sync();
      const devices = (await this.machine.getUserDevices(user)).devices().filter((d) => d.isCrossSignedByOwner());
      if (!devices.length) throw new E2EError("no-other-device");
      const flows: string[] = [];
      for (const d of devices) {
        const [req, out] = d.requestVerification([VerificationMethod.SasV1]);
        await this.send(out);
        flows.push(req.flowId);
      }
      for (const f of flows) this.fanout.set(f, flows);
      return flows[0];
    });
  }

  private async requests(): Promise<Sdk.VerificationRequest[]> {
    const users = new Set([...(await this.machine.trackedUsers())].map((u) => u.toString()));
    for (const p of this.verificationPeers) users.add(mxid(p));
    users.add(mxid(this.userId));
    const all: Sdk.VerificationRequest[] = [];
    for (const u of users) all.push(...this.machine.getVerificationRequests(new this.c.UserId(u)));
    return all;
  }

  private findRequest(all: Sdk.VerificationRequest[], flowId: string) {
    return all.find((r) => r.flowId === flowId);
  }

  /** Moves verifications along: start emoji once the other side is ready, accept their start. */
  private async advanceVerifications() {
    const all = await this.requests();
    for (const req of all) {
      if (req.isCancelled() || req.isDone()) continue;
      const sas = req.getVerification();
      if (req.weStarted() && req.isReady() && !sas) {
        // Several devices were asked: keep the first that answered, cancel the rest.
        const group = this.fanout.get(req.flowId);
        if (group) {
          for (const other of group) {
            if (other === req.flowId) continue;
            const o = this.findRequest(all, other);
            if (o && !o.isCancelled() && !o.isDone()) await this.send(o.cancel());
            this.fanout.delete(other);
          }
          this.fanout.delete(req.flowId);
        }
        const started = await req.startSas();
        if (started) await this.send(started[1]);
      } else if (sas && "emoji" in sas && !sas.weStarted() && !sas.hasBeenAccepted() && !sas.isCancelled()) {
        await this.send(sas.accept());
      }
    }
    await this.flush();
  }

  verifications(): Promise<VerificationView[]> {
    return this.serial(async () => {
      const views: VerificationView[] = [];
      for (const req of await this.requests()) {
        const other = userFromMxid(req.otherUserId.toString());
        if (!other) continue;
        const sas = req.getVerification();
        const s = sas && "emoji" in sas ? sas : null;
        let state: VerificationView["state"];
        if (req.isCancelled() || s?.isCancelled()) state = "cancelled";
        else if (req.isDone() || s?.isDone()) state = "done";
        else if (s?.haveWeConfirmed()) state = "confirmed";
        else if (s?.canBePresented()) state = "compare";
        else if (req.isReady() || s) state = "starting";
        else state = req.weStarted() ? "waiting" : "incoming";
        // Fan-out siblings that were cancelled by us are noise.
        if (state === "cancelled" && req.weStarted() && !s) continue;
        const view: VerificationView = {
          flowId: req.flowId,
          otherUserId: other,
          otherDeviceId: req.otherDeviceId?.toString() ?? null,
          self: req.isSelfVerification(),
          weStarted: req.weStarted(),
          state,
          emoji: state === "compare" ? s!.emoji()?.map((e) => ({ symbol: e.symbol, name: e.description })) : undefined,
          cancelReason: this.mismatched.has(req.flowId) ? "m.mismatched_sas" : (req.cancelInfo ?? s?.cancelInfo())?.cancelCode(),
        };
        this.seen.set(view.flowId, view);
        views.push(view);
      }
      // Finished requests drop out of the library's list: report how they ended.
      for (const [flowId, last] of this.seen) {
        if (views.some((v) => v.flowId === flowId)) continue;
        if (last.state !== "done" && last.state !== "cancelled") {
          const done = this.confirmed.has(flowId);
          this.seen.set(flowId, { ...last, state: done ? "done" : "cancelled", emoji: undefined, cancelReason: done ? undefined : this.mismatched.has(flowId) ? "m.mismatched_sas" : (last.cancelReason ?? "m.user") });
        }
        views.push(this.seen.get(flowId)!);
      }
      return views;
    });
  }

  private async withRequest(flowId: string, fn: (req: Sdk.VerificationRequest) => Promise<void>) {
    const req = this.findRequest(await this.requests(), flowId);
    if (req) await fn(req);
    await this.sync();
  }

  acceptVerification(flowId: string): Promise<void> {
    return this.serial(() => this.withRequest(flowId, (req) => this.send(req.accept())));
  }

  /** The emoji match on both screens. */
  confirmVerification(flowId: string): Promise<void> {
    return this.serial(() =>
      this.withRequest(flowId, async (req) => {
        const sas = req.getVerification();
        if (!sas || !("emoji" in sas)) return;
        this.confirmed.add(flowId);
        for (const out of await sas.confirm()) await this.send(out);
        // A newly approved own device receives the identity + backup keys from the approving device.
        await this.machine.requestMissingSecretsIfNeeded();
        await this.flush();
      }),
    );
  }

  /** The emoji don't match: stop, nothing is trusted. */
  rejectVerification(flowId: string): Promise<void> {
    return this.serial(() =>
      this.withRequest(flowId, async (req) => {
        const sas = req.getVerification();
        this.mismatched.add(flowId);
        if (sas && "emoji" in sas) await this.send(sas.cancelWithCode("m.mismatched_sas"));
        else await this.send(req.cancel());
      }),
    );
  }

  /** Stop showing a finished or cancelled verification. */
  dismissVerification(flowId: string) {
    this.seen.delete(flowId);
  }

  cancelVerification(flowId: string): Promise<void> {
    return this.serial(() => this.withRequest(flowId, (req) => this.send(req.cancel())));
  }

  // --------------------------------------------------------------- devices

  myDevices(): Promise<MyDevice[]> {
    return this.serial(async () => {
      await this.sync();
      const rows = await this.rpc<{ device_id: string; display_name: string | null; created_at: string; last_seen_at: string | null }[]>("e2e_my_devices", {});
      const mine = await this.machine.getUserDevices(this.me());
      return rows.map((r) => ({
        deviceId: r.device_id,
        name: r.display_name,
        createdAt: r.created_at,
        lastSeenAt: r.last_seen_at,
        current: r.device_id === this.deviceId,
        verified: !!mine.get(new this.c.DeviceId(r.device_id))?.isCrossSignedByOwner(),
      }));
    });
  }

  removeDevice(deviceId: string): Promise<void> {
    return this.serial(async () => {
      await this.rpc("e2e_remove_device", { p_device: deviceId });
      await this.sync();
    });
  }

  // ----------------------------------------------------------------- backup

  backupState(): Promise<BackupState> {
    return this.serial(async () => {
      await this.refreshBackupLocked();
      return this.backupStateLocked();
    });
  }

  private async backupStateLocked(): Promise<BackupState> {
    const info = await this.rpc<{ version: string; count: number; auth_data: { public_key: string } } | null>("e2e_backup_current", {});
    const keys = await this.machine.getBackupKeys();
    const mine = keys.decryptionKey;
    return {
      exists: !!info,
      version: info?.version ?? null,
      keyCount: info?.count ?? 0,
      thisDeviceHasKey: !!(info && mine && mine.megolmV1PublicKey.publicKeyBase64 === info.auth_data.public_key),
    };
  }

  /** Use the server's current backup if this device can trust it (holds its key, or it's signed by a verified device/identity). */
  private async refreshBackupLocked() {
    const info = await this.rpc<{ version: string; algorithm: string; auth_data: { public_key: string } } | null>("e2e_backup_current", {});
    if (!info) {
      if (await this.machine.isBackupEnabled()) await this.machine.disableBackup();
      return;
    }
    const keys = await this.machine.getBackupKeys();
    const holdsKey = keys.decryptionKey?.megolmV1PublicKey.publicKeyBase64 === info.auth_data.public_key;
    if (holdsKey && keys.backupVersion !== info.version) await this.machine.saveBackupDecryptionKey(keys.decryptionKey!, info.version);
    const trusted = holdsKey || (await this.machine.verifyBackup({ algorithm: info.algorithm, auth_data: info.auth_data })).trusted();
    if (trusted) await this.machine.enableBackupV1(info.auth_data.public_key, info.version);
    else if (await this.machine.isBackupEnabled()) await this.machine.disableBackup();
  }

  /**
   * Your other verified devices send the backup key over Olm (m.secret.send); the
   * library only accepts it from your own verified devices. Use it if it matches the
   * current backup.
   */
  private async takeBackupKeyFromInbox() {
    const candidates = await this.machine.getSecretsFromInbox("m.megolm_backup.v1");
    if (!candidates.size) return;
    const info = await this.rpc<{ version: string; auth_data: { public_key: string } } | null>("e2e_backup_current", {});
    for (const k of candidates) {
      try {
        const key = this.c.BackupDecryptionKey.fromBase64(k);
        if (info && key.megolmV1PublicKey.publicKeyBase64 === info.auth_data.public_key) {
          await this.machine.saveBackupDecryptionKey(key, info.version);
          await this.machine.enableBackupV1(info.auth_data.public_key, info.version);
          break;
        }
      } catch {
        /* not a usable key */
      }
    }
    await this.machine.deleteSecretsFromInbox("m.megolm_backup.v1");
  }

  private async backupNewKeys() {
    if (!(await this.machine.isBackupEnabled())) return;
    for (let i = 0; i < 20; i++) {
      const req = await this.machine.backupRoomKeys();
      if (!req) return;
      await this.send(req);
    }
  }

  /**
   * Turns on key backup with a new recovery key (replacing any old backup).
   * Returns the recovery key to show the person ONCE; it is never sent anywhere.
   */
  setUpBackup(): Promise<string> {
    return this.serial(async () => {
      const key = this.c.BackupDecryptionKey.createRandomKey();
      const authData: Record<string, unknown> = { public_key: key.megolmV1PublicKey.publicKeyBase64 };
      authData.signatures = JSON.parse((await this.machine.sign(JSON.stringify(authData))).asJSON());
      const version = await this.rpc<string>("e2e_backup_create", { p_algorithm: BACKUP_ALGORITHM, p_auth_data: authData });
      await this.machine.saveBackupDecryptionKey(key, version);
      await this.machine.enableBackupV1(key.megolmV1PublicKey.publicKeyBase64, version);
      await this.backupNewKeys();
      // Your other verified devices get the backup key over Olm so they can back up and restore too.
      await this.machine.pushSecretToVerifiedDevices("m.megolm_backup.v1").catch(() => undefined);
      await this.flush();
      return formatRecoveryKey(key.toBase64());
    });
  }

  /** Restores message history on this device from the backup using the recovery key. */
  restoreBackup(recoveryKey: string): Promise<{ imported: number; total: number }> {
    return this.serial(async () => {
      const info = await this.rpc<{ version: string; auth_data: { public_key: string } } | null>("e2e_backup_current", {});
      if (!info) throw new E2EError("no-backup");
      let key: Sdk.BackupDecryptionKey;
      try {
        key = this.c.BackupDecryptionKey.fromBase64(cleanRecoveryKey(recoveryKey));
      } catch {
        throw new E2EError("bad-recovery-key");
      }
      if (key.megolmV1PublicKey.publicKeyBase64 !== info.auth_data.public_key) throw new E2EError("wrong-recovery-key");
      const imported = await this.importFromBackup(key, info.version);
      await this.machine.saveBackupDecryptionKey(key, info.version);
      await this.machine.enableBackupV1(info.auth_data.public_key, info.version);
      return imported;
    });
  }

  private async importFromBackup(key: Sdk.BackupDecryptionKey, version: string) {
    const rooms = await this.rpc<Record<string, { sessions: Record<string, { session_data: { ephemeral: string; mac: string; ciphertext: string } }> }>>(
      "e2e_backup_get",
      { p_version: version },
    );
    const byRoom = new Map<Sdk.RoomId, Map<string, unknown>>();
    let total = 0;
    for (const [roomId, room] of Object.entries(rooms ?? {})) {
      const sessions = new Map<string, unknown>();
      for (const [sessionId, k] of Object.entries(room.sessions)) {
        total++;
        try {
          const d = k.session_data;
          sessions.set(sessionId, JSON.parse(key.decryptV1(d.ephemeral, d.mac, d.ciphertext)));
        } catch {
          /* a damaged entry doesn't stop the rest */
        }
      }
      if (sessions.size) byRoom.set(new this.c.RoomId(roomId), sessions);
    }
    const result = await this.machine.importBackedUpRoomKeys(byRoom, () => undefined, version);
    return { imported: result.importedCount, total };
  }

  // ---------------------------------------------------------------- messages

  /**
   * Encrypts a message for a conversation: makes sure every verified device
   * of both people (including your own other devices) has this conversation's
   * key, then returns the Megolm envelope to store.
   */
  encrypt(conversationId: string, peerId: string, payload: MessagePayload): Promise<Record<string, unknown>> {
    return this.serial(async () => {
      const room = new this.c.RoomId(roomOf(conversationId));
      // The library takes ownership of the ids it's given, so each call gets fresh ones.
      const users = () => [new this.c.UserId(mxid(this.userId)), new this.c.UserId(mxid(peerId))];
      await this.machine.updateTrackedUsers(users());
      await this.sync();
      const claim = await this.machine.getMissingSessions(users());
      if (claim) {
        const body = JSON.parse(claim.body);
        const res = await this.rpc("e2e_claim_keys", { p_request: body.one_time_keys ?? {} });
        await this.machine.markRequestAsSent(claim.id, claim.type, JSON.stringify(res));
      }
      const settings = new this.c.EncryptionSettings();
      // Only devices verified by their owner get keys (unverified new sign-ins get nothing).
      settings.sharingStrategy = this.c.CollectStrategy.identityBasedStrategy();
      let requests: Sdk.ToDeviceRequest[];
      try {
        requests = await this.machine.shareRoomKey(room, users(), settings);
      } catch (e) {
        if (!(await this.ownSecurityLocked()).deviceVerified) throw new E2EError("device-unverified");
        const id = await this.machine.getIdentity(new this.c.UserId(mxid(peerId)));
        if (id && "identityNeedsUserApproval" in id && (id.hasVerificationViolation() || id.identityNeedsUserApproval())) {
          throw new E2EError("identity-changed");
        }
        throw e;
      }
      for (const req of requests) {
        const body = JSON.parse(req.body);
        await this.rpc("e2e_send_to_device", { p_event_type: req.event_type, p_messages: body.messages ?? {} });
        await this.machine.markRequestAsSent(req.id, req.type, "{}");
      }
      const envelope = await this.machine.encryptRoomEvent(room, "m.room.message", JSON.stringify(payload));
      await this.backupNewKeys();
      return JSON.parse(envelope);
    });
  }

  /** Decrypts a stored message. Missing keys are fetched once before giving up. */
  decrypt(m: StoredMessage): Promise<DecryptResult> {
    return this.serial(async () => {
      const first = await this.tryDecrypt(m);
      if (first.ok || first.reason !== "missing-key") return first;
      await this.sync();
      return this.tryDecrypt(m);
    });
  }

  private async tryDecrypt(m: StoredMessage): Promise<DecryptResult> {
    const room = new this.c.RoomId(roomOf(m.conversation_id));
    const event = {
      type: "m.room.encrypted",
      event_id: `$${m.id}`,
      sender: mxid(m.sender_id),
      origin_server_ts: new Date(m.created_at).getTime(),
      room_id: room.toString(),
      content: m.content,
    };
    try {
      const decrypted = await this.machine.decryptRoomEvent(
        JSON.stringify(event),
        room,
        new this.c.DecryptionSettings(this.c.TrustRequirement.Untrusted),
      );
      const plain = JSON.parse(decrypted.event);
      // The server says who sent it; the session proves which device did. If they
      // disagree the server lied about the sender — don't show it as theirs.
      const shield = decrypted.shieldState(false);
      const senderMismatch = shield.code === this.c.ShieldStateCode.MismatchedSender;
      const unverifiedDevice = shield.code === this.c.ShieldStateCode.UnsignedDevice;
      if (plain.type !== "m.room.message" || typeof plain.content?.body !== "string") return { ok: false, reason: "invalid" };
      return { ok: true, payload: plain.content as MessagePayload, senderMismatch, unverifiedDevice };
    } catch (e) {
      // MegolmDecryptionError: no key (yet) for this session/index → maybe fetch keys; anything else is bad data.
      const code = (e as { code?: number }).code;
      const missing = code === this.c.DecryptionErrorCode.MissingRoomKey || code === this.c.DecryptionErrorCode.UnknownMessageIndex;
      return { ok: false, reason: missing ? "missing-key" : "invalid" };
    }
  }

  /** Encrypts photo bytes (AES-CTR + SHA-256, the library's attachment format). The key goes in the message. */
  encryptAttachment(bytes: Uint8Array): { data: Uint8Array; info: string } {
    const enc = this.c.Attachment.encrypt(bytes);
    const info = enc.mediaEncryptionInfo!;
    return { data: enc.encryptedData, info };
  }

  decryptAttachment(data: Uint8Array, info: string): Uint8Array {
    return this.c.Attachment.decrypt(new this.c.EncryptedAttachment(data, info));
  }

  /** Signing out on this device: remove its public keys and mail from the server. */
  async forget(): Promise<void> {
    await this.backend.rpc("e2e_delete_device", { p_device: this.deviceId });
    this.machine.close();
  }

  close() {
    this.machine.close();
  }
}
