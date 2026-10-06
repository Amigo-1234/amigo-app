/**
 * Every Supabase query the app makes, as plain functions of a client.
 * supabaseSource.ts wires them to the app's singleton client; the API tests
 * (scripts/test/supabase-api.test.ts) run the very same functions against a
 * local PostgREST.
 */
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { ProfileError, type AppNotification, type NotificationPage, type ExploreFeed, type PostSearchOrder, type FeedScope, type FollowListKind, type MediaItem, type PersonSummary, type Post, type Profile, type ProfileTab, type Reply } from "../types";
import type { Database, Json } from "./database.types";

export type Db = SupabaseClient<Database>;

type ProfileRow = Pick<Database["public"]["Tables"]["profiles"]["Row"], "id" | "username" | "display_name" | "avatar_url">;
type MediaRow = Pick<Database["public"]["Tables"]["post_media"]["Row"], "kind" | "bucket" | "storage_path" | "width" | "height" | "alt" | "position">;
export type PostRow = {
  id: string;
  body: string;
  created_at: string;
  like_count: number;
  reply_count: number;
  parent_id: string | null;
  author: ProfileRow | null;
  media: MediaRow[];
  parent?: { id: string; author: { username: string } | null } | null;
};

export const POST_SELECT =
  "id, body, created_at, like_count, reply_count, parent_id, " +
  "author:profiles!posts_author_id_fkey(id, username, display_name, avatar_url), " +
  "media:post_media(kind, bucket, storage_path, width, height, alt, position)";

// ------------------------------------------------------------------ mapping

export function toAuthor(p: ProfileRow | null) {
  return p
    ? { id: p.id, name: p.display_name, handle: p.username, avatarUrl: p.avatar_url }
    : { id: "unknown", name: "Amigo", handle: "amigo", avatarUrl: null };
}

function toMedia(db: Db, rows: MediaRow[]): MediaItem[] {
  return [...rows]
    .sort((a, b) => a.position - b.position)
    .map((m) => ({
      type: m.kind,
      url: db.storage.from(m.bucket).getPublicUrl(m.storage_path).data.publicUrl,
      width: m.width ?? undefined,
      height: m.height ?? undefined,
      alt: m.alt ?? undefined,
    }));
}

export function toPost(db: Db, row: PostRow, liked: Set<string>): Post {
  return {
    replyTo: row.parent?.author ? { postId: row.parent.id, handle: row.parent.author.username } : null,
    id: row.id,
    author: toAuthor(row.author),
    text: row.body,
    media: toMedia(db, row.media ?? []),
    createdAt: new Date(row.created_at),
    likeCount: row.like_count,
    likedByViewer: liked.has(row.id),
    replyCount: row.reply_count,
  };
}

/** Normalise PostgREST/network failures into codes the UI understands. */
export function dataError(e: PostgrestError | Error | null | undefined): Error {
  const message = e?.message ?? "Unknown error";
  const pgCode = (e as PostgrestError | undefined)?.code ?? "";
  let code = "unknown";
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  if (offline || /Failed to fetch|NetworkError|Load failed|fetch failed/i.test(message)) code = "unavailable";
  else if (pgCode === "42501" || pgCode === "PGRST301") code = "permission-denied";
  return Object.assign(new Error(message), { code, pgCode });
}

// -------------------------------------------------------------------- reads

export async function likedSet(db: Db, viewerId: string | null, postIds: string[]): Promise<Set<string>> {
  if (!viewerId || postIds.length === 0) return new Set();
  const { data, error } = await db.from("post_likes").select("post_id").eq("user_id", viewerId).in("post_id", postIds);
  if (error) throw dataError(error);
  return new Set(data.map((r) => r.post_id));
}

