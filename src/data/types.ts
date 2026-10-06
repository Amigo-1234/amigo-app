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

export interface Subscription<T> {
  onData: (value: T) => void;
  onError: (error: Error) => void;
}

/** Everything the UI needs from a backend. Implemented by Firebase and demo sources. */
export interface DataSource {
  kind: "firebase" | "demo";

  // auth
  onViewerChanged(cb: (viewer: Viewer | null) => void): Unsubscribe;
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string, name: string): Promise<void>;
  sendPasswordReset(email: string): Promise<void>;
  signOut(): Promise<void>;
  updateDisplayName(name: string): Promise<void>;

  // posts
  subscribeLatestPosts(viewerId: string | null, limit: number, sub: Subscription<{ posts: Post[]; hasMore: boolean }>): Unsubscribe;
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
