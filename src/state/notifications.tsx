import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { dataSource } from "../data";
import { useViewer } from "./session";

/** Notifications are an optional backend capability (not on the legacy Firebase source). */
export const notificationsEnabled = !!dataSource.notifications;

interface UnreadState {
  /** null until the first count arrives, or when the count couldn't load (badges hide rather than guess). */
  unread: number | null;
  markRead: (ids: string[], unreadAmongThem: number) => Promise<void>;
  markAllRead: () => Promise<void>;
}

const UnreadContext = createContext<UnreadState>({ unread: null, markRead: async () => {}, markAllRead: async () => {} });

/**
 * One live unread count for the whole signed-in app, so every badge agrees and
 * updates without a reload. Marking read lowers the count immediately; the
 * backend's next value replaces it.
 */
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const viewer = useViewer();
  const api = dataSource.notifications;
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

  const markRead = useCallback(
    async (ids: string[], unreadAmongThem: number) => {
      if (!api || ids.length === 0 || unreadAmongThem === 0) return;
      setUnread((c) => (c === null ? c : Math.max(c - unreadAmongThem, 0)));
      await api.markRead(viewer.id, ids);
    },
    [api, viewer.id],
  );

  const markAllRead = useCallback(async () => {
    if (!api) return;
    setUnread((c) => (c === null ? c : 0));
    await api.markAllRead(viewer.id);
  }, [api, viewer.id]);

  const value = useMemo(() => ({ unread, markRead, markAllRead }), [unread, markRead, markAllRead]);
  return <UnreadContext.Provider value={value}>{children}</UnreadContext.Provider>;
}

export const useUnread = () => useContext(UnreadContext);

/** "Notifications, 3 unread" — badges are never the only signal. */
export function notificationsLabel(unread: number | null): string {
  return unread ? `Notifications, ${unread} unread` : "Notifications";
}

/** What a badge shows: nothing at 0, "99+" past 99. */
export function badgeText(unread: number | null): string | null {
  if (!unread) return null;
  return unread > 99 ? "99+" : String(unread);
}