export async function fetchFeed(db: Db, scope: FeedScope, limit: number, viewerId: string | null) {
  const { data, error } = await db.rpc("feed_posts", { p_scope: scope, p_limit: limit + 1 }).select(POST_SELECT).returns<PostRow[]>();
  if (error) throw dataError(error);
  const rows = data.slice(0, limit);
  const liked = await likedSet(db, viewerId, rows.map((r) => r.id));
  return { posts: rows.map((r) => toPost(db, r, liked)), hasMore: data.length > limit };
}

export async function fetchPost(db: Db, postId: string, viewerId: string | null): Promise<Post | null> {
  const { data, error } = await db.from("posts").select(POST_SELECT).eq("id", postId).maybeSingle().returns<PostRow | null>();
  if (error) throw dataError(error);
  if (!data) return null;
  await attachParents(db, [data]);
  return toPost(db, data, await likedSet(db, viewerId, [data.id]));
}

export async function fetchReplies(db: Db, postId: string): Promise<Reply[]> {
  const { data, error } = await db
    .from("posts")
    .select(POST_SELECT)
    .eq("parent_id", postId)
    .order("created_at", { ascending: true })
    .limit(500)
    .returns<PostRow[]>();
  if (error) throw dataError(error);
  return data.map((r) => ({ id: r.id, postId, author: toAuthor(r.author), text: r.body, createdAt: new Date(r.created_at) }));
}

export async function fetchProfile(db: Db, userId: string) {
  const { data, error } = await db.from("profiles").select("id, username, display_name, avatar_url").eq("id", userId).maybeSingle();
  if (error) throw dataError(error);
  return data;
}

export async function fetchFollowingIds(db: Db, viewerId: string) {
  const { data, error } = await db.from("follows").select("followee_id").eq("follower_id", viewerId);
  if (error) throw dataError(error);
  return new Set(data.map((r) => r.followee_id));
}

export async function fetchSuggestions(db: Db, max: number): Promise<PersonSummary[]> {
  const { data, error } = await db.rpc("suggested_profiles", { p_limit: max });
  if (error) throw dataError(error);
  return data.map((p) => ({ id: p.id, name: p.display_name, handle: p.username, avatarUrl: p.avatar_url, viewerFollows: false }));
}

// ------------------------------------------------------------------- writes

export type NewMedia = { kind: "image" | "video"; storage_path: string; mime_type: string; width?: number; height?: number; byte_size?: number };

export async function createPost(db: Db, body: string, opts: { parentId?: string; media?: NewMedia[] } = {}) {
  const { data, error } = await db.rpc("create_post", {
    p_body: body,
    p_parent_id: opts.parentId,
    p_media: (opts.media ?? []) as unknown as Json,
  });
  if (error) throw dataError(error);
  return data;
}

export async function setLike(db: Db, postId: string, liked: boolean) {
  const { error } = await db.rpc("set_post_like", { p_post_id: postId, p_liked: liked });
  if (error) throw dataError(error);
}

export async function follow(db: Db, viewerId: string, targetId: string) {
  const { error } = await db.from("follows").insert({ follower_id: viewerId, followee_id: targetId });
  if (error && error.code !== "23505") throw dataError(error); // already following is fine
}

export async function unfollow(db: Db, viewerId: string, targetId: string) {
  const { error } = await db.from("follows").delete().eq("follower_id", viewerId).eq("followee_id", targetId);
  if (error) throw dataError(error);
}

export async function updateDisplayName(db: Db, userId: string, name: string) {
  const { error } = await db.from("profiles").update({ display_name: name.trim() }).eq("id", userId);
  if (error) throw dataError(error);
}

// ----------------------------------------------------------------- profiles

const PROFILE_COLUMNS = "id, username, display_name, bio, avatar_url, follower_count, following_count, post_count, created_at";
// Media tab: only posts that have at least one media row.
const MEDIA_SELECT = POST_SELECT.replace("media:post_media(", "media:post_media!inner(");

