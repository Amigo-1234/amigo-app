/**
 * Supabase direct messages, end-to-end encrypted on this device
 * (src/data/supabase/e2e.ts). The crypto library (~2 MB gzipped WebAssembly)
 * is only downloaded when Messages is first used.
 *
 * Every message is encrypted before it leaves the device; this module never
 * sends message text, reply relations or photo keys to Supabase in the clear.
 * Read/delivered markers, who-talks-to-whom and timestamps are the metadata
 * the server does see (see docs/architecture/MESSAGES.md).
 */
import type { RealtimeChannel } from "@supabase/supabase-js";
import {
  MessageError,
  SecurityError,
  type Author,
  type Conversation,
  type ConversationView,
  type DirectMessage,
  type MediaItem,
  type MessagesApi,
  type MessageStatus,
  type MessagingSecurityApi,
  type Subscription,
  type VerificationFlow,
} from "../types";
import type { DecryptResult, E2EBackend, E2EDevice, MessagePayload, StoredMessage } from "./e2e";
import type { Db } from "./queries";
import { toAuthor, VERIFICATION_EMBED } from "./queries";
import type { Json } from "./database.types";

type LiveQuery = <T>(name: string, fetcher: () => Promise<T>, sub: Subscription<T>, listen: (ch: RealtimeChannel, refresh: () => void) => RealtimeChannel) => () => void;

const PERSON = `id, username, display_name, avatar_url, ${VERIFICATION_EMBED}`;
const PAGE = 200;
const TYPING_TTL_MS = 6000;

const ERRORS: Record<string, MessageError["code"]> = { DM002: "not-found", DM003: "not-found", DM004: "blocked", DM005: "unknown" };
function fail(error: { code?: string; message: string }): never {
  throw new MessageError(ERRORS[error.code ?? ""] ?? "unknown", error.message);
}

/** Crypto-layer errors (E2EError, or raw DM codes) as the app's MessageError / SecurityError. */
function translate(e: unknown): never {
  const code = (e as { code?: string })?.code;
  if (e instanceof MessageError || e instanceof SecurityError) throw e;
  if (code === "identity-changed" || code === "device-unverified") throw new MessageError(code);
  if (code === "device-removed" || code === "DM009") throw new SecurityError("device-removed");
  if (code === "bad-recovery-key" || code === "wrong-recovery-key" || code === "no-backup" || code === "no-other-device") throw new SecurityError(code);
  if (code && ERRORS[code]) throw new MessageError(ERRORS[code], (e as Error).message);
  throw e;
}

/** "Chrome on Windows" — shown in Your devices. Only the owner sees it. */
export function describeDevice(ua = globalThis.navigator?.userAgent ?? ""): string {
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS"
    : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : null;
  return os ? `${browser} on ${os}` : browser;
}

const CANCEL: Record<string, VerificationFlow["cancelReason"]> = {
  "m.mismatched_sas": "mismatch",
  "m.key_mismatch": "mismatch",
  "m.mismatched_commitment": "mismatch",
  "m.timeout": "timeout",
};

