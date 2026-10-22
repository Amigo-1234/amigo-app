import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { dataSource } from "../data";
import { useViewer } from "./session";

/** Messages are an optional backend capability (demo and Supabase; not the legacy Firebase source). */
export const messagesEnabled = !!dataSource.messages;

const UnreadMessagesContext = createContext<number | null>(null);

/** One live "conversations with unread messages" count, so every Messages badge agrees. */
export function MessagesProvider({ children }: { children: ReactNode }) {
  const viewer = useViewer();
  const api = dataSource.messages;
  const [unread, setUnread] = useState<number | null>(null);

  useEffect(() => {
    if (!api) return;
    setUnread(null);
    return api.subscribeUnreadCount(viewer.id, {
      onData: setUnread,
      onError: (e) => {
        console.error(e);
        setUnread(null);
      },
    });
  }, [api, viewer.id]);

  return <UnreadMessagesContext.Provider value={unread}>{children}</UnreadMessagesContext.Provider>;
}

export const useUnreadMessages = () => useContext(UnreadMessagesContext);

/** "Messages, 2 unread conversations" — the badge is never the only signal. */
export function messagesLabel(unread: number | null): string {
  if (!unread) return "Messages";
  return `Messages, ${unread} unread conversation${unread === 1 ? "" : "s"}`;
}