async function viewerFollowsSet(db: Db, viewerId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { data, error } = await db.from("follows").select("followee_id").eq("follower_id", viewerId).in("followee_id", ids);
  if (error) throw dataError(error);
  return new Set(data.map((r) => r.followee_id));
}

export async function fetchProfileByHandle(db: Db, handle: string, viewerId: string): Promise<Profile | null> {
  const { data, error } = await db.from("profiles").select(PROFILE_COLUMNS).eq("username", handle.toLowerCase()).maybeSingle();
  if (error) throw dataError(error);
  if (!data) return null;
  const following = data.id === viewerId ? new Set<string>() : await viewerFollowsSet(db, viewerId, [data.id]);
  return {
    id: data.id,
    name: data.display_name,
    handle: data.username,
    bio: data.bio,
    avatarUrl: data.avatar_url,
    followerCount: data.follower_count,
    followingCount: data.following_count,
    postCount: data.post_count,
    joinedAt: new Date(data.created_at),
    viewerFollows: following.has(data.id),
    isViewer: data.id === viewerId,
  };
}

export async function fetchProfilePosts(db: Db, profileId: string, viewerId: string, tab: ProfileTab, limit: number) {
  const select = tab === "media" ? MEDIA_SELECT : POST_SELECT;
  let query = db.from("posts").select(select).eq("author_id", profileId);
  if (tab === "posts") query = query.is("parent_id", null);
  if (tab === "replies") query = query.not("parent_id", "is", null);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(limit + 1).returns<PostRow[]>();
  if (error) throw dataError(error);
  const rows = data.slice(0, limit);
  if (tab === "replies") await attachParents(db, rows);
  const liked = await likedSet(db, viewerId, rows.map((r) => r.id));
  return { posts: rows.map((r) => toPost(db, r, liked)), hasMore: data.length > limit };
}

/**
 * "Replying to @x": PostgREST can't embed a table's self-reference without a
 * computed relationship, so parents are fetched in one extra query. Parents
 * the viewer can't see (deleted, followers-only) simply stay unlabelled.
 */
async function attachParents(db: Db, rows: PostRow[]) {
  const ids = [...new Set(rows.map((r) => r.parent_id).filter((x): x is string => !!x))];
  if (ids.length === 0) return;
  const { data, error } = await db
    .from("posts")
    .select("id, author:profiles!posts_author_id_fkey(username)")
    .in("id", ids)
    .returns<{ id: string; author: { username: string } | null }[]>();
  if (error) throw dataError(error);
  const byId = new Map(data.map((p) => [p.id, p]));
  for (const r of rows) r.parent = r.parent_id ? byId.get(r.parent_id) ?? null : null;
}

export async function fetchFollowList(db: Db, profileId: string, kind: FollowListKind, viewerId: string): Promise<PersonSummary[]> {
  const select =
    kind === "followers"
      ? "created_at, person:profiles!follows_follower_id_fkey(id, username, display_name, avatar_url)"
      : "created_at, person:profiles!follows_followee_id_fkey(id, username, display_name, avatar_url)";
  const { data, error } = await db
    .from("follows")
    .select(select)
    .eq(kind === "followers" ? "followee_id" : "follower_id", profileId)
    .order("created_at", { ascending: false })
    .limit(500)
    .returns<{ person: ProfileRow | null }[]>();
  if (error) throw dataError(error);
  const people = data.map((r) => r.person).filter((p): p is ProfileRow => !!p);
  const following = await viewerFollowsSet(db, viewerId, people.map((p) => p.id));
  return people.map((p) => ({ id: p.id, name: p.display_name, handle: p.username, avatarUrl: p.avatar_url, viewerFollows: following.has(p.id) }));
}

export async function isHandleAvailable(db: Db, handle: string, viewerId: string) {
  const { data, error } = await db.from("profiles").select("id").eq("username", handle.toLowerCase()).limit(1);
  if (error) throw dataError(error);
  return data.length === 0 || data[0].id === viewerId;
}

