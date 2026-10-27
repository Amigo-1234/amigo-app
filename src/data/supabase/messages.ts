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
import { cached, forgetAll, remember } from "./viewCache";
import type { RealtimeChannel } from "@supabase/supabase-js";
import {
  MessageError,
  SecurityError,
  type Author,
  type Conversation,
  type ConversationView,
  type DirectMessage,
  type MediaItem,
  MESSAGE_EDIT_WINDOW_MS,
  MESSAGE_MAX_LENGTH,
  type MessageActionsApi,
  type MessageReaction,
  type MessagesApi,
  type MessageStatus,
  type MessagingSecurityApi,
  type Subscription,
  type VerificationFlow,
} from "../types";
import type { DecryptResult, E2EBackend, E2EDevice, MessagePayload, StoredMessage } from "./e2e";
import type { Db } from "./queries";
import { toAuthor, VERIFICATION_EMBED } from "./queries";
import type { MediaStore } from "./mediaStore";
import type { Json } from "./database.types";
import { describeDevice } from "../../lib/device";

type LiveQuery = <T>(name: string, fetcher: () => Promise<T>, sub: Subscription<T>, listen: (ch: RealtimeChannel, refresh: () => void) => RealtimeChannel, pollMs?: number) => () => void;

// Without Realtime (Neon) one shared, cheap "pulse" read (dm_pulse) runs while
// the tab is visible — every second with a conversation open, slower for the
// inbox and the badge — and views refetch only when it reports a change.
const PULSE_MS = { conversation: 1_000, inbox: 3_000, badge: 15_000 } as const;
/** A first load that takes longer than this shows a recoverable error instead of a skeleton. */
const FIRST_LOAD_LIMIT_MS = 20_000;
type LiveKind = keyof typeof PULSE_MS;

const PERSON = `id, username, display_name, avatar_url, ${VERIFICATION_EMBED}`;
const TYPING_TTL_MS = 6000;
const DEVICES_POLL_MS = 5 * 60_000;
const VERIFY_IDLE_MS = 60_000;

const ERRORS: Record<string, MessageError["code"]> = { DM002: "not-found", DM003: "not-found", DM004: "blocked", DM005: "unknown", RL001: "rate-limited", AS001: "suspended" };
function fail(error: { code?: string; message: string }): never {
  throw new MessageError(ERRORS[error.code ?? ""] ?? "unknown", error.message);
}

/** Crypto-layer errors (E2EError, or raw DM codes) as the app's MessageError / SecurityError. */
function translate(e: unknown): never {
  const code = (e as { code?: string })?.code;
  if (e instanceof MessageError || e instanceof SecurityError) throw e;
  if (code === "identity-changed" || code === "device-unverified") throw new MessageError(code);
  if (code === "DM012") throw new MessageError("device-unverified");
  if (code === "device-removed" || code === "DM009") throw new SecurityError("device-removed");
  if (code === "bad-recovery-key" || code === "wrong-recovery-key" || code === "no-backup" || code === "no-other-device") throw new SecurityError(code);
  if (code && ERRORS[code]) throw new MessageError(ERRORS[code], (e as Error).message);
  throw e;
}

const CANCEL: Record<string, VerificationFlow["cancelReason"]> = {
  "m.mismatched_sas": "mismatch",
  "m.key_mismatch": "mismatch",
  "m.mismatched_commitment": "mismatch",
  "m.timeout": "timeout",
};

