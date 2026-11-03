/**
 * Adapters for the Firestore schema written by the original prototype.
 * The prototype's documents remain valid; nothing here rewrites them.
 *
 * posts/{id}
 *   text, category?, authorId, authorName, createdAt,
 *   reactions: { heart, lol, wow, cry, fire }   // counters
 *   reacted:   { heart: uid[], ... }            // who reacted
 *   commentsCount, imageDataUrl | null
 *   imageWidth?, imageHeight?                   // added by the new composer
 * posts/{id}/comments/{id}
 *   text, authorId, authorName, createdAt
 * Earlier prototype iterations left other shapes in production, all still read:
 *   userId|uid (author id), displayName|name (author name), image|imageUrl,
 *   commentCount, likes (number | uid[]), avatar (pravatar index — ignored)
 * users/{uid}
 *   displayName, email?, avatarUrl, updatedAt (+ mood/xp/streak on old docs)
 * users/{uid}/following/{targetUid}, users/{uid}/followers/{uid}
 */
import type { Author, MediaItem, Post, Reply } from "./types";
import { toHandle } from "../lib/handle";

type Timestampish = { toDate?: () => Date } | null | undefined;

export interface LegacyPostDoc {
  text?: string;
  authorId?: string;
  userId?: string;
  uid?: string;
  authorName?: string;
  displayName?: string;
  name?: string;
  authorAvatarUrl?: string | null;
  commentCount?: number;
  likes?: number | string[];
  image?: string | null;
  imageUrl?: string | null;
  createdAt?: Timestampish;
  reactions?: Record<string, number>;
  reacted?: Record<string, string[]>;
  commentsCount?: number;
  imageDataUrl?: string | null;
  imageWidth?: number;
  imageHeight?: number;
}

export interface LegacyCommentDoc {
  text?: string;
  authorId?: string;
  authorName?: string;
  createdAt?: Timestampish;
}

/** In the prototype, the ❤️ reaction is the like. */
export const LIKE_REACTION = "heart";

export const EMPTY_REACTIONS = { heart: 0, lol: 0, wow: 0, cry: 0, fire: 0 };

function toDate(ts: Timestampish): Date | null {
  return ts?.toDate?.() ?? null;
}

function toAuthor(id: string | undefined, name: string | undefined, avatarUrl?: string | null): Author {
  const display = name?.trim() || "Amigo";
  return { id: id ?? "unknown", name: display, handle: toHandle(display), avatarUrl: avatarUrl ?? null };
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function imageUrlOf(d: LegacyPostDoc): string | undefined {
  const url = str(d.imageDataUrl) ?? str(d.imageUrl) ?? str(d.image);
  return url && /^(https:|data:image\/)/.test(url) ? url : undefined;
}

export function postFromLegacy(id: string, d: LegacyPostDoc, viewerId: string | null): Post {
  const media: MediaItem[] = [];
  const url = imageUrlOf(d);
  if (url) media.push({ type: "image", url, width: num(d.imageWidth), height: num(d.imageHeight) });

  const likers = Array.isArray(d.reacted?.[LIKE_REACTION]) ? d.reacted[LIKE_REACTION] : [];
  const oldLikers = Array.isArray(d.likes) ? d.likes : [];
  const likeCount = num(d.reactions?.[LIKE_REACTION]) ?? num(d.likes) ?? oldLikers.length;

  return {
    id,
    author: toAuthor(str(d.authorId) ?? str(d.userId) ?? str(d.uid), str(d.authorName) ?? str(d.displayName) ?? str(d.name), str(d.authorAvatarUrl)),
    text: typeof d.text === "string" ? d.text : "",
    media,
    createdAt: toDate(d.createdAt),
    likeCount: Math.max(0, likeCount),
    likedByViewer: viewerId ? likers.includes(viewerId) || oldLikers.includes(viewerId) : false,
    replyCount: Math.max(0, num(d.commentsCount) ?? num(d.commentCount) ?? 0),
  };
}

export function replyFromLegacy(postId: string, id: string, d: LegacyCommentDoc): Reply {
  return {
    id,
    postId,
    author: toAuthor(d.authorId, d.authorName),
    text: typeof d.text === "string" ? d.text : "",
    createdAt: toDate(d.createdAt),
  };
}