export async function updateProfileRow(
  db: Db,
  userId: string,
  patch: { display_name?: string; username?: string; bio?: string; avatar_url?: string | null },
) {
  if (Object.keys(patch).length === 0) return;
  const { error } = await db.from("profiles").update(patch).eq("id", userId);
  if (!error) return;
  if (error.code === "23505") throw new ProfileError("handle-taken");
  // Only the username format constraint means "invalid username"; other checks (bio/name length) are generic.
  if (error.code === "23514" && /profiles_username_format/.test(error.message)) throw new ProfileError("handle-invalid", error.message);
  throw new ProfileError("unknown", error.message);
}

// ---------------------------------------------------------------- discovery
//
// Case-insensitive substring search via ILIKE. Fine at today's size; see
// docs/architecture/SEARCH.md for the indexes/full-text search to add before
// it gets big. No schema changes are needed for this version.

/** Escape LIKE wildcards in user input so "%" or "_" match literally. */
export function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Quote a value for a PostgREST or=() filter (commas/parentheses would otherwise split it). */
function orValue(value: string): string {
  return `"${value.replace(/["\\]/g, (c) => `\\${c}`)}"`;
}

export async function searchPeople(db: Db, query: string, viewerId: string, limit: number) {
  const q = query.trim().replace(/^@/, "").toLowerCase();
  if (!q) return [];
  const pattern = orValue(likePattern(q));
  const { data, error } = await db
    .from("profiles")
    .select("id, username, display_name, avatar_url, bio, follower_count")
    .or(`username.ilike.${pattern},display_name.ilike.${pattern}`)
    .order("follower_count", { ascending: false })
    .limit(Math.min(limit * 3, 100));
  if (error) throw dataError(error);
  // Usernames that start with the query rank first (people usually type the start of a handle).
  const ranked = [...data].sort((a, b) => Number(b.username.startsWith(q)) - Number(a.username.startsWith(q))).slice(0, limit);
  const following = await viewerFollowsSet(db, viewerId, ranked.map((p) => p.id));
  return ranked.map((p) => ({
    id: p.id, name: p.display_name, handle: p.username, avatarUrl: p.avatar_url, bio: p.bio, viewerFollows: following.has(p.id),
  }));
}

export async function searchPosts(
  db: Db,
  query: string,
  viewerId: string,
  opts: { order: PostSearchOrder; mediaOnly?: boolean; limit: number },
) {
  const q = query.trim();
  if (!q) return { posts: [], hasMore: false };
  let req = db.from("posts").select(opts.mediaOnly ? MEDIA_SELECT : POST_SELECT).ilike("body", likePattern(q));
  if (opts.order === "top") req = req.order("like_count", { ascending: false });
  const { data, error } = await req.order("created_at", { ascending: false }).limit(opts.limit + 1).returns<PostRow[]>();
  if (error) throw dataError(error);
  const rows = data.slice(0, opts.limit);
  await attachParents(db, rows);
  const liked = await likedSet(db, viewerId, rows.map((r) => r.id));
  return { posts: rows.map((r) => toPost(db, r, liked)), hasMore: data.length > opts.limit };
}

const POPULAR_WINDOW_DAYS = 7;

