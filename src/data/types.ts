/**
 * Normalized client models. Screens only ever see these — never raw
 * Firestore documents — so the storage schema can evolve (Firebase Storage
 * media, reposts, moments…) without touching UI code.
 */

export interface Viewer {
  id: string;
  name: string;
  handle: string;
  email: string | null;
  avatarUrl: string | null;
}

export interface Author {
  id: string;
  name: string;
  handle: string;
  avatarUrl: string | null;
}

/**
 * One attachment on a post. Posts carry an ordered array of these.
 * "video" is modelled now so adding video uploads later doesn't change the post
 * shape (see docs/architecture/MEDIA.md); the composer only creates images today.
 */
export type MediaItem = {
  type: "image" | "video";
  url: string;
  width?: number;
  height?: number;
  alt?: string;
  /** Video only (future): poster image and duration. */
  posterUrl?: string;
  durationMs?: number;
};

export interface Post {
  id: string;
  author: Author;
  text: string;
  media: MediaItem[];
  /** null while the server timestamp is pending (just-created post). */
  createdAt: Date | null;
  likeCount: number;
  likedByViewer: boolean;
  replyCount: number;
  /** Set when this post is a reply (shown on profile "Replies" tabs). */
  replyTo?: { postId: string; handle: string } | null;
}

export interface Reply {
  id: string;
  postId: string;
  author: Author;
  text: string;
  createdAt: Date | null;
}

export interface PersonSummary {
  id: string;
  name: string;
  handle: string;
  avatarUrl: string | null;
  viewerFollows: boolean;
  /** Present where a short bio helps (search results, suggestions). */
  bio?: string;
}

/** A processed image ready to publish (already resized, re-encoded, metadata stripped). */
export interface NewMediaInput {
  kind: "image";
  blob: Blob;
  width: number;
  height: number;
  alt?: string;
}

export interface NewPostInput {
  text: string;
  /** Ordered; the first item is the cover. */
  media: NewMediaInput[];
}

/** Product-wide limits for new posts. */
export const POST_MAX_LENGTH = 500;

export type Unsubscribe = () => void;

export type FeedScope = "latest" | "following";

/** Backend-neutral auth failures, so screens never depend on SDK error strings. */
export type AuthErrorCode =
  | "invalid-credentials"
  | "email-in-use"
  | "weak-password"
  | "invalid-email"
  | "email-not-confirmed"
  | "rate-limited"
  | "network"
  | "unknown";

