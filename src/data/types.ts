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
  /** Set when the post was made inside a World (shown as a chip linking to it). */
  world?: { slug: string; title: string; entry: boolean } | null;
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
  /** Post inside a World (only on backends with the worlds capability). entry: a competition entry. */
  world?: { id: string; entry: boolean };
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

// ------------------------------------------------------------ notifications

/**
 * What happened. Only kinds the product actually has: reposts, messages,
 * Moments and system notices get their own kinds when those features exist.
 */
export type NotificationKind = "follow" | "like" | "reply" | "mention";

/** The post a notification is about, trimmed to what a preview needs. */
export interface NotificationPost {
  id: string;
  text: string;
  media: MediaItem[];
}

/**
 * One event. Backends store and return individual events; grouping
 * ("Mira and 4 others liked your post") is a presentation concern
 * (src/features/notifications/group.ts), so no event is ever lost.
 */
export interface AppNotification {
  id: string;
  kind: NotificationKind;
  actor: Author;
  createdAt: Date;
  read: boolean;
  /** like: your post. reply: the new reply. mention: the post that mentions you. follow: null. */
  post: NotificationPost | null;
  /** reply only: the reply answers one of your replies rather than a top-level post. */
  inReplyToReply?: boolean;
}

export interface NotificationPage {
  items: AppNotification[];
  hasMore: boolean;
}

/**
 * Notifications. Optional capability: demo and Supabase provide it, the legacy
 * Firebase source does not (the Notifications tab stays a placeholder there).
 * Notifications are created by the backend from real actions, never by the
 * client, and a backend only returns ones that are still true (an undone
 * like or follow, or a deleted post, drops out).
 */
export interface NotificationsApi {
  /** Newest first. Pushes updates when notifications arrive or change. */
  subscribeNotifications(viewerId: string, limit: number, sub: Subscription<NotificationPage>): Unsubscribe;
  /** Live unread count for badges. */
  subscribeUnreadCount(viewerId: string, sub: Subscription<number>): Unsubscribe;
  markRead(viewerId: string, ids: string[]): Promise<void>;
  markAllRead(viewerId: string): Promise<void>;
}

// ------------------------------------------------------------------- worlds

/**
 * Worlds: scheduled live social events, created by Amigo admins only (there is
 * no client API to create or edit one). Status is derived from the times on
 * the client, so a World flips to live or finished without a reload.
 */
export type WorldStatus = "upcoming" | "live" | "finished";

/** Points per thing an entry earns while the World is running. */
export interface WorldScoring {
  /** Per like on your entry (your own like doesn't count). */
  reaction: number;
  /** Per reply to your entry from someone else. */
  reply: number;
  /** Bonus when Amigo picks your entry. 0 = no Amigo picks in this World. */
  hostPick: number;
}

export interface WorldCompetition {
  scoring: WorldScoring;
  /** Entries can be submitted until this time; likes/replies keep counting until the World ends. */
  entriesCloseAt: Date;
  /** How many entries one person may submit. */
  entryLimit: number;
  /** Display-only prize description. No payments or payouts exist. */
  prize: string | null;
}

export interface World {
  id: string;
  slug: string;
  title: string;
  tagline: string;
  description: string;
  coverUrl: string | null;
  startsAt: Date;
  endsAt: Date;
  participantCount: number;
  viewerJoined: boolean;
  /** A few participants to show as faces (people the viewer follows first). */
  participantsPreview: Author[];
  /** null = a social World without points. */
  competition: WorldCompetition | null;
}

export interface LeaderboardEntry {
  rank: number;
  person: Author;
  points: number;
  entries: number;
  viewerFollows: boolean;
}

export interface WorldChatMessage {
  id: string;
  author: Author;
  text: string;
  createdAt: Date;
}

export const WORLD_CHAT_MAX_LENGTH = 300;

export type WorldErrorCode = "not-joined" | "not-live" | "entries-closed" | "entry-limit" | "not-competition" | "unknown";

export class WorldError extends Error {
  code: WorldErrorCode;
  constructor(code: WorldErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

/**
 * Worlds. Optional capability: demo and Supabase provide it, the legacy
 * Firebase source does not (the Worlds nav item is hidden there).
 * Posting into a World goes through DataSource.createPost with input.world.
 */
export interface WorldsApi {
  listWorlds(viewerId: string): Promise<World[]>;
  /** By slug. Live: participant count and join state update. null = no such World. */
  subscribeWorld(slug: string, viewerId: string, sub: Subscription<World | null>): Unsubscribe;
  join(worldId: string, viewerId: string): Promise<void>;
  leave(worldId: string, viewerId: string): Promise<void>;
  /** Posts made in the World, newest first. entriesOnly: competition entries only. */
  subscribeWorldPosts(worldId: string, viewerId: string, opts: { entriesOnly: boolean; limit: number }, sub: Subscription<PostPage>): Unsubscribe;
  /** Ranked by points (ties: earliest first entry wins). Frozen once the World ends. */
  subscribeLeaderboard(worldId: string, viewerId: string, sub: Subscription<LeaderboardEntry[]>): Unsubscribe;
  /** Oldest first, the latest `limit` messages. */
  subscribeChat(worldId: string, limit: number, sub: Subscription<WorldChatMessage[]>): Unsubscribe;
  sendChat(worldId: string, viewer: Viewer, text: string): Promise<void>;
  /** People who joined (excluding the viewer), people the viewer doesn't follow yet first. */
  listParticipants(worldId: string, viewerId: string, limit: number): Promise<PersonSummary[]>;
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
  /** Optional capability — see NotificationsApi. */
  notifications?: NotificationsApi;
  /** Optional capability — see WorldsApi. */
  worlds?: WorldsApi;

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
