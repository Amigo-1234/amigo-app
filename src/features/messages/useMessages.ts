import { useCallback, useEffect, useRef, useState } from "react";
import { dataSource, type Conversation, type ConversationView, type DirectMessage, type NewMessageInput } from "../../data";
import { useViewer } from "../../state/session";

type Status = "loading" | "ready" | "error";

export function useConversations() {
  const viewer = useViewer();
  const api = dataSource.messages;
  const [items, setItems] = useState<Conversation[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<Error | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    if (!api) return;
    setStatus("loading");
    return api.subscribeConversations(viewer.id, {
      onData: (list) => {
        setItems(list);
        setStatus("ready");
        setError(null);
      },
      onError: (e) => {
        console.error(e);
        setError(e);
        setStatus("error");
      },
    });
  }, [api, viewer.id, retryKey]);

  return { items, status, error, retry: () => setRetryKey((k) => k + 1) };
}

/** A message of yours that is still on its way (or failed); shown until the backend has it. */
export interface PendingMessage {
  localId: string;
  input: NewMessageInput;
  /** Local preview of an attached image. */
  previewUrl: string | null;
  createdAt: Date;
  failed: boolean;
}

export function useConversation(conversationId: string) {
  const viewer = useViewer();
  const api = dataSource.messages!;
  const [view, setView] = useState<ConversationView | null>(null);
  const [status, setStatus] = useState<Status | "missing">("loading");
  const [error, setError] = useState<Error | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [peerTyping, setPeerTyping] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    setStatus("loading");
    setView(null);
    setPending([]);
    return api.subscribeConversation(conversationId, viewer.id, {
      onData: (v) => {
        setView(v);
        setStatus(v ? "ready" : "missing");
        setError(null);
      },
      onError: (e) => {
        console.error(e);
        setError(e);
        setStatus("error");
      },
    });
  }, [api, conversationId, viewer.id, retryKey]);

  useEffect(() => api.subscribeTyping(conversationId, viewer.id, setPeerTyping), [api, conversationId, viewer.id]);

  // Opening a conversation (or a new message arriving while it's open and visible) marks it read.
  const unread = view?.conversation.unreadCount ?? 0;
  useEffect(() => {
    if (!unread) return;
    const mark = () => document.visibilityState === "visible" && api.markRead(viewer.id, conversationId).catch(console.error);
    mark();
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [api, conversationId, viewer.id, unread]);

  const deliver = useCallback(
    async (p: PendingMessage) => {
      try {
        await api.send(viewer.id, conversationId, p.input);
        setPending((list) => list.filter((x) => x.localId !== p.localId));
        if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
        return null;
      } catch (e) {
        setPending((list) => list.map((x) => (x.localId === p.localId ? { ...x, failed: true } : x)));
        return e as Error;
      }
    },
    [api, viewer.id, conversationId],
  );

  const send = useCallback(
    (input: NewMessageInput) => {
      const p: PendingMessage = {
        localId: `local-${seq.current++}`,
        input,
        previewUrl: input.image ? URL.createObjectURL(input.image.blob) : null,
        createdAt: new Date(),
        failed: false,
      };
      setPending((list) => [...list, p]);
      return deliver(p);
    },
    [deliver],
  );

  const retrySend = useCallback(
    (localId: string) => {
      const p = pending.find((x) => x.localId === localId);
      if (!p) return Promise.resolve(null);
      setPending((list) => list.map((x) => (x.localId === localId ? { ...x, failed: false } : x)));
      return deliver({ ...p, failed: false });
    },
    [pending, deliver],
  );

  const discard = useCallback((localId: string) => {
    setPending((list) => list.filter((x) => x.localId !== localId));
  }, []);

  return {
    view,
    messages: view?.messages ?? ([] as DirectMessage[]),
    status,
    error,
    pending,
    peerTyping,
    send,
    retrySend,
    discard,
    retry: () => setRetryKey((k) => k + 1),
  };
}