/** opts.memoryStore: keep crypto keys in memory instead of IndexedDB (Node tests only). */
export function createSupabaseMessages(db: Db, liveQuery: LiveQuery, invalidate: () => void, opts: { memoryStore?: boolean } = {}): MessagesApi {
  // ------------------------------------------------------------ this device

  let current: { userId: string; device: Promise<E2EDevice> } | null = null;

  const backend: E2EBackend = {
    async rpc<T>(fn: string, args: Record<string, unknown>) {
      const { data, error } = await db.rpc(fn as never, args as never);
      // Keep the database's code (DM009 etc.): the crypto layer acts on it.
      if (error) throw Object.assign(new Error(error.message), { code: error.code });
      return data as T;
    },
    async fetchToDevice(deviceId) {
      const { data, error } = await db.from("e2e_to_device").select("id, sender_id, event_type, content").eq("recipient_device", deviceId).order("id").limit(500);
      if (error) fail(error);
      return data;
    },
    async uploadAttachment(path, bytes) {
      const { error } = await db.storage.from("dm-attachments").upload(path, new Blob([bytes as BlobPart]), { contentType: "application/octet-stream" });
      if (error) throw new MessageError("unknown", error.message);
    },
    async downloadAttachment(path) {
      const { data, error } = await db.storage.from("dm-attachments").download(path);
      if (error || !data) throw new MessageError("unknown", error?.message ?? "download failed");
      return new Uint8Array(await data.arrayBuffer());
    },
  };

  const storageKey = (userId: string) => `amigo.e2e.${userId}`;

  /** This browser was removed from the account elsewhere: forget its keys so it starts over as a new device. */
  async function wipe(userId: string) {
    const was = current;
    current = null;
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey(userId)) ?? "null");
      localStorage.removeItem(storageKey(userId));
      (await was?.device.catch(() => null))?.close();
      if (saved && typeof indexedDB !== "undefined" && indexedDB.databases) {
        const prefix = `amigo-crypto-${userId}-${saved.deviceId}`;
        for (const d of await indexedDB.databases()) if (d.name?.startsWith(prefix)) indexedDB.deleteDatabase(d.name);
      }
    } catch {
      /* nothing saved */
    }
  }

  /** Runs fn with this device; a "device removed" answer wipes the local keys first. */
  async function withDevice<T>(userId: string, fn: (d: E2EDevice) => Promise<T>): Promise<T> {
    try {
      return await fn(await device(userId));
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === "device-removed" || code === "DM009") await wipe(userId);
      return translate(e);
    }
  }

  /** This browser's crypto device for the signed-in person (created and registered on first use). */
  function device(userId: string): Promise<E2EDevice> {
    if (current?.userId === userId) return current.device;
    const started = (async () => {
      const [crypto, { E2EDevice, newDeviceId }] = await Promise.all([import("@matrix-org/matrix-sdk-crypto-wasm"), import("./e2e")]);
      const key = storageKey(userId);
      let saved: { deviceId: string; passphrase: string } | null = null;
      try {
        saved = JSON.parse(localStorage.getItem(key) ?? "null");
      } catch {
        saved = null;
      }
      if (!saved) {
        // Encrypts the local key store at rest (IndexedDB). Kept beside it in this browser — see MESSAGES.md.
        const passphrase = btoa(String.fromCharCode(...globalThis.crypto.getRandomValues(new Uint8Array(32))));
        saved = { deviceId: newDeviceId(), passphrase };
        try {
          localStorage.setItem(key, JSON.stringify(saved));
        } catch {
          /* private mode: this device lasts for the session only */
        }
      }
      return E2EDevice.start({
        crypto,
        backend,
        userId,
        deviceId: saved.deviceId,
        deviceName: describeDevice(),
        storeName: opts.memoryStore ? undefined : `amigo-crypto-${userId}-${saved.deviceId}`,
        storePassphrase: opts.memoryStore ? undefined : saved.passphrase,
      });
    })();
    current = { userId, device: started };
    started.catch(() => {
      if (current?.device === started) current = null;
    });
    return started;
  }

  // ----------------------------------------------------------- decryption

  const decrypted = new Map<string, DecryptResult>();
  const images = new Map<string, Promise<string | null>>();

  async function open(userId: string, m: StoredMessage): Promise<DecryptResult> {
    const hit = decrypted.get(m.id);
    if (hit?.ok) return hit;
    const result = await (await device(userId)).decrypt(m);
    decrypted.set(m.id, result);
    return result;
  }

  function imageUrl(userId: string, img: NonNullable<MessagePayload["amigo.image"]>): Promise<string | null> {
    let p = images.get(img.path);
    if (!p) {
      p = (async () => {
        try {
          const d = await device(userId);
          const bytes = d.decryptAttachment(await backend.downloadAttachment!(img.path), img.info);
          return URL.createObjectURL(new Blob([bytes as BlobPart], { type: img.mimetype }));
        } catch {
          images.delete(img.path);
          return null;
        }
      })();
      images.set(img.path, p);
    }
    return p;
  }

  // -------------------------------------------------------------- people

  const people = new Map<string, Author>();
  async function authors(ids: string[]): Promise<void> {
    const missing = [...new Set(ids)].filter((id) => !people.has(id));
    if (!missing.length) return;
    const { data, error } = await db.from("profiles").select(PERSON).in("id", missing);
    if (error) fail(error);
    for (const p of data ?? []) people.set(p.id, toAuthor(p as never));
  }
  const author = (id: string) => people.get(id) ?? toAuthor(null);

  const statusFor = (createdAt: string, peerRead: string, peerDelivered: string): MessageStatus =>
    peerRead >= createdAt ? "read" : peerDelivered >= createdAt ? "delivered" : "sent";

  // ---------------------------------------------------------------- inbox

  async function inbox(viewerId: string): Promise<Conversation[]> {
    const { data, error } = await db.rpc("dm_inbox");
    if (error) fail(error);
    const rows = data ?? [];
    if (rows.some((r) => r.unread_count > 0)) void db.rpc("dm_mark_delivered");
    await authors(rows.map((r) => r.peer_id));
    return Promise.all(
      rows.map(async (r): Promise<Conversation> => {
        let last: Conversation["lastMessage"] = null;
        if (r.last_message_id && r.last_sender_id) {
          const res = await open(viewerId, {
            id: r.last_message_id,
            conversation_id: r.conversation_id,
            sender_id: r.last_sender_id,
            content: r.last_content,
            created_at: r.last_message_at,
          }).catch((): DecryptResult => ({ ok: false, reason: "missing-key" }));
          const fromViewer = r.last_sender_id === viewerId;
          last = {
            text: res.ok ? res.payload.body : "",
            hasImage: res.ok && !!res.payload["amigo.image"],
            fromViewer,
            createdAt: new Date(r.last_message_at),
            status: fromViewer ? statusFor(r.last_message_at, r.peer_last_read_at, r.peer_last_delivered_at) : "read",
            undecryptable: !res.ok,
          };
        }
        return {
          id: r.conversation_id,
          peer: author(r.peer_id),
          lastMessage: last,
          unreadCount: Number(r.unread_count),
          blockedByViewer: r.blocked_by_me,
          canSend: r.can_send,
        };
      }),
    );
  }

  // --------------------------------------------------------- conversation

  async function conversation(conversationId: string, viewerId: string): Promise<ConversationView | null> {
    const [{ data: members, error: e1 }, { data: rows, error: e2 }] = await Promise.all([
      db.from("dm_participants").select("user_id, last_read_at, last_delivered_at").eq("conversation_id", conversationId),
      db.from("dm_messages").select("id, conversation_id, sender_id, content, created_at").eq("conversation_id", conversationId).order("created_at", { ascending: false }).limit(PAGE),
    ]);
    if (e1) fail(e1);
    if (e2) fail(e2);
    const me = members?.find((m) => m.user_id === viewerId);
    const peer = members?.find((m) => m.user_id !== viewerId);
    if (!me || !peer) return null;
    await authors([peer.user_id]);
    const [{ data: blocks }, { data: blockedEither }] = await Promise.all([
      db.from("user_blocks").select("blocked_id").eq("blocker_id", viewerId).eq("blocked_id", peer.user_id),
      db.rpc("dm_blocked_between", { a: viewerId, b: peer.user_id }),
    ]);

    const list = [...(rows ?? [])].reverse();
    const results = await Promise.all(list.map((m) => open(viewerId, m as StoredMessage).catch((): DecryptResult => ({ ok: false, reason: "missing-key" }))));
    const byId = new Map(list.map((m, i) => [m.id, results[i]]));

    const messages: DirectMessage[] = await Promise.all(
      list.map(async (m, i): Promise<DirectMessage> => {
        const res = results[i];
        const fromViewer = m.sender_id === viewerId;
        const base = {
          id: m.id,
          conversationId,
          senderId: m.sender_id,
          fromViewer,
          createdAt: new Date(m.created_at),
          status: fromViewer ? statusFor(m.created_at, peer.last_read_at, peer.last_delivered_at) : ("read" as MessageStatus),
        };
        // Shown as undecryptable if the server's claimed sender doesn't own the sending device.
        if (!res.ok || res.senderMismatch) return { ...base, text: "", media: [], replyTo: null, undecryptable: true };
        const p = res.payload;
        const media: MediaItem[] = [];
        if (p["amigo.image"]) {
          const url = await imageUrl(viewerId, p["amigo.image"]);
          if (url) media.push({ type: "image", url, width: p["amigo.image"].width, height: p["amigo.image"].height });
        }
        const quotedId = p["amigo.reply_to"];
        const quoted = quotedId ? byId.get(quotedId) : null;
        const quotedRow = quotedId ? list.find((x) => x.id === quotedId) : null;
        return {
          ...base,
          text: p.body,
          unverifiedDevice: !!res.unverifiedDevice && !fromViewer,
          media,
          replyTo:
            quotedId && quotedRow
              ? {
                  id: quotedId,
                  fromViewer: quotedRow.sender_id === viewerId,
                  text: quoted?.ok ? quoted.payload.body : "",
                  hasImage: !!(quoted?.ok && quoted.payload["amigo.image"]),
                }
              : null,
        };
      }),
    );

    const unreadCount = list.filter((m) => m.sender_id !== viewerId && m.created_at > me.last_read_at).length;
    return {
      conversation: {
        id: conversationId,
        peer: author(peer.user_id),
        lastMessage: null,
        unreadCount,
        blockedByViewer: (blocks ?? []).length > 0,
        canSend: !blockedEither,
      },
      messages,
    };
  }

  // ---------------------------------------------------------------- typing

  const typingChannels = new Map<string, { channel: RealtimeChannel; users: number }>();
  function typingChannel(conversationId: string) {
    let entry = typingChannels.get(conversationId);
    if (!entry) {
      // Private broadcast channel: only participants may join (policy in the migration). Nothing is stored.
      entry = { channel: db.channel(`dm:${conversationId}`, { config: { private: true, broadcast: { self: false } } }), users: 0 };
      typingChannels.set(conversationId, entry);
    }
    return entry;
  }

  // ------------------------------------------------------------------ api

  const dmListen = (viewerId: string) => (ch: RealtimeChannel, refresh: () => void) =>
    ch
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "dm_messages" }, refresh)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "dm_participants" }, refresh)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "e2e_to_device", filter: `recipient_id=eq.${viewerId}` }, refresh);

  // ------------------------------------------------------------- security

  const verificationListeners = new Set<() => void>();
  const pokeVerifications = () => verificationListeners.forEach((l) => l());

  const security: MessagingSecurityApi = {
    simulated: false,

    setup: (viewerId) => withDevice(viewerId, (d) => d.ownSecurity()),

    subscribeDevices: (viewerId, sub) =>
      liveQuery(
        "e2e:devices",
        () =>
          withDevice(viewerId, async (d) =>
            (await d.myDevices()).map((x) => ({
              id: x.deviceId,
              name: x.name ?? "Unknown device",
              current: x.current,
              verified: x.verified,
              createdAt: new Date(x.createdAt),
              lastActiveAt: x.lastSeenAt ? new Date(x.lastSeenAt) : null,
            })),
          ),
        sub,
        (ch, refresh) => ch.on("postgres_changes", { event: "*", schema: "public", table: "e2e_devices", filter: `user_id=eq.${viewerId}` }, refresh),
      ),

    async removeDevice(viewerId, deviceId) {
      await withDevice(viewerId, (d) => d.removeDevice(deviceId));
      invalidate();
    },

    peerTrust: (viewerId, peerId) => withDevice(viewerId, (d) => d.peerTrust(peerId)),

    async acceptIdentityChange(viewerId, peerId) {
      await withDevice(viewerId, (d) => d.acceptIdentityChange(peerId));
      invalidate();
    },

    async startVerification(viewerId, peerId) {
      const id = await withDevice(viewerId, (d) => d.startVerification(peerId));
      pokeVerifications();
      return id;
    },

    subscribeVerifications(viewerId, sub) {
      let active = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let last = "";
      let busy = false;
      const tick = async () => {
        if (!active || busy) return;
        busy = true;
        let next = 10_000;
        try {
          const flows = await withDevice(viewerId, async (d) => {
            await d.refresh();
            return d.verifications();
          });
          const people = flows.filter((f) => !f.self).map((f) => f.otherUserId);
          await authors(people).catch(() => undefined);
          const mapped: VerificationFlow[] = flows.map((f) => ({
            id: f.flowId,
            peer: f.self ? null : author(f.otherUserId),
            self: f.self,
            weStarted: f.weStarted,
            state: f.state,
            emoji: f.emoji,
            cancelReason: f.state === "cancelled" ? (CANCEL[f.cancelReason ?? ""] ?? "cancelled") : undefined,
          }));
          // Poll quickly while something is in progress.
          if (mapped.some((f) => f.state !== "done" && f.state !== "cancelled")) next = 1500;
          const key = JSON.stringify(mapped);
          if (key !== last && active) {
            last = key;
            sub.onData(mapped);
          }
        } catch (e) {
          if (active) sub.onError(e as Error);
        } finally {
          busy = false;
          if (active) timer = setTimeout(tick, next);
        }
      };
      const poke = () => {
        clearTimeout(timer);
        timer = setTimeout(tick, 50);
      };
      verificationListeners.add(poke);
      const channel = db
        .channel(`e2e:mail:${crypto.randomUUID()}`)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "e2e_to_device", filter: `recipient_id=eq.${viewerId}` }, poke)
        .subscribe();
      void tick();
      return () => {
        active = false;
        clearTimeout(timer);
        verificationListeners.delete(poke);
        void db.removeChannel(channel);
      };
    },

    async acceptVerification(viewerId, flowId) {
      await withDevice(viewerId, (d) => d.acceptVerification(flowId));
      pokeVerifications();
    },
    async confirmVerification(viewerId, flowId) {
      await withDevice(viewerId, (d) => d.confirmVerification(flowId));
      pokeVerifications();
      invalidate();
    },
    async rejectVerification(viewerId, flowId) {
      await withDevice(viewerId, (d) => d.rejectVerification(flowId));
      pokeVerifications();
    },
    async cancelVerification(viewerId, flowId) {
      await withDevice(viewerId, (d) => d.cancelVerification(flowId));
      pokeVerifications();
    },

    backupStatus: (viewerId) => withDevice(viewerId, (d) => d.backupState()),
    setUpBackup: (viewerId) => withDevice(viewerId, (d) => d.setUpBackup()),
    async restoreBackup(viewerId, recoveryKey) {
      const result = await withDevice(viewerId, (d) => d.restoreBackup(recoveryKey));
      // Messages that couldn't be decrypted before may be readable now.
      for (const [id, r] of decrypted) if (!r.ok) decrypted.delete(id);
      invalidate();
      return result;
    },
    async resetIdentity(viewerId) {
      await withDevice(viewerId, (d) => d.resetIdentity());
      invalidate();
    },
  };

  return {
    encryption: "e2e",
    security,

    subscribeConversations: (viewerId, sub) => liveQuery("dm:inbox", () => inbox(viewerId), sub, dmListen(viewerId)),

    subscribeUnreadCount: (viewerId, sub) =>
      liveQuery(
        "dm:unread",
        async () => {
          // The badge is on every screen, so this registers this browser as a messaging
          // device soon after sign-in — people can receive messages before ever opening Messages.
          void device(viewerId).catch((e) => console.warn("Encrypted messaging unavailable on this device", e));
          const { data, error } = await db.rpc("dm_inbox");
          if (error) fail(error);
          return (data ?? []).filter((r) => r.unread_count > 0).length;
        },
        sub,
        dmListen(viewerId),
      ),

    async openConversation(_viewerId, peerId) {
      const { data, error } = await db.rpc("dm_open", { p_peer: peerId });
      if (error) fail(error);
      return data as string;
    },

    subscribeConversation: (conversationId, viewerId, sub) =>
      liveQuery(`dm:${conversationId}`, () => conversation(conversationId, viewerId), sub, dmListen(viewerId)),

    async send(viewerId, conversationId, input) {
      const text = input.text.trim();
      if (!text && !input.image) throw new MessageError("empty");
      const { data: members, error } = await db.from("dm_participants").select("user_id").eq("conversation_id", conversationId);
      if (error) fail(error);
      const peerId = members?.find((m) => m.user_id !== viewerId)?.user_id;
      if (!peerId) throw new MessageError("not-found");
      // Encrypting for someone with no devices would make the message unreadable forever.
      const { count } = await db.from("e2e_devices").select("device_id", { count: "exact", head: true }).eq("user_id", peerId);
      if (!count) throw new MessageError("peer-unavailable");
      const d = await device(viewerId).catch(translate);
      let image: MessagePayload["amigo.image"] = null;
      if (input.image) {
        const enc = d.encryptAttachment(new Uint8Array(await input.image.blob.arrayBuffer()));
        const path = `${conversationId}/${crypto.randomUUID()}`;
        await backend.uploadAttachment!(path, enc.data);
        image = { path, info: enc.info, width: input.image.width, height: input.image.height, mimetype: input.image.blob.type || "image/jpeg" };
      }
      const payload: MessagePayload = { msgtype: image ? "m.image" : "m.text", body: text, "amigo.reply_to": input.replyToId ?? null, "amigo.image": image };
      const content = await d.encrypt(conversationId, peerId, payload).catch(translate);
      const { data: sent, error: sendError } = await db.rpc("dm_send", { p_conversation: conversationId, p_device: d.deviceId, p_content: content as Json });
      if (sendError) fail(sendError);
      // We already know what it says — no need to decrypt our own message again.
      const id = sent?.[0]?.id;
      if (id) decrypted.set(id, { ok: true, payload, senderMismatch: false, unverifiedDevice: false });
      invalidate();
    },

    async markRead(_viewerId, conversationId) {
      const { error } = await db.rpc("dm_mark_read", { p_conversation: conversationId });
      if (error) fail(error);
      invalidate();
    },

    setTyping(viewerId, conversationId, typing) {
      const { channel } = typingChannel(conversationId);
      void channel.send({ type: "broadcast", event: "typing", payload: { user: viewerId, typing } });
    },

    subscribeTyping(conversationId, viewerId, cb) {
      const entry = typingChannel(conversationId);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const handler = ({ payload }: { payload: { user: string; typing: boolean } }) => {
        if (payload.user === viewerId) return;
        clearTimeout(timer);
        cb(payload.typing);
        if (payload.typing) timer = setTimeout(() => cb(false), TYPING_TTL_MS);
      };
      entry.channel.on("broadcast", { event: "typing" }, handler);
      if (entry.users++ === 0) entry.channel.subscribe();
      return () => {
        clearTimeout(timer);
        if (--entry.users === 0) {
          void db.removeChannel(entry.channel);
          typingChannels.delete(conversationId);
        }
      };
    },

    async block(_viewerId, peerId) {
      const { error } = await db.rpc("dm_block", { p_user: peerId });
      if (error) fail(error);
      invalidate();
    },

    async unblock(_viewerId, peerId) {
      const { error } = await db.rpc("dm_unblock", { p_user: peerId });
      if (error) fail(error);
      invalidate();
    },

    async report(_viewerId, conversationId, input) {
      // The server can't read messages, so the evidence is what this device decrypted and you chose to share.
      const { data: rows } = await db.from("dm_messages").select("id, sender_id, created_at").in("id", input.messageIds.slice(0, 20));
      const evidence = (rows ?? []).flatMap((m) => {
        const res = decrypted.get(m.id);
        return res?.ok ? [{ id: m.id, sender_id: m.sender_id, text: res.payload.body, created_at: m.created_at }] : [];
      });
      const { error } = await db.rpc("dm_report", { p_conversation: conversationId, p_reason: input.reason, p_note: input.note, p_evidence: evidence as Json });
      if (error) fail(error);
    },
  };
}
