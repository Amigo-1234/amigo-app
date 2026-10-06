/**
 * End-to-end encryption for direct messages.
 *
 * Protocol: Olm (double ratchet, device to device) + Megolm (one outbound
 * session per conversation and sending device), implemented by vodozemac in
 * the official @matrix-org/matrix-sdk-crypto-wasm. We write no cryptography:
 * this module only moves the library's requests to and from Supabase
 * (migration 20261006200000_messages.sql) — public keys up, Olm-encrypted
 * key-sharing mail between devices, Megolm ciphertext for messages.
 *
 * What the server ever receives from here: public device keys, one-time
 * public keys, Olm ciphertext (to-device) and Megolm ciphertext (messages).
 * Message text, replies and photo keys exist only inside the ciphertext.
 * Private keys stay in the device's local crypto store.
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

/** What travels inside the ciphertext. */
export interface MessagePayload {
  msgtype: "m.text" | "m.image";
  body: string;
  /** Reply relation and the photo's location + key are private, so they live in here too. */
  "amigo.reply_to"?: string | null;
  "amigo.image"?: { path: string; info: string; width: number; height: number; mimetype: string } | null;
}

export type DecryptResult =
  | { ok: true; payload: MessagePayload; senderMismatch: boolean }
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
  /** Browser: IndexedDB store name + passphrase. Omit for an in-memory store (tests). */
  storeName?: string;
  storePassphrase?: string;
}

/** A random device id: 10 upper-case letters, like other Matrix-protocol clients. */
export function newDeviceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => String.fromCharCode(65 + (b % 26))).join("");
}

export class E2EDevice {
  private queue: Promise<unknown> = Promise.resolve();
  private changesSince = "-infinity";

  private constructor(
    private readonly c: Crypto,
    private readonly machine: Sdk.OlmMachine,
    private readonly backend: E2EBackend,
    readonly userId: string,
    readonly deviceId: string,
  ) {}

  static async start(o: E2EOptions): Promise<E2EDevice> {
    await o.crypto.initAsync();
    const machine = await o.crypto.OlmMachine.initialize(
      new o.crypto.UserId(mxid(o.userId)),
      new o.crypto.DeviceId(o.deviceId),
      o.storeName,
      o.storePassphrase,
    );
    const d = new E2EDevice(o.crypto, machine, o.backend, o.userId, o.deviceId);
    await d.serial(() => d.sync());
    return d;
  }

  /** Public identity key fingerprint of this device (for a future "verify" screen). */
  get identityKey(): string {
    return this.machine.identityKeys.ed25519.toBase64();
  }

  /** One crypto operation at a time: the library's request/response flow isn't re-entrant. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Sends whatever the library wants to send (key uploads, key queries, key-sharing mail). */
  private async flush() {
    const { RequestType } = this.c;
    for (let round = 0; round < 5; round++) {
      const requests = await this.machine.outgoingRequests();
      if (requests.length === 0) return;
      for (const req of requests) {
        const body = JSON.parse(req.body);
        let response: unknown = {};
        switch (req.type) {
          case RequestType.KeysUpload:
            response = await this.backend.rpc("e2e_upload_keys", {
              p_device: this.deviceId,
              p_device_keys: body.device_keys ?? null,
              p_one_time_keys: body.one_time_keys ?? null,
              p_fallback_keys: body.fallback_keys ?? null,
            });
            break;
          case RequestType.KeysQuery:
            response = await this.backend.rpc("e2e_query_keys", { p_users: Object.keys(body.device_keys ?? {}) });
            break;
          case RequestType.KeysClaim:
            response = await this.backend.rpc("e2e_claim_keys", { p_request: body.one_time_keys ?? {} });
            break;
          case RequestType.ToDevice:
            await this.backend.rpc("e2e_send_to_device", { p_event_type: (req as Sdk.ToDeviceRequest).event_type, p_messages: body.messages ?? {} });
            break;
          // Cross-signing, room messages and key backup aren't used (yet): nothing to send.
          default:
            break;
        }
        if (req.id) await this.machine.markRequestAsSent(req.id, req.type, JSON.stringify(response ?? {}));
      }
    }
  }

  /** Reads this device's mail (incoming conversation keys) and any device-list changes. */
  private async sync() {
    const mail = await this.backend.fetchToDevice(this.deviceId);
    const changes = await this.backend.rpc<{ user_id: string; changed_at: string }[]>("e2e_device_changes", { p_since: this.changesSince });
    const counts = await this.backend.rpc<{ signed_curve25519: number; unused_fallback: boolean }>("e2e_key_counts", { p_device: this.deviceId });
    const events = mail.map((m) => ({ type: m.event_type, sender: mxid(m.sender_id), content: m.content }));
    const changed = changes.map((c) => new this.c.UserId(c.user_id));
    await this.machine.receiveSyncChanges(
      JSON.stringify(events),
      new this.c.DeviceLists(changed, []),
      new Map([["signed_curve25519", counts.signed_curve25519]]),
      new Set(counts.unused_fallback ? ["signed_curve25519"] : []),
    );
    if (changes.length) this.changesSince = changes.map((c) => c.changed_at).sort().at(-1)!;
    if (mail.length) await this.backend.rpc("e2e_ack_to_device", { p_device: this.deviceId, p_up_to: mail[mail.length - 1].id });
    await this.flush();
  }

  /** Pull new keys now (e.g. on a Realtime ping for to-device mail). */
  refresh(): Promise<void> {
    return this.serial(() => this.sync());
  }

  /**
   * Encrypts a message for a conversation: makes sure every current device of
   * both people (including your own other devices) has this conversation's
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
        const res = await this.backend.rpc("e2e_claim_keys", { p_request: body.one_time_keys ?? {} });
        await this.machine.markRequestAsSent(claim.id, claim.type, JSON.stringify(res));
      }
      const settings = new this.c.EncryptionSettings();
      for (const req of await this.machine.shareRoomKey(room, users(), settings)) {
        const body = JSON.parse(req.body);
        await this.backend.rpc("e2e_send_to_device", { p_event_type: req.event_type, p_messages: body.messages ?? {} });
        await this.machine.markRequestAsSent(req.id, req.type, "{}");
      }
      const envelope = await this.machine.encryptRoomEvent(room, "m.room.message", JSON.stringify(payload));
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
      if (plain.type !== "m.room.message" || typeof plain.content?.body !== "string") return { ok: false, reason: "invalid" };
      return { ok: true, payload: plain.content as MessagePayload, senderMismatch };
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
}
