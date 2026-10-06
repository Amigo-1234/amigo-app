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

export type MediaItem = {
  type: "image" | "video";
  url: string;
  width?: number;
  height?: number;
  alt?: string;
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
}

export interface NewPostInput {
  text: string;
  image?: { dataUrl: string; width: number; height: number } | null;
}

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

export interface Subscription<T> {
  onData: (value: T) => void;
  onError: (error: Error) => void;
}

/** Everything the UI needs from a backend. Implemented by Firebase and demo sources. */
export interface DataSource {
  kind: "firebase" | "supabase" | "demo";

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
  createPost(viewer: Viewer, input: NewPostInput): Promise<void>;
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
