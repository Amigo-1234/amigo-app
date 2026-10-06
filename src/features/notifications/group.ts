import type { AppNotification, Author, NotificationKind, NotificationPost } from "../../data";

/** Likes on the same post, or new followers, within this window share one row. */
export const GROUP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * One row in the list. Backends keep every event; grouping only decides how
 * they are shown, so `items` always holds the individual notifications.
 */
export interface NotificationGroup {
  key: string;
  kind: NotificationKind;
  items: AppNotification[];
  /** Distinct actors, newest first. */
  actors: Author[];
  post: NotificationPost | null;
  latestAt: Date;
  unread: boolean;
  inReplyToReply: boolean;
}

const groupable = (n: AppNotification) => n.kind === "like" || n.kind === "follow";

/** items must be newest first (as backends return them). */
export function groupNotifications(items: AppNotification[]): NotificationGroup[] {
  const groups: NotificationGroup[] = [];
  const open = new Map<string, NotificationGroup>();
  for (const n of items) {
    const key = groupable(n) ? `${n.kind}:${n.post?.id ?? ""}` : null;
    const existing = key ? open.get(key) : undefined;
    if (existing && existing.latestAt.getTime() - n.createdAt.getTime() <= GROUP_WINDOW_MS) {
      existing.items.push(n);
      if (!existing.actors.some((a) => a.id === n.actor.id)) existing.actors.push(n.actor);
      existing.unread ||= !n.read;
      continue;
    }
    const group: NotificationGroup = {
      key: key ? `${key}:${n.id}` : n.id,
      kind: n.kind,
      items: [n],
      actors: [n.actor],
      post: n.post,
      latestAt: n.createdAt,
      unread: !n.read,
      inReplyToReply: Boolean(n.inReplyToReply),
    };
    groups.push(group);
    if (key) open.set(key, group);
  }
  return groups;
}

/** "Mira Iyer", "Mira Iyer and Leo Park", "Mira Iyer and 4 others". */
export function actorNames(actors: Author[]): { first: string; second?: string; others: number } {
  if (actors.length === 2) return { first: actors[0].name, second: actors[1].name, others: 0 };
  return { first: actors[0]?.name ?? "Someone", others: Math.max(actors.length - 1, 0) };
}

export function actionText(g: Pick<NotificationGroup, "kind" | "inReplyToReply">): string {
  switch (g.kind) {
    case "like":
      return "liked your post";
    case "follow":
      return "followed you";
    case "reply":
      return g.inReplyToReply ? "replied to your reply" : "replied to your post";
    case "mention":
      return "mentioned you";
  }
}

/** Plain-text sentence for screen readers and tests. */
export function describeGroup(g: NotificationGroup): string {
  const { first, second, others } = actorNames(g.actors);
  const who = second ? `${first} and ${second}` : others ? `${first} and ${others} ${others === 1 ? "other" : "others"}` : first;
  return `${who} ${actionText(g)}`;
}

/** Where tapping a row goes. */
export function groupHref(g: NotificationGroup, viewerHandle: string): string {
  if (g.kind === "follow") return g.actors.length === 1 ? `/u/${g.actors[0].handle}` : `/u/${viewerHandle}/followers`;
  return g.post ? `/post/${g.post.id}` : "/notifications";
}
