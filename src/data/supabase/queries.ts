/**
 * Every Supabase query the app makes, as plain functions of a client.
 * supabaseSource.ts wires them to the app's singleton client; the API tests
 * (scripts/test/supabase-api.test.ts) run the very same functions against a
 * local PostgREST.
 */
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { ProfileError, type FeedScope, type FollowListKind, type MediaItem, type PersonSummary, type Post, type Profile, type ProfileTab, type Reply } from "../types";
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
