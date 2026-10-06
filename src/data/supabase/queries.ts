/**
 * Every Supabase query the app makes, as plain functions of a client.
 * supabaseSource.ts wires them to the app's singleton client; the API tests
 * (scripts/test/supabase-api.test.ts) run the very same functions against a
 * local PostgREST.
 */
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import type { FeedScope, MediaItem, PersonSummary, Post, Reply } from "../types";
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