export async function fetchExplore(db: Db, viewerId: string): Promise<ExploreFeed> {
  const since = new Date(Date.now() - POPULAR_WINDOW_DAYS * 86_400_000).toISOString();
  const topLevel = () => db.from("posts").select(POST_SELECT).is("parent_id", null);

  const [people, recentPopular, conversations, media] = await Promise.all([
    db.rpc("suggested_profiles", { p_limit: 4 }),
    topLevel().gte("created_at", since).order("like_count", { ascending: false }).order("created_at", { ascending: false }).limit(3).returns<PostRow[]>(),
    topLevel().gt("reply_count", 0).order("created_at", { ascending: false }).limit(3).returns<PostRow[]>(),
    db.from("posts").select(MEDIA_SELECT).is("parent_id", null).order("created_at", { ascending: false }).limit(9).returns<PostRow[]>(),
  ]);
  for (const r of [people, recentPopular, conversations, media]) if (r.error) throw dataError(r.error);

  // Nothing posted this week: fall back to all-time, and say so (windowDays: null).
  let popularRows = recentPopular.data!;
  let windowDays: number | null = POPULAR_WINDOW_DAYS;
  if (popularRows.length === 0) {
    const allTime = await topLevel().order("like_count", { ascending: false }).order("created_at", { ascending: false }).limit(3).returns<PostRow[]>();
    if (allTime.error) throw dataError(allTime.error);
    popularRows = allTime.data;
    windowDays = null;
  }

  const allRows = [...popularRows, ...conversations.data!, ...media.data!];
  const liked = await likedSet(db, viewerId, [...new Set(allRows.map((r) => r.id))]);
  const map = (rows: PostRow[]) => rows.map((r) => toPost(db, r, liked));
  return {
    suggestedPeople: people.data!.map((p) => ({
      id: p.id, name: p.display_name, handle: p.username, avatarUrl: p.avatar_url, bio: p.bio, viewerFollows: false,
    })),
    popular: { posts: map(popularRows), windowDays },
    conversations: map(conversations.data!),
    media: map(media.data!),
  };
}

// ------------------------------------------------------------ notifications
//
// Rows are written only by database triggers. RLS returns the viewer's own
// notifications, and only those still true (see 20261006150000_notifications.sql),
// so no extra filtering is needed here.

type NotificationRow = {
  id: string;
  kind: AppNotification["kind"];
  created_at: string;
  read_at: string | null;
  actor: ProfileRow | null;
  post: { id: string; body: string; parent_id: string | null; media: MediaRow[] } | null;
};

const NOTIFICATION_SELECT =
  "id, kind, created_at, read_at, " +
  "actor:profiles!notifications_actor_id_fkey(id, username, display_name, avatar_url), " +
  "post:posts!notifications_post_id_fkey(id, body, parent_id, media:post_media(kind, bucket, storage_path, width, height, alt, position))";

export async function fetchNotifications(db: Db, limit: number): Promise<NotificationPage> {
  const { data, error } = await db
    .from("notifications")
    .select(NOTIFICATION_SELECT)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1)
    .returns<NotificationRow[]>();
  if (error) throw dataError(error);
  const rows = data.slice(0, limit);

  // "Replied to your reply" vs "to your post": is the replied-to post itself a reply?
  const parentIds = [...new Set(rows.flatMap((r) => (r.kind === "reply" && r.post?.parent_id ? [r.post.parent_id] : [])))];
  const parentIsReply = new Set<string>();
  if (parentIds.length) {
    const parents = await db.from("posts").select("id, parent_id").in("id", parentIds);
    if (parents.error) throw dataError(parents.error);
    for (const p of parents.data) if (p.parent_id) parentIsReply.add(p.id);
  }

  return {
    items: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      actor: toAuthor(r.actor),
      createdAt: new Date(r.created_at),
      read: r.read_at !== null,
      post: r.post ? { id: r.post.id, text: r.post.body, media: toMedia(db, r.post.media ?? []) } : null,
      inReplyToReply: r.kind === "reply" ? parentIsReply.has(r.post?.parent_id ?? "") : undefined,
    })),
    hasMore: data.length > limit,
  };
}

export async function fetchUnreadCount(db: Db): Promise<number> {
  const { data, error } = await db.rpc("unread_notification_count");
  if (error) throw dataError(error);
  return data;
}

/** ids: the notifications to mark read; omit for all of them. */
export async function markNotificationsRead(db: Db, ids?: string[]) {
  if (ids && ids.length === 0) return;
  const { error } = await db.rpc("mark_notifications_read", ids ? { p_ids: ids } : {});
  if (error) throw dataError(error);
}
