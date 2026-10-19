import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { AtSign, Heart, MessageCircle, Reply, UserPlus, HandHeart, X } from "lucide-react";
import { dataSource, type AppNotification, type Conversation } from "../../data";
import { timeAgo } from "../../lib/time";
import { useUnread } from "../../state/notifications";
import { useUnreadMessages } from "../../state/messages";
import { useViewer } from "../../state/session";
import { Avatar } from "../../ui/Avatar";
import { actionText, groupHref, groupNotifications } from "../notifications/group";
import { alertPrefs, playAlertSound } from "./alertPrefs";
import "./InAppAlerts.css";

interface Banner {
  key: string;
  kind: "message" | AppNotification["kind"];
  who: { id: string; name: string; avatarUrl: string | null };
  title: string;
  text: string;
  at: Date;
  href: string;
}

const SHOW_MS = 5000;
const MAX_QUEUE = 3;
const ICONS = { message: MessageCircle, like: Heart, reply: Reply, follow: UserPlus, mention: AtSign, support: HandHeart } as const;

/** Take one snapshot from a live subscription, then stop listening. */
function once<T>(subscribe: (sub: { onData: (v: T) => void; onError: (e: Error) => void }) => () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let stop: (() => void) | null = null;
    let done = false;
    stop = subscribe({
      onData: (v) => {
        if (done) return;
        done = true;
        queueMicrotask(() => stop?.());
        resolve(v);
      },
      onError: (e) => {
        if (done) return;
        done = true;
        queueMicrotask(() => stop?.());
        reject(e);
      },
    });
    if (done) stop();
  });
}

/**
 * In-app banners for new activity while the app is open (the service worker
 * already skips system notifications when the app is focused, so nothing is
 * shown twice). No extra polling: it watches the unread counts the app already
 * keeps, and only when one goes up does it read the newest items once.
 * Messages: when a conversation becomes unread (the badge counts conversations,
 * so a second message in an already-unread conversation doesn't raise one).
 * Nothing shows for the conversation you're reading. Times are when it
 * happened, so a late arrival says so.
 */
export function InAppAlerts() {
  const viewer = useViewer();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { unread } = useUnread();
  const unreadMessages = useUnreadMessages();
  const [queue, setQueue] = useState<Banner[]>([]);
  const seen = useRef(new Set<string>());
  const since = useRef(Date.now() - 60_000);
  const prevNotif = useRef<number | null>(null);
  const prevMsg = useRef<number | null>(null);
  const path = useRef(pathname);
  path.current = pathname;

  const push = useCallback((items: Banner[]) => {
    const fresh = items.filter((b) => !seen.current.has(b.key));
    if (!fresh.length) return;
    fresh.forEach((b) => seen.current.add(b.key));
    if (document.visibilityState !== "visible") return;
    const prefs = alertPrefs();
    if (prefs.sounds) playAlertSound(fresh.some((b) => b.kind === "message") ? "message" : "social");
    if (!prefs.banners) return;
    setQueue((q) => [...q, ...fresh].slice(-MAX_QUEUE));
  }, []);

  // Social notifications: the unread count went up → read the newest few once.
  useEffect(() => {
    const prev = prevNotif.current;
    prevNotif.current = unread;
    const api = dataSource.notifications;
    if (!api || prev === null || unread === null || unread <= prev) return;
    void once<{ items: AppNotification[] }>((sub) => api.subscribeNotifications(viewer.id, 5, sub)).then(
      (page) => {
        const newest = page.items.filter((n) => !n.read && n.createdAt.getTime() > since.current && n.actor.id !== viewer.id);
        push(
          newest.slice(0, MAX_QUEUE).map((n) => {
            const g = groupNotifications([n])[0];
            return {
              key: `n:${n.id}`,
              kind: n.kind,
              who: { id: n.actor.id, name: n.actor.name, avatarUrl: n.actor.avatarUrl },
              title: `${n.actor.name} ${actionText(g)}`,
              text: n.kind === "follow" ? "" : n.kind === "support" ? (n.request?.title ?? "") : (n.post?.text ?? ""),
              at: n.createdAt,
              href: groupHref(g, viewer.handle),
            };
          }),
        );
      },
      () => undefined,
    );
  }, [unread, viewer.id, viewer.handle, push]);

  // Messages: a conversation became unread → read the inbox once (decrypted on this device only).
  useEffect(() => {
    const prev = prevMsg.current;
    prevMsg.current = unreadMessages;
    const api = dataSource.messages;
    if (!api || prev === null || unreadMessages === null || unreadMessages <= prev) return;
    void once<Conversation[]>((sub) => api.subscribeConversations(viewer.id, sub)).then(
      (convs) => {
        const reading = path.current.startsWith("/messages");
        push(
          convs
            .filter((c) => c.unreadCount > 0 && c.lastMessage && !c.lastMessage.fromViewer && c.lastMessage.createdAt.getTime() > since.current)
            .filter((c) => !(reading && path.current === `/messages/${c.id}`) && !(reading && path.current === "/messages"))
            .slice(0, MAX_QUEUE)
            .map((c) => ({
              key: `m:${c.id}:${c.lastMessage!.createdAt.getTime()}`,
              kind: "message" as const,
              who: { id: c.peer.id, name: c.peer.name, avatarUrl: c.peer.avatarUrl },
              title: c.peer.name,
              text: c.lastMessage!.undecryptable ? "New message" : c.lastMessage!.text || (c.lastMessage!.hasImage ? "📷 Photo" : "New message"),
              at: c.lastMessage!.createdAt,
              href: `/messages/${c.id}`,
            })),
        );
      },
      () => undefined,
    );
  }, [unreadMessages, viewer.id, push]);

  // Leaving for the conversation a banner is about clears it.
  useEffect(() => {
    setQueue((q) => q.filter((b) => b.href !== pathname));
  }, [pathname]);

  const current = queue[0] ?? null;
  const dismiss = useCallback(() => setQueue((q) => q.slice(1)), []);
  useEffect(() => {
    if (!current) return;
    const t = setTimeout(dismiss, SHOW_MS);
    return () => clearTimeout(t);
  }, [current, dismiss]);

  if (!current) return null;
  const Icon = ICONS[current.kind];
  const late = Date.now() - current.at.getTime() > 90_000;
  return (
    <div className="inapp-alerts" aria-live="polite">
      <div key={current.key} className="inapp-banner" role="status">
        <button
          type="button"
          className="inapp-banner__main"
          onClick={() => {
            dismiss();
            navigate(current.href);
          }}
        >
          <span className="inapp-banner__avatar">
            <Avatar name={current.who.name} src={current.who.avatarUrl} seed={current.who.id} size="sm" />
            <span className={`inapp-banner__kind inapp-banner__kind--${current.kind}`} aria-hidden="true">
              <Icon size={11} strokeWidth={2.6} />
            </span>
          </span>
          <span className="inapp-banner__text">
            <span className="inapp-banner__title">
              {current.title}
              {late && <span className="inapp-banner__when"> · {timeAgo(current.at)}</span>}
            </span>
            {current.text && <span className="inapp-banner__body">{current.text}</span>}
          </span>
        </button>
        <button type="button" className="inapp-banner__close" aria-label="Dismiss" onClick={dismiss}>
          <X size={16} aria-hidden="true" />
        </button>
        {queue.length > 1 && <span className="inapp-banner__more">+{queue.length - 1}</span>}
      </div>
    </div>
  );
}