export class AuthError extends Error {
  code: AuthErrorCode;
  constructor(code: AuthErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

// ----------------------------------------------------------------- profiles

export interface Profile {
  id: string;
  name: string;
  handle: string;
  bio: string;
  avatarUrl: string | null;
  followerCount: number;
  followingCount: number;
  postCount: number;
  joinedAt: Date | null;
  viewerFollows: boolean;
  isViewer: boolean;
}

export type ProfileTab = "posts" | "replies" | "media";
export type FollowListKind = "followers" | "following";

export interface ProfileUpdate {
  name?: string;
  handle?: string;
  bio?: string;
  /** A new picture, or null to remove the current one. Omit to leave it unchanged. */
  avatar?: { dataUrl: string; width: number; height: number } | null;
}

export const HANDLE_PATTERN = /^[a-z0-9_]{3,24}$/;
export const BIO_MAX_LENGTH = 160;
export const NAME_MAX_LENGTH = 50;

export type ProfileErrorCode = "handle-taken" | "handle-invalid" | "unknown";

export class ProfileError extends Error {
  code: ProfileErrorCode;
  constructor(code: ProfileErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

/**
 * Profiles are an optional capability: backends that have real usernames and
 * profile rows (Supabase, demo) provide it; the legacy Firebase source does not,
 * and the UI degrades to plain names without profile links.
 */
export interface ProfilesApi {
  /** Case-insensitive. null when no such person exists. */
  getProfile(handle: string, viewerId: string): Promise<Profile | null>;
  subscribeProfilePosts(
    profileId: string,
    viewerId: string,
    tab: ProfileTab,
    limit: number,
    sub: Subscription<{ posts: Post[]; hasMore: boolean }>,
  ): Unsubscribe;
  listFollows(profileId: string, kind: FollowListKind, viewerId: string): Promise<PersonSummary[]>;
  isHandleAvailable(handle: string, viewerId: string): Promise<boolean>;
  /** Updates the signed-in person's profile; onViewerChanged fires with the new values. */
  updateProfile(viewerId: string, update: ProfileUpdate): Promise<void>;
}

// ---------------------------------------------------------------- discovery

export type SearchTab = "top" | "people" | "posts" | "media";

export interface PostPage {
  posts: Post[];
  hasMore: boolean;
}

/** Everything on the Explore landing page. Every section is derived from real data. */
export interface ExploreFeed {
  suggestedPeople: PersonSummary[];
  /**
   * Most-liked recent posts. windowDays says how far back "recent" reaches:
   * 7 → "Popular this week"; null → no recent activity, so all-time most liked.
   */
  popular: { posts: Post[]; windowDays: number | null };
  /** Newest posts that have replies. */
  conversations: Post[];
  /** Newest posts with images or video. */
  media: Post[];
}

export type PostSearchOrder = "top" | "latest";

/**
 * Search and discovery. Optional capability: demo and Supabase provide it,
 * the legacy Firebase source does not (Explore stays a placeholder there).
 * Matching is case-insensitive substring matching on usernames, display names
 * and post text; backends may rank and index however they like.
 */
export interface DiscoveryApi {
  explore(viewerId: string): Promise<ExploreFeed>;
  searchPeople(query: string, viewerId: string, limit: number): Promise<PersonSummary[]>;
  searchPosts(
    query: string,
    viewerId: string,
    opts: { order: PostSearchOrder; mediaOnly?: boolean; limit: number },
  ): Promise<PostPage>;
}

export interface Subscription<T> {
  onData: (value: T) => void;
  onError: (error: Error) => void;
}

/** Everything the UI needs from a backend. Implemented by Supabase, demo and (legacy) Firebase sources. */
export interface DataSource {
  kind: "firebase" | "supabase" | "demo";

  /**
   * How many media items one new post may carry on this backend.
   * Supabase: 4 (post_media.position 0–3, enforced by create_post). Legacy Firebase: 1.
   */
  maxMediaPerPost: number;

  /** Optional capability — see ProfilesApi. */
  profiles?: ProfilesApi;
  /** Optional capability — see DiscoveryApi. */
  discovery?: DiscoveryApi;

  // auth
  onViewerChanged(cb: (viewer: Viewer | null) => void): Unsubscribe;
  signIn(email: string, password: string): Promise<void>;
  /** needsEmailConfirmation: the account exists but the person must click the emailed link first. */
  signUp(email: string, password: string, name: string): Promise<{ needsEmailConfirmation: boolean }>;
  sendPasswordReset(email: string): Promise<void>;
  /** Fires when someone arrives through a password-reset link and must choose a new password. */
  onPasswordRecovery?(cb: () => void): Unsubscribe;
  updatePassword(newPassword: string): Promise<void>;
  signOut(): Promise<void>;
  updateDisplayName(name: string): Promise<void>;

  // posts
  /** scope is a hint: backends that can filter server-side do; the feed hook filters again regardless. */
  subscribeLatestPosts(viewerId: string | null, limit: number, sub: Subscription<{ posts: Post[]; hasMore: boolean }>, scope?: FeedScope): Unsubscribe;
  subscribePost(postId: string, viewerId: string | null, sub: Subscription<Post | null>): Unsubscribe;
  /** Resolves with the new post's id once it is stored. */
  createPost(viewer: Viewer, input: NewPostInput): Promise<{ id: string }>;
  setLiked(postId: string, viewerId: string, liked: boolean): Promise<void>;

  // replies
  subscribeReplies(postId: string, sub: Subscription<Reply[]>): Unsubscribe;
  addReply(postId: string, viewer: Viewer, text: string): Promise<void>;

  // social graph
  getFollowingIds(viewerId: string): Promise<Set<string>>;
  getPeopleSuggestions(viewerId: string, max: number): Promise<PersonSummary[]>;
  follow(viewerId: string, targetId: string): Promise<void>;
  unfollow(viewerId: string, targetId: string): Promise<void>;
}