/** opts.memoryStore: keep crypto keys in memory instead of IndexedDB (Node tests only). */
export function createSupabaseMessages(
  db: Db,
  liveQuery: LiveQuery,
  invalidate: () => void,
  opts: {
    memoryStore?: boolean;
    realtime?: boolean;
    media?: MediaStore | null;
    /** After a new message is stored (not a reaction or edit): e.g. ask the server to push it to the recipient's phones. */
    onSent?: (conversationId: string) => void;
  } = {},
): MessagesApi {
  // Neon: no Realtime channels (polling instead, no typing indicator) and no Storage (text only for now).
  const realtime = opts.realtime ?? true;

  // ------------------------------------------------------------ this device

  let current: { userId: string; device: Promise<E2EDevice> } | null = null;

  const backend: E2EBackend = {
    async rpc<T>(fn: string, args: Record<string, unknown>) {
      const { data, error } = await db.rpc(fn as never, args as never);
      // Keep the database's code (DM009 etc.): the crypto layer acts on it.
      if (error) throw Object.assign(new Error(error.message), { code: error.code });
      return data as T;
    },
    async syncState(deviceId, since) {
      const { data, error } = await db.rpc("e2e_sync_state" as never, { p_device: deviceId, p_since: since } as never);
      if (error) throw Object.assign(new Error(error.message), { code: error.code });
      return data as never;
    },
    async fetchToDevice(deviceId) {
      const { data, error } = await db.from("e2e_to_device").select("id, sender_id, event_type, content").eq("recipient_device", deviceId).order("id").limit(500);
      if (error) fail(error);
      return data;
    },
    async uploadAttachment(path, bytes) {
      // Neon: ciphertext goes to the media service; it assigns the key.
      if (opts.media) return opts.media.upload("dm", new Blob([bytes as BlobPart]), { conversationId: path.split("/")[0] });
      if (!realtime) throw new MessageError("unknown", "Photos in messages aren't available yet");
      const { error } = await db.storage.from("dm-attachments").upload(path, new Blob([bytes as BlobPart]), { contentType: "application/octet-stream" });
      if (error) throw new MessageError("unknown", error.message);
    },
    async downloadAttachment(path) {
      if (opts.media) return opts.media.bytes(path);
      if (!realtime) throw new MessageError("unknown", "Photos in messages aren't available yet");
      const { data, error } = await db.storage.from("dm-attachments").download(path);
      if (error || !data) throw new MessageError("unknown", error?.message ?? "download failed");
      return new Uint8Array(await data.arrayBuffer());
    },
  };

  const storageKey = (userId: string) => `amigo.e2e.${userId}`;

  /** This browser was removed from the account elsewhere: forget its keys so it starts over as a new device. */
  async function wipe(userId: string) {
    forgetAll();
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

  /**
   * Background messaging work (badge, device list, verification checks, setup)
   * waits until the first screen is up and the phone has a quiet moment, so the
   * encryption library (~2 MB) never competes with the first screen. Opening
   * Messages or sending starts it at once.
   */
  let settledPromise: Promise<void> | null = null;
  function settled(): Promise<void> {
    return (settledPromise ??= new Promise((resolve) => {
      if (typeof window === "undefined") return resolve();
      const idle = () =>
        "requestIdleCallback" in window ? window.requestIdleCallback(() => resolve(), { timeout: 4000 }) : void setTimeout(resolve, 1000);
      const go = () => setTimeout(idle, 1500);
      if (document.readyState === "complete") go();
      else window.addEventListener("load", go, { once: true });
    }));
  }
  const started = (userId: string) => current?.userId === userId;

  /** Runs fn with this device; a "device removed" answer wipes the local keys first. */
  async function withDevice<T>(userId: string, fn: (d: E2EDevice) => Promise<T>, background = false): Promise<T> {
    try {
      if (background && !started(userId)) await settled();
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
  /** conversation id → the other person, and people known to have a messaging device. */
  const peers = new Map<string, string>();
  const peersWithDevices = new Set<string>();
  const images = new Map<string, Promise<string | null>>();

  /** When a message last failed for a missing key: the device's key epoch then. */
  const failedAt = new Map<string, number>();

  /**
   * Decrypts many messages in one device job. Known results are reused: a
   * decrypted message never needs decrypting again, and one that lacked its key
   * is only retried once new keys may have arrived (mail, backup). Never throws:
   * anything that can't be read comes back as undecryptable.
   */
  async function openAll(userId: string, rows: StoredMessage[]): Promise<DecryptResult[]> {
    const missingKey: DecryptResult = { ok: false, reason: "missing-key" };
    let d: E2EDevice;
    try {
      d = await device(userId);
    } catch {
      return rows.map((m) => decrypted.get(m.id) ?? missingKey);
    }
    const fresh = (m: StoredMessage) => {
      const hit = decrypted.get(m.id);
      if (!hit) return false;
      if (hit.ok || hit.reason !== "missing-key") return true;
      return failedAt.get(m.id) === d.keyEpoch;
    };
    const todo = rows.filter((m) => !fresh(m));
    if (todo.length) {
      const results = await d.decryptMany(todo).catch(() => todo.map(() => missingKey));
      todo.forEach((m, i) => {
        decrypted.set(m.id, results[i]);
        if (!results[i].ok) failedAt.set(m.id, d.keyEpoch);
        else failedAt.delete(m.id);
      });
    }
    return rows.map((m) => decrypted.get(m.id) ?? missingKey);
  }

  /** Decrypted photos by path (null: couldn't be loaded; retried on the next refresh). */
  const imageReady = new Map<string, string | null>();
  let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  /** Re-render open conversations from memory (batched: several photos finishing together = one render). */
  function rebuildViews() {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      for (const l of lives) if (l.kind === "conversation") l.run();
    }, 50);
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
    // .then() is what sends it (builders are lazy).
    if (rows.some((r) => r.unread_count > 0)) db.rpc("dm_mark_delivered").then(() => undefined, () => undefined);
    const lastRows = rows
      .filter((r) => r.last_message_id && r.last_sender_id)
      .map((r) => ({ id: r.last_message_id!, conversation_id: r.conversation_id, sender_id: r.last_sender_id!, content: r.last_content, created_at: r.last_message_at }) as StoredMessage);
    const [, lastResults] = await Promise.all([authors(rows.map((r) => r.peer_id)), openAll(viewerId, lastRows)]);
    const lastById = new Map(lastRows.map((m, i) => [m.id, lastResults[i]]));
    return Promise.all(
      rows.map(async (r): Promise<Conversation> => {
        let last: Conversation["lastMessage"] = null;
        if (r.last_message_id && r.last_sender_id) {
          const res = lastById.get(r.last_message_id)!;
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

  interface Member {
    user_id: string;
    last_read_at: string;
    last_delivered_at: string;
  }
  interface Thread {
    /** Oldest first, deduplicated by id. */
    rows: StoredMessage[];
    members: Member[];
    blockedByMe: boolean;
    blockedEither: boolean;
    /** More history exists before the oldest loaded row. */
    hasOlder: boolean;
  }
  const threads = new Map<string, Thread>();

  /** One call: markers, block state and only the messages newer than what we already have. */
  async function loadThread(conversationId: string): Promise<Thread | null> {
    const known = threads.get(conversationId);
    const newest = known?.rows.at(-1)?.created_at ?? null;
    const { data, error } = await db.rpc("dm_thread" as never, { p_conversation: conversationId, p_after: newest, p_limit: known ? 100 : 50 } as never);
    if (error) {
      if (error.code === "DM003") return null;
      fail(error);
    }
    const res = data as unknown as ThreadResponse;
    const thread = merge(conversationId, known, res);
    if (!known) thread.hasOlder = res.messages.length >= 50;
    return thread;
  }

  interface ThreadResponse {
    members: Member[] | null;
    blocked_by_me: boolean;
    blocked_either: boolean;
    messages: StoredMessage[];
    /** Unsent since the cursor (ids only). */
    deleted?: string[];
  }

  function merge(conversationId: string, known: Thread | undefined, res: ThreadResponse): Thread {
    const byId = new Map((known?.rows ?? []).map((r) => [r.id, r]));
    for (const m of res.messages) byId.set(m.id, m);
    const gone = new Set(res.deleted ?? []);
    for (const id of gone) byId.delete(id);
    const thread: Thread = {
      rows: [...byId.values()]
        .filter((r) => !(r.relates_to && gone.has(r.relates_to)))
        .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1)),
      members: res.members ?? known?.members ?? [],
      blockedByMe: res.blocked_by_me,
      blockedEither: res.blocked_either,
      hasOlder: known?.hasOlder ?? false,
    };
    threads.set(conversationId, thread);
    return thread;
  }

  /** Reactions and edits found in the loaded rows, keyed by the message they belong to. */
  interface Annotations {
    /** target → sender → emoji ("" = removed). Later events win. */
    reactions: Map<string, Map<string, string>>;
    /** target → newest text from the target's own sender. */
    edits: Map<string, string>;
  }

  function annotations(rows: StoredMessage[], results: Map<string, DecryptResult>): Annotations {
    const out: Annotations = { reactions: new Map(), edits: new Map() };
    const senderOf = new Map(rows.filter((r) => !r.relates_to).map((r) => [r.id, r.sender_id]));
    const sentAt = new Map(rows.filter((r) => !r.relates_to).map((r) => [r.id, new Date(r.created_at).getTime()]));
    for (const r of rows) {
      if (!r.relates_to) continue;
      const res = results.get(r.id);
      // The server only links rows; the encrypted target must agree, so it can't re-point anything.
      if (!res?.ok || res.senderMismatch || res.payload["amigo.target"] !== r.relates_to) continue;
      const target = r.relates_to;
      if (res.payload.msgtype === "amigo.reaction") {
        let m = out.reactions.get(target);
        if (!m) out.reactions.set(target, (m = new Map()));
        m.set(r.sender_id, res.payload.body.slice(0, 16));
      } else if (
        res.payload.msgtype === "amigo.edit" &&
        senderOf.get(target) === r.sender_id &&
        // Both times are the server's: an edit made after the window is ignored (the server refuses new ones too).
        new Date(r.created_at).getTime() - (sentAt.get(target) ?? Infinity) <= MESSAGE_EDIT_WINDOW_MS
      ) {
        out.edits.set(target, res.payload.body);
      }
    }
    return out;
  }

  function reactionList(byPerson: Map<string, string> | undefined, viewerId: string): MessageReaction[] {
    if (!byPerson) return [];
    const groups = new Map<string, MessageReaction>();
    for (const [who, emoji] of byPerson) {
      if (!emoji) continue;
      const g = groups.get(emoji) ?? { emoji, count: 0, mine: false };
      g.count++;
      g.mine ||= who === viewerId;
      groups.set(emoji, g);
    }
    return [...groups.values()];
  }

  /** Conversations whose view should be rebuilt from what's loaded (a photo finished), without a refetch. */
  const rebuildOnly = new Set<string>();

  async function conversation(conversationId: string, viewerId: string): Promise<ConversationView | null> {
    // The thread and this device (encryption library + key sync) load side by side.
    void device(viewerId).catch(() => undefined);
    const fromMemory = rebuildOnly.delete(conversationId) && threads.has(conversationId);
    // A real refresh gives photos that failed to load another try.
    if (!fromMemory) for (const [path, url] of imageReady) if (url === null) imageReady.delete(path);
    const thread = fromMemory ? threads.get(conversationId)! : await loadThread(conversationId);
    if (!thread) return null;
    const me = thread.members.find((m) => m.user_id === viewerId);
    const peer = thread.members.find((m) => m.user_id !== viewerId);
    if (!me || !peer) return null;
    peers.set(conversationId, peer.user_id);
    await authors([peer.user_id]);
    const blocks = thread.blockedByMe ? [peer.user_id] : [];
    const blockedEither = thread.blockedEither;

    const all = thread.rows;
    const decryptedAll = await openAll(viewerId, all);
    const byId = new Map(all.map((m, i) => [m.id, decryptedAll[i]]));
    const notes = annotations(all, byId);
    const isMessage = (r: DecryptResult | undefined) => !r?.ok || r.payload.msgtype === "m.text" || r.payload.msgtype === "m.image";
    // A reaction/edit whose row lost its link is never shown as a message.
    const list = all.filter((m) => !m.relates_to && isMessage(byId.get(m.id)));
    const results = list.map((m) => byId.get(m.id)!);
    const textOf = (id: string, res: DecryptResult | undefined) => notes.edits.get(id) ?? (res?.ok ? res.payload.body : "");

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
          // Photos download and decrypt in the background: the conversation shows at once
          // with a placeholder, and the view is rebuilt as each photo is ready.
          const img = p["amigo.image"];
          const ready = imageReady.get(img.path);
          if (ready !== undefined) {
            if (ready) media.push({ type: "image", url: ready, width: img.width, height: img.height });
          } else {
            media.push({ type: "image", url: "", width: img.width, height: img.height });
            void imageUrl(viewerId, img).then((url) => {
              imageReady.set(img.path, url);
              rebuildOnly.add(conversationId);
              rebuildViews();
            });
          }
        }
        const quotedId = p["amigo.reply_to"];
        const quoted = quotedId ? byId.get(quotedId) : null;
        const quotedRow = quotedId ? list.find((x) => x.id === quotedId) : null;
        return {
          ...base,
          text: textOf(m.id, res),
          edited: notes.edits.has(m.id),
          reactions: reactionList(notes.reactions.get(m.id), viewerId),
          unverifiedDevice: !!res.unverifiedDevice && !fromViewer,
          media,
          replyTo:
            quotedId && quotedRow
              ? {
                  id: quotedId,
                  fromViewer: quotedRow.sender_id === viewerId,
                  text: textOf(quotedId, quoted ?? undefined),
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
        blockedByViewer: blocks.length > 0,
        canSend: !blockedEither,
      },
      messages,
    };
  }

  // ---------------------------------------------------------- live updates

  interface Live {
    kind: LiveKind;
    run: () => void;
  }
  const lives = new Set<Live>();
  let pulseViewer: string | null = null;
  let pulseTimer: ReturnType<typeof setTimeout> | undefined;
  let pulseBusy = false;
  let pulseForced = false;
  let lastPulse: string | null = null;
  let lastMail: unknown = undefined;
  let lastTyping: string | null = null;

  // ------------------------------------------------- typing (no Realtime)

  /** Open conversations' typing listeners (usually just the one on screen). */
  const typingListeners = new Map<string, Set<(typing: boolean) => void>>();
  const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** When this device last told the server it's typing, per conversation (heartbeat throttle). */
  const typingSent = new Map<string, number>();

  function refreshTyping() {
    for (const [conversationId, cbs] of typingListeners) {
      void db.rpc("dm_peer_typing_ms" as never, { p_conversation: conversationId } as never).then(({ data }) => {
        const ms = Number(data ?? 0);
        clearTimeout(typingTimers.get(conversationId));
        cbs.forEach((cb) => cb(ms > 0));
        // Expire locally too: a stop that never arrives (closed tab) still ends.
        if (ms > 0) typingTimers.set(conversationId, setTimeout(() => cbs.forEach((cb) => cb(false)), ms));
      });
    }
  }
  const visible = () => typeof document === "undefined" || document.visibilityState === "visible";

  let lastChangeAt = Date.now();
  function schedulePulse() {
    clearTimeout(pulseTimer);
    let ms = Infinity;
    for (const l of lives) ms = Math.min(ms, PULSE_MS[l.kind]);
    // Quiet for a minute: ease off (up to 4×, at most 4 s) until something happens again.
    if (ms !== Infinity && Date.now() - lastChangeAt > 60_000) ms = Math.max(ms, Math.min(ms * 4, 4_000));
    if (ms !== Infinity) pulseTimer = setTimeout(() => void pulse(false), ms);
  }

  /** One small read; views refetch only if something changed (or after our own writes). */
  async function pulse(force: boolean) {
    if (pulseBusy) {
      pulseForced ||= force;
      return;
    }
    if (!pulseViewer || !lives.size || !visible()) return schedulePulse();
    pulseBusy = true;
    try {
      // Only the badge is open: no hurry to start the encryption library.
      if (!started(pulseViewer) && [...lives].every((l) => l.kind === "badge")) await settled();
      const d = await device(pulseViewer);
      const { data, error } = await db.rpc("dm_pulse" as never, { p_device: d.deviceId } as never);
      if (error) throw error;
      // t (someone typing to you) only refreshes the typing indicator, never the views.
      const { x, t, ...rest } = (data ?? {}) as { x?: unknown; t?: string | null };
      const key = JSON.stringify(rest);
      if ((t ?? null) !== lastTyping) {
        lastTyping = t ?? null;
        refreshTyping();
      }
      const mail = x !== lastMail && lastMail !== undefined;
      lastMail = x;
      // New key/verification mail for this device: take it in before re-rendering (may unlock messages).
      if (mail) {
        await d.refresh().catch(() => undefined);
        pokeVerifications();
      }
      // The first check after the app starts can't tell what changed since the views
      // loaded (a message stored between a view's first load and this check would
      // already be in the baseline and never shown), so it refreshes them once.
      if (force || mail || lastPulse === null || key !== lastPulse) {
        lastChangeAt = Date.now();
        for (const l of lives) l.run();
      }
      lastPulse = key;
    } catch {
      // Network hiccup: the next pulse tries again.
    } finally {
      pulseBusy = false;
      if (pulseForced) {
        pulseForced = false;
        void pulse(true);
      } else schedulePulse();
    }
  }

  if (!realtime && typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => visible() && void pulse(true));
    // Back online: catch up at once (messages sent meanwhile, read receipts), not at the next tick.
    window.addEventListener("online", () => void pulse(true));
  }

  /** After our own writes: refresh now instead of waiting for the next pulse. */
  function changed() {
    invalidate();
    if (!realtime) void pulse(true);
  }

  /** Realtime backends: liveQuery + channels. Neon: driven by the shared pulse. */
  function live<T>(kind: LiveKind, viewerId: string, name: string, fetcher: () => Promise<T>, sub: Subscription<T>, listen: (ch: RealtimeChannel, refresh: () => void) => RealtimeChannel) {
    if (realtime) return liveQuery(name, fetcher, sub, listen);
    let active = true;
    let running = false;
    let again = false;
    let delivered = false;
    const run = async () => {
      if (running) return void (again = true);
      running = true;
      try {
        const value = await fetcher();
        remember(cacheKey, value);
        delivered = true;
        if (active) sub.onData(value);
      } catch (e) {
        if (active) sub.onError(e as Error);
      } finally {
        running = false;
        if (again && active) {
          again = false;
          void run();
        }
      }
    };
    const entry: Live = { kind, run: () => void run() };
    pulseViewer = viewerId;
    lives.add(entry);
    // What this view showed last time (this tab's memory only), then refresh.
    const cacheKey = `${viewerId}:${name}`;
    const last = cached<T>(cacheKey);
    if (last !== undefined) sub.onData(last, { cached: true });
    // A screen must never wait forever on a stalled connection: after a while,
    // say so (with Try again). If the load still finishes, its data replaces that.
    const watchdog =
      last === undefined
        ? setTimeout(() => active && !delivered && sub.onError(Object.assign(new Error("Taking too long to load"), { code: "unavailable" })), FIRST_LOAD_LIMIT_MS)
        : undefined;
    void run();
    schedulePulse();
    return () => {
      clearTimeout(watchdog);
      active = false;
      lives.delete(entry);
      schedulePulse();
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

  // ------------------------------------------------------------- sending

  const sendQueues = new Map<string, Promise<unknown>>();
  /** Runs fn after this conversation's earlier sends have finished (whether or not they worked). */
  function inOrder<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    const run = (sendQueues.get(conversationId) ?? Promise.resolve()).then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    sendQueues.set(conversationId, tail);
    void tail.then(() => sendQueues.get(conversationId) === tail && sendQueues.delete(conversationId));
    return run;
  }

  async function sendNow(viewerId: string, conversationId: string, input: Parameters<MessagesApi["send"]>[2], text: string): Promise<{ id: string }> {
    const { d, peerId } = await sender(viewerId, conversationId);
    let image: MessagePayload["amigo.image"] = null;
    if (input.image) {
      const enc = d.encryptAttachment(new Uint8Array(await input.image.blob.arrayBuffer()));
      let path = `${conversationId}/${crypto.randomUUID()}`;
      // The media service returns the key it assigned (the path is a hint for the conversation).
      path = (await backend.uploadAttachment!(path, enc.data)) || path;
      image = { path, info: enc.info, width: input.image.width, height: input.image.height, mimetype: input.image.blob.type || "image/jpeg" };
    }
    const payload: MessagePayload = { msgtype: image ? "m.image" : "m.text", body: text, "amigo.reply_to": input.replyToId ?? null, "amigo.image": image };
    const content = await d.encrypt(conversationId, peerId, payload).catch(translate);
    // The id is chosen here, so a retry after a lost response can't store the message twice.
    const messageId = input.clientId ?? globalThis.crypto.randomUUID();
    const { data: sent, error: sendError } = await db.rpc("dm_send_v2" as never, { p_id: messageId, p_conversation: conversationId, p_device: d.deviceId, p_content: content as Json } as never);
    if (sendError) fail(sendError);
    // We already know what it says — no need to decrypt our own message again.
    const id = (sent as unknown as { id: string }[] | null)?.[0]?.id ?? messageId;
    decrypted.set(id, { ok: true, payload, senderMismatch: false, unverifiedDevice: false });
    changed();
    opts.onSent?.(conversationId);
    return { id };
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

    setup: (viewerId) => withDevice(viewerId, (d) => d.ownSecurity(), true),

    subscribeDevices: (viewerId, sub) =>
      liveQuery(
        "e2e:devices",
        () =>
          withDevice(
            viewerId,
            async (d) =>
              (await d.myDevices()).map((x) => ({
              id: x.deviceId,
              name: x.name ?? "Unknown device",
              current: x.current,
              verified: x.verified,
              createdAt: new Date(x.createdAt),
              lastActiveAt: x.lastSeenAt ? new Date(x.lastSeenAt) : null,
            })),
            true,
          ),
        sub,
        (ch, refresh) => ch.on("postgres_changes", { event: "*", schema: "public", table: "e2e_devices", filter: `user_id=eq.${viewerId}` }, refresh),
        // Only for "new sign-in" notices: every 5 minutes is plenty (changes here refresh it at once).
        DEVICES_POLL_MS,
      ),

    async removeDevice(viewerId, deviceId) {
      await withDevice(viewerId, (d) => d.removeDevice(deviceId));
      changed();
    },

    peerTrust: (viewerId, peerId) => withDevice(viewerId, (d) => d.peerTrust(peerId)),

    async acceptIdentityChange(viewerId, peerId) {
      await withDevice(viewerId, (d) => d.acceptIdentityChange(peerId));
      changed();
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
        // New verification mail wakes this at once (the shared pulse sees it); otherwise a slow check.
        let next = VERIFY_IDLE_MS;
        try {
          const flows = await withDevice(
            viewerId,
            async (d) => {
              await d.refresh();
              return d.verifications();
            },
            true,
          );
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
      // Without Realtime the tick's own polling (10 s idle, 1.5 s during a verification) is the only signal.
      const channel = realtime
        ? db
            .channel(`e2e:mail:${crypto.randomUUID()}`)
            .on("postgres_changes", { event: "INSERT", schema: "public", table: "e2e_to_device", filter: `recipient_id=eq.${viewerId}` }, poke)
            .subscribe()
        : null;
      void tick();
      return () => {
        active = false;
        clearTimeout(timer);
        verificationListeners.delete(poke);
        if (channel) void db.removeChannel(channel);
      };
    },

    async acceptVerification(viewerId, flowId) {
      await withDevice(viewerId, (d) => d.acceptVerification(flowId));
      pokeVerifications();
    },
    async confirmVerification(viewerId, flowId) {
      await withDevice(viewerId, (d) => d.confirmVerification(flowId));
      pokeVerifications();
      changed();
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
      changed();
      return result;
    },
    async resetIdentity(viewerId) {
      await withDevice(viewerId, (d) => d.resetIdentity());
      changed();
    },
  };

  /** This device and the other person, checked once per conversation. */
  async function sender(viewerId: string, conversationId: string) {
    let peerId = peers.get(conversationId);
    if (!peerId) {
      const { data: members, error } = await db.from("dm_participants").select("user_id").eq("conversation_id", conversationId);
      if (error) fail(error);
      peerId = members?.find((m) => m.user_id !== viewerId)?.user_id;
      if (!peerId) throw new MessageError("not-found");
      peers.set(conversationId, peerId);
    }
    // Encrypting for someone with no devices would make the message unreadable forever.
    // (Checked until they have one; devices don't disappear in a way this check would catch anyway.)
    if (!peersWithDevices.has(peerId)) {
      const { count } = await db.from("e2e_devices").select("device_id", { count: "exact", head: true }).eq("user_id", peerId);
      if (!count) throw new MessageError("peer-unavailable");
      peersWithDevices.add(peerId);
    }
    const d = await device(viewerId).catch(translate);
    return { d, peerId };
  }

  /** A reaction or edit: encrypted like a message, linked to its message by id. */
  async function annotate(viewerId: string, conversationId: string, target: string, payload: MessagePayload) {
    const { d, peerId } = await sender(viewerId, conversationId);
    const content = await d.encrypt(conversationId, peerId, { ...payload, "amigo.target": target }).catch(translate);
    const id = globalThis.crypto.randomUUID();
    const { error } = await db.rpc("dm_send_v3" as never, { p_id: id, p_conversation: conversationId, p_device: d.deviceId, p_content: content as Json, p_relates_to: target } as never);
    if (error) fail(error);
    decrypted.set(id, { ok: true, payload: { ...payload, "amigo.target": target }, senderMismatch: false, unverifiedDevice: false });
    changed();
  }

  const ownMessage = (viewerId: string, conversationId: string, messageId: string) => {
    const row = threads.get(conversationId)?.rows.find((r) => r.id === messageId && !r.relates_to);
    if (!row || row.sender_id !== viewerId) throw new MessageError("not-found");
    return row;
  };

  const actions: MessageActionsApi = {
    react: (viewerId, conversationId, messageId, emoji) =>
      annotate(viewerId, conversationId, messageId, { msgtype: "amigo.reaction", body: emoji ? [...emoji].slice(0, 8).join("") : "" }),

    async edit(viewerId, conversationId, messageId, text) {
      const body = text.trim();
      if (!body) throw new MessageError("empty");
      if (body.length > MESSAGE_MAX_LENGTH) throw new MessageError("too-long");
      const row = ownMessage(viewerId, conversationId, messageId);
      if (Date.now() - new Date(row.created_at).getTime() > MESSAGE_EDIT_WINDOW_MS) throw new MessageError("unknown", "too late to edit");
      await annotate(viewerId, conversationId, messageId, { msgtype: "amigo.edit", body });
    },

    async unsend(viewerId, conversationId, messageId) {
      ownMessage(viewerId, conversationId, messageId);
      const { error } = await db.rpc("dm_unsend" as never, { p_id: messageId } as never);
      if (error) fail(error);
      const t = threads.get(conversationId);
      if (t) t.rows = t.rows.filter((r) => r.id !== messageId && r.relates_to !== messageId);
      decrypted.delete(messageId);
      changed();
    },

    async loadOlder(_viewerId, conversationId) {
      const known = threads.get(conversationId);
      const oldest = known?.rows[0]?.created_at;
      if (!known || !oldest || !known.hasOlder) return false;
      const { data, error } = await db.rpc("dm_thread" as never, { p_conversation: conversationId, p_before: oldest, p_limit: 50 } as never);
      if (error) fail(error);
      const res = data as unknown as ThreadResponse;
      const thread = merge(conversationId, threads.get(conversationId), { ...res, deleted: [] });
      thread.hasOlder = res.messages.length >= 50;
      changed();
      return thread.hasOlder;
    },
  };

  return {
    encryption: "e2e",
    photos: realtime || !!opts.media,
    security,
    // Reactions, edits and unsend need the dm_send_v3 / dm_unsend functions (Neon schema).
    actions: realtime ? undefined : actions,

    subscribeConversations: (viewerId, sub) => live("inbox", viewerId, "dm:inbox", () => inbox(viewerId), sub, dmListen(viewerId)),

    subscribeUnreadCount: (viewerId, sub) =>
      live(
        "badge",
        viewerId,
        "dm:unread",
        async () => {
          // The badge is on every screen, so this registers this browser as a messaging
          // device soon after sign-in — people can receive messages before ever opening Messages.
          void settled()
            .then(() => device(viewerId))
            .catch((e) => console.warn("Encrypted messaging unavailable on this device", e));
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
      live("conversation", viewerId, `dm:${conversationId}`, () => conversation(conversationId, viewerId), sub, dmListen(viewerId)),

    send(viewerId, conversationId, input) {
      const text = input.text.trim();
      if (!text && !input.image) return Promise.reject(new MessageError("empty"));
      // One at a time per conversation, in the order they were written: sent side by side, quick
      // messages reached the server (and got their timestamps) in whatever order the network
      // delivered them, so the other person read them shuffled.
      return inOrder(conversationId, () => sendNow(viewerId, conversationId, input, text));
    },

    async markRead(_viewerId, conversationId) {
      const { error } = await db.rpc("dm_mark_read", { p_conversation: conversationId });
      if (error) fail(error);
      changed();
    },

    setTyping(viewerId, conversationId, typing) {
      // Receivers keep "typing" for 6 s; send a heartbeat every 3 s at most while typing.
      const last = typingSent.get(conversationId);
      if (typing) {
        if (last && Date.now() - last < 3000) return;
        typingSent.set(conversationId, Date.now());
      } else {
        if (!last) return;
        typingSent.delete(conversationId);
      }
      if (!realtime) {
        // Builders are lazy: .then() is what sends it. Failures just mean no indicator.
        db.rpc("dm_set_typing" as never, { p_conversation: conversationId, p_typing: typing } as never).then(
          () => undefined,
          () => undefined,
        );
        return;
      }
      const { channel } = typingChannel(conversationId);
      void channel.send({ type: "broadcast", event: "typing", payload: { user: viewerId, typing } });
    },

    subscribeTyping(conversationId, viewerId, cb) {
      if (!realtime) {
        let set = typingListeners.get(conversationId);
        if (!set) typingListeners.set(conversationId, (set = new Set()));
        set.add(cb);
        if (lastTyping) refreshTyping();
        return () => {
          set!.delete(cb);
          if (!set!.size) {
            typingListeners.delete(conversationId);
            clearTimeout(typingTimers.get(conversationId));
          }
        };
      }
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
      changed();
    },

    async unblock(_viewerId, peerId) {
      const { error } = await db.rpc("dm_unblock", { p_user: peerId });
      if (error) fail(error);
      changed();
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
