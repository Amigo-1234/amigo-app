/**
 * Direct messages for the in-memory demo source. One-to-one only.
 *
 * NOT end-to-end encrypted: the demo keeps messages in this browser (and its
 * saved demo state), so the API reports encryption "none" and the UI never
 * claims encryption here. The Supabase backend is the encrypted one — see
 * docs/architecture/MESSAGES.md. Same rules as the Supabase migration
 * (20261006200000_messages.sql): members only, no messaging yourself, nothing
 * can be sent while either person has blocked the other.
 *
 * The other people in the demo "answer": your message is delivered, then read,
 * then they type and reply (switch off with __amigoDemo.messages.autoReply(false)).
 */
import type {
  Author,
  Conversation,
  ConversationView,
  DirectMessage,
  MediaItem,
  MessageReportReason,
  MessagesApi,
  MessageStatus,
  NewMediaInput,
  Subscription,
} from "./types";
import { MESSAGE_MAX_LENGTH, MessageError } from "./types";

export interface MessagesContext {
  author: (id: string) => Author;
  exists: (id: string) => boolean;
  emit: () => void;
  watch: <T>(sub: Subscription<T>, read: () => T) => () => void;
  later: <T>(fn: () => T, ms?: number) => Promise<T>;
  img: (seed: string, w: number, h: number) => MediaItem;
  /** Turns an upload into a blob: URL the demo can also save. */
  upload: (m: NewMediaInput) => MediaItem;
}

interface MessageRecord {
  id: string;
  conversationId: string;
  senderId: string;
  text: string;
  media: MediaItem[];
  replyToId: string | null;
  createdAt: Date;
}

interface ConversationRecord {
  id: string;
  members: [string, string];
  createdAt: Date;
  /** Per member: everything up to this time has been read / reached their device. */
  readAt: Record<string, Date>;
  deliveredAt: Record<string, Date>;
}

interface ReportRecord {
  id: string;
  reporterId: string;
  conversationId: string;
  reportedId: string;
  reason: MessageReportReason;
  note: string;
  messages: { id: string; senderId: string; text: string; createdAt: Date }[];
  createdAt: Date;
}

const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);
const MAX_REPORTED_MESSAGES = 20;

/** What each person says back when the demo answers for them. */
const REPLIES: Record<string, string[]> = {
  ama: ["Ha, yes!", "Sending you the photos tonight 📸", "Rooftop again soon?"],
  leo: ["Deal.", "I'll check the weather and get back to you", "Group chat is going to love this"],
  mira: ["Thank you!! 🎧", "Friday. Promise.", "Come to the listening party?"],
  kofi: ["Say less.", "Snacks are on me", "We'll see about that 😄"],
};
const FALLBACK_REPLIES = ["😄", "Love that", "Talk soon!"];

