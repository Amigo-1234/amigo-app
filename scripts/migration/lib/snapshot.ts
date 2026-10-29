/**
 * A Snapshot is a read-only, point-in-time copy of everything in the legacy
 * Firebase project that the migration cares about. Extraction writes it once;
 * every later step (transform, load, validate) works from this file, so the
 * migration is repeatable and never touches Firebase again.
 *
 * Values are plain JSON. Firestore timestamps become { "__ts": ISO-8601 }.
 * The file contains personal data (emails) — it lives in migration-data/,
 * which is git-ignored. Never commit it.
 */
export type Plain = null | boolean | number | string | Plain[] | { [k: string]: Plain };

export interface RawDoc {
  id: string;
  /** Full Firestore path, e.g. "posts/abc/comments/xyz". */
  path: string;
  data: Record<string, Plain>;
  /** True for "phantom" parents that only exist because they have subcollections. */
  missing?: boolean;
}

export interface AuthUserRecord {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  photoURL: string | null;
  disabled: boolean;
  providers: string[];
  createdAt: string | null;
  lastSignInAt: string | null;
}

export interface Snapshot {
  meta: {
    projectId: string;
    extractedAt: string;
    source: "admin" | "rest";
    /** Auth users are only available with Admin SDK credentials. */
    hasAuthUsers: boolean;
    notes: string[];
  };
  authUsers: AuthUserRecord[] | null;
  users: RawDoc[];
  following: RawDoc[]; // users/{uid}/following/{targetUid}
  followers: RawDoc[]; // users/{uid}/followers/{followerUid}
  posts: RawDoc[];
  comments: RawDoc[]; // posts/{postId}/comments/{id}
  globalChat: RawDoc[];
}

export function isTs(v: unknown): v is { __ts: string } {
  return !!v && typeof v === "object" && typeof (v as { __ts?: unknown }).__ts === "string";
}

/** Parent document id at a given depth: parentId("users/u1/following/u2") === "u1". */
export function parentId(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 3];
}