export function createDemoMessages(ctx: MessagesContext) {
  const conversations: ConversationRecord[] = [];
  const messages: MessageRecord[] = [];
  const blocks = new Set<string>();
  const reports: ReportRecord[] = [];
  let seq = 0;
  let autoReply = true;
  const replyTurn = new Map<string, number>();

  const block = (a: string, b: string) => `${a}->${b}`;
  const blockedEither = (a: string, b: string) => blocks.has(block(a, b)) || blocks.has(block(b, a));
  const peerOf = (c: ConversationRecord, viewerId: string) => (c.members[0] === viewerId ? c.members[1] : c.members[0]);
  const isMember = (c: ConversationRecord, id: string) => c.members.includes(id);
  const nextId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`;

  // ------------------------------------------------------------------ seed

  function seedConversation(id: string, peer: string, createdAgo: number, msgs: [string, string, number, MediaItem[]?, string?][], read: { me: number; peer: number }) {
    const c: ConversationRecord = {
      id,
      members: ["me", peer],
      createdAt: ago(createdAgo),
      readAt: { me: ago(read.me), [peer]: ago(read.peer) },
      deliveredAt: { me: ago(0), [peer]: ago(0) },
    };
    conversations.push(c);
    msgs.forEach(([sender, text, at, media = [], replyTo], i) =>
      messages.push({ id: `${id}-${i}`, conversationId: id, senderId: sender, text, media, replyToId: replyTo ?? null, createdAt: ago(at) }),
    );
  }

  seedConversation("c-leo", "leo", 3 * 24 * 60 * MIN, [
    ["me", "Hike next month — are we doing the lake route?", 3 * 60 * MIN],
    ["leo", "Lake route for sure", 25 * MIN],
    ["leo", "Also, who's driving? My car is still in the shop", 24 * MIN],
  ], { me: 2 * 60 * MIN, peer: 30 * MIN });
  seedConversation("c-mira", "mira", 9 * 24 * 60 * MIN, [
    ["mira", "Sneak peek of the cover art 👀", 70 * MIN, [ctx.img("amigo-cover", 1080, 1080)]],
    ["me", "That's going to look great on vinyl", 50 * MIN, [], "c-mira-0"],
  ], { me: 55 * MIN, peer: 60 * MIN });
  seedConversation("c-ama", "ama", 20 * 24 * 60 * MIN, [
    ["ama", "Are you coming to the rooftop thing on Friday?", 2 * 24 * 60 * MIN],
    ["me", "Wouldn't miss it. Bringing the speaker.", 2 * 24 * 60 * MIN - 5 * MIN],
    ["ama", "Perfect. I'll save you a spot by the plants 🌿", 2 * 24 * 60 * MIN - 9 * MIN],
  ], { me: 24 * 60 * MIN, peer: 24 * 60 * MIN });
  seedConversation("c-kofi", "kofi", 30 * 24 * 60 * MIN, [
    ["kofi", "Jollof rematch when?", 6 * 24 * 60 * MIN],
    ["me", "Name the day.", 6 * 24 * 60 * MIN - 30 * MIN],
  ], { me: 5 * 24 * 60 * MIN, peer: 5 * 24 * 60 * MIN });

  // ----------------------------------------------------------------- views

  function statusOf(m: MessageRecord, c: ConversationRecord, viewerId: string): MessageStatus {
    if (m.senderId !== viewerId) return "read";
    const peer = peerOf(c, viewerId);
    if ((c.readAt[peer]?.getTime() ?? 0) >= m.createdAt.getTime()) return "read";
    if ((c.deliveredAt[peer]?.getTime() ?? 0) >= m.createdAt.getTime()) return "delivered";
    return "sent";
  }

  function toMessage(m: MessageRecord, c: ConversationRecord, viewerId: string): DirectMessage {
    const quoted = m.replyToId ? messages.find((x) => x.id === m.replyToId) : null;
    return {
      id: m.id,
      conversationId: m.conversationId,
      senderId: m.senderId,
      fromViewer: m.senderId === viewerId,
      text: m.text,
      media: m.media,
      replyTo: quoted ? { id: quoted.id, fromViewer: quoted.senderId === viewerId, text: quoted.text, hasImage: quoted.media.length > 0 } : null,
      createdAt: m.createdAt,
      status: statusOf(m, c, viewerId),
    };
  }

  const messagesIn = (id: string) => messages.filter((m) => m.conversationId === id).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  function toConversation(c: ConversationRecord, viewerId: string): Conversation {
    const peer = peerOf(c, viewerId);
    const list = messagesIn(c.id);
    const last = list[list.length - 1];
    const readAt = c.readAt[viewerId]?.getTime() ?? 0;
    return {
      id: c.id,
      peer: ctx.author(peer),
      lastMessage: last
        ? { text: last.text, hasImage: last.media.length > 0, fromViewer: last.senderId === viewerId, createdAt: last.createdAt, status: statusOf(last, c, viewerId) }
        : null,
      unreadCount: list.filter((m) => m.senderId !== viewerId && m.createdAt.getTime() > readAt).length,
      blockedByViewer: blocks.has(block(viewerId, peer)),
      canSend: !blockedEither(viewerId, peer),
    };
  }

  /** Conversations you're in that have messages, newest activity first. */
  function listFor(viewerId: string): Conversation[] {
    return conversations
      .filter((c) => isMember(c, viewerId) && messages.some((m) => m.conversationId === c.id))
      .map((c) => toConversation(c, viewerId))
      .sort((a, b) => b.lastMessage!.createdAt.getTime() - a.lastMessage!.createdAt.getTime());
  }

  const find = (id: string, viewerId: string) => {
    const c = conversations.find((x) => x.id === id);
    return c && isMember(c, viewerId) ? c : null;
  };

  // ---------------------------------------------------------------- typing

  const typing = new Map<string, string>(); // conversationId -> person typing
  const typingListeners = new Set<() => void>();
  const emitTyping = () => typingListeners.forEach((l) => l());

  function setPeerTyping(c: ConversationRecord, personId: string, on: boolean) {
    if (on) typing.set(c.id, personId);
    else if (typing.get(c.id) === personId) typing.delete(c.id);
    emitTyping();
  }

  // ---------------------------------------------------------------- writes

  function addMessage(c: ConversationRecord, senderId: string, text: string, media: MediaItem[], replyToId: string | null) {
    const m: MessageRecord = { id: nextId("m"), conversationId: c.id, senderId, text, media, replyToId, createdAt: new Date() };
    messages.push(m);
    // Sending means you've seen everything before it.
    c.readAt[senderId] = m.createdAt;
    c.deliveredAt[senderId] = m.createdAt;
    return m;
  }

  /** The demo's stand-in for the other person's phone. */
  function answer(c: ConversationRecord, viewerId: string, peer: string) {
    const stamp = (field: "deliveredAt" | "readAt") => {
      c[field][peer] = new Date();
      ctx.emit();
    };
    setTimeout(() => stamp("deliveredAt"), 700);
    setTimeout(() => stamp("readAt"), 1800);
    setTimeout(() => !blockedEither(viewerId, peer) && setPeerTyping(c, peer, true), 2300);
    setTimeout(() => {
      setPeerTyping(c, peer, false);
      if (blockedEither(viewerId, peer) || !autoReply) return;
      const lines = REPLIES[peer] ?? FALLBACK_REPLIES;
      const turn = replyTurn.get(peer) ?? 0;
      replyTurn.set(peer, turn + 1);
      addMessage(c, peer, lines[turn % lines.length], [], null);
      ctx.emit();
    }, 4200);
  }

  const api: MessagesApi = {
    encryption: "none",

    subscribeConversations: (viewerId, sub) =>
      ctx.watch(sub, () => {
        // This device is online, so everything sent to you has reached it.
        const now = new Date();
        conversations.forEach((c) => isMember(c, viewerId) && (c.deliveredAt[viewerId] = now));
        return listFor(viewerId);
      }),

    subscribeUnreadCount: (viewerId, sub) => ctx.watch(sub, () => listFor(viewerId).filter((c) => c.unreadCount > 0).length),

    openConversation: (viewerId, peerId) =>
      ctx.later(() => {
        if (peerId === viewerId || !ctx.exists(peerId)) throw new MessageError("not-found");
        let c = conversations.find((x) => isMember(x, viewerId) && isMember(x, peerId));
        if (!c) {
          const now = new Date();
          c = { id: nextId("c"), members: [viewerId, peerId], createdAt: now, readAt: {}, deliveredAt: {} };
          conversations.push(c);
          ctx.emit();
        }
        return c.id;
      }, 200),

    subscribeConversation: (conversationId, viewerId, sub) =>
      ctx.watch(sub, (): ConversationView | null => {
        const c = find(conversationId, viewerId);
        if (!c) return null;
        return { conversation: toConversation(c, viewerId), messages: messagesIn(c.id).map((m) => toMessage(m, c, viewerId)) };
      }),

    send: (viewerId, conversationId, input) =>
      ctx.later(() => {
        const c = find(conversationId, viewerId);
        if (!c) throw new MessageError("not-found");
        const peer = peerOf(c, viewerId);
        if (blockedEither(viewerId, peer)) throw new MessageError("blocked");
        const text = input.text.trim();
        if (!text && !input.image) throw new MessageError("empty");
        if (text.length > MESSAGE_MAX_LENGTH) throw new MessageError("too-long");
        const replyToId = input.replyToId && messages.some((m) => m.id === input.replyToId && m.conversationId === c.id) ? input.replyToId : null;
        addMessage(c, viewerId, text, input.image ? [ctx.upload(input.image)] : [], replyToId);
        ctx.emit();
        answer(c, viewerId, peer);
      }, input.image ? 700 : 350),

    markRead: (viewerId, conversationId) =>
      ctx.later(() => {
        const c = find(conversationId, viewerId);
        if (!c) return;
        c.readAt[viewerId] = new Date();
        c.deliveredAt[viewerId] = new Date();
        ctx.emit();
      }, 100),

    setTyping: () => {
      // Typing is shown to the other person only; in the demo nobody else is watching.
    },

    subscribeTyping: (conversationId, viewerId, cb) => {
      const l = () => {
        const who = typing.get(conversationId);
        cb(!!who && who !== viewerId);
      };
      typingListeners.add(l);
      l();
      return () => typingListeners.delete(l);
    },

    block: (viewerId, peerId) =>
      ctx.later(() => {
        if (peerId === viewerId) throw new MessageError("not-found");
        blocks.add(block(viewerId, peerId));
        ctx.emit();
      }, 300),

    unblock: (viewerId, peerId) =>
      ctx.later(() => {
        blocks.delete(block(viewerId, peerId));
        ctx.emit();
      }, 300),

    report: (viewerId, conversationId, input) =>
      ctx.later(() => {
        const c = find(conversationId, viewerId);
        if (!c) throw new MessageError("not-found");
        const ids = new Set(input.messageIds.slice(0, MAX_REPORTED_MESSAGES));
        reports.push({
          id: nextId("dr"),
          reporterId: viewerId,
          conversationId,
          reportedId: peerOf(c, viewerId),
          reason: input.reason,
          note: input.note.trim().slice(0, 500),
          messages: messagesIn(c.id)
            .filter((m) => ids.has(m.id))
            .map(({ id, senderId, text, createdAt }) => ({ id, senderId, text, createdAt })),
          createdAt: new Date(),
        });
      }, 400),
  };

  return {
    api,
    /** Test/demo hooks (window.__amigoDemo.messages). */
    hooks: {
      /** Someone sends you a message (creating the conversation if needed). */
      receive(peerId: string, text: string, viewerId = "me") {
        let c = conversations.find((x) => isMember(x, viewerId) && isMember(x, peerId));
        if (!c) {
          c = { id: nextId("c"), members: [viewerId, peerId], createdAt: new Date(), readAt: {}, deliveredAt: {} };
          conversations.push(c);
        }
        if (blockedEither(viewerId, peerId)) return false;
        addMessage(c, peerId, text, [], null);
        ctx.emit();
        return true;
      },
      autoReply(on: boolean) {
        autoReply = on;
      },
      typing(peerId: string, on: boolean, viewerId = "me") {
        const c = conversations.find((x) => isMember(x, viewerId) && isMember(x, peerId));
        if (c) setPeerTyping(c, peerId, on);
      },
      reports: () => reports.map((r) => ({ ...r })),
      count: (viewerId = "me") => messages.filter((m) => conversations.some((c) => c.id === m.conversationId && isMember(c, viewerId))).length,
    },
    persist: {
      export: (saveMedia: (m: MediaItem) => unknown) => ({
        conversations,
        messages: messages.map((m) => ({ ...m, media: m.media.map(saveMedia) })),
        blocks: [...blocks],
        reports,
        seq,
      }),
      import: (s: { conversations: ConversationRecord[]; messages: (Omit<MessageRecord, "media"> & { media: unknown[] })[]; blocks: string[]; reports: ReportRecord[]; seq: number }, loadMedia: (m: never) => MediaItem) => {
        conversations.splice(0, conversations.length, ...s.conversations);
        messages.splice(0, messages.length, ...s.messages.map((m) => ({ ...m, media: m.media.map((x) => loadMedia(x as never)) })));
        blocks.clear();
        s.blocks.forEach((b) => blocks.add(b));
        reports.splice(0, reports.length, ...s.reports);
        seq = s.seq;
      },
    },
  };
}
