/**
 * Step 2 — Transform (pure, no I/O).
 *
 * Turns a Snapshot of the legacy Firestore data into a MigrationPlan in the
 * shape of the new schema. Every historical document format seen in
 * production is handled explicitly; anything that can't be migrated is
 * recorded in plan.skipped with a reason instead of being silently dropped.
 */
import { createHash } from "node:crypto";
import { isTs, parentId, type Plain, type RawDoc, type Snapshot } from "./snapshot.ts";

export const BODY_MAX = 2000; // posts.body check constraint
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const LIKE = "heart";

export interface PlannedUser {
  firebaseUid: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  createdAt: string | null;
  /** Where we learned about this uid. */
  seenIn: string[];
  hasAuthRecord: boolean;
  disabled: boolean;
}

export interface PlannedImage {
  sourceKey: string; // "posts/{id}#0"
  mimeType: string;
  /** base64 payload for inline data URLs; null when the image is a remote URL. */
  base64: string | null;
  remoteUrl: string | null;
  sha256: string | null;
  byteSize: number | null;
  width: number | null;
  height: number | null;
}

export interface PlannedPost {
  firebasePath: string;
  kind: "post" | "comment";
  parentFirebasePath: string | null;
  authorUid: string;
  body: string;
  createdAt: string;
  images: PlannedImage[];
  /** uids that liked it (deduplicated). */
  likerUids: string[];
  /** Likes recorded only as a number, with no uid — cannot become rows. */
  unattributedLikes: number;
  rawMeta: Record<string, Plain>;
}

export interface PlannedFollow {
  followerUid: string;
  followeeUid: string;
  createdAt: string | null;
}

export interface Skip {
  kind: "user" | "post" | "comment" | "image" | "like" | "follow" | "chat";
  ref: string;
  reason: string;
}

export interface MigrationPlan {
  users: PlannedUser[];
  posts: PlannedPost[]; // top-level posts first, then comments
  follows: PlannedFollow[];
  reactionArchive: { postPath: string; uid: string; kind: string }[];
  savedArchive: { postPath: string; uid: string }[];
  chatArchive: { id: string; uid: string | null; authorName: string | null; body: string; createdAt: string | null }[];
  skipped: Skip[];
  source: { posts: number; comments: number; userDocs: number; authUsers: number | null; followEdges: number; chat: number; images: number };
}

// ------------------------------------------------------------------ helpers

const str = (v: Plain | undefined): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);
const arr = (v: Plain | undefined): Plain[] => (Array.isArray(v) ? v : []);
const map = (v: Plain | undefined): Record<string, Plain> =>
  v && typeof v === "object" && !Array.isArray(v) && !isTs(v) ? (v as Record<string, Plain>) : {};

/** Firestore Timestamp, or epoch seconds/ms stored as a number by old clients. */
export function toIso(v: Plain | undefined): string | null {
  if (isTs(v)) return v.__ts;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    const ms = v > 1e12 ? v : v * 1000;
    const d = new Date(ms);
    if (d.getUTCFullYear() >= 2015 && d.getUTCFullYear() <= 2100) return d.toISOString();
  }
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return null;
}

const authorUidOf = (d: Record<string, Plain>) => str(d.authorId) ?? str(d.userId) ?? str(d.uid);
const authorNameOf = (d: Record<string, Plain>) => str(d.authorName) ?? str(d.displayName) ?? str(d.name);

/** Width/height from PNG, JPEG, GIF or WebP headers. */
export function imageSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.length > 10 && buf.toString("ascii", 0, 3) === "GIF") return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (buf.length > 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

function sniffMime(buf: Buffer): string | null {
  if (buf.readUInt32BE(0) === 0x89504e47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.toString("ascii", 0, 3) === "GIF") return "image/gif";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

function planImage(sourceKey: string, value: string, skipped: Skip[]): PlannedImage | null {
  if (/^https:\/\//.test(value)) {
    return { sourceKey, mimeType: "", base64: null, remoteUrl: value, sha256: null, byteSize: null, width: null, height: null };
  }
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value);
  if (!m || !m[2]) {
    skipped.push({ kind: "image", ref: sourceKey, reason: "not a base64 data URL or https URL" });
    return null;
  }
  const bytes = Buffer.from(m[3], "base64");
  // Trust the bytes, not the declared type.
  const mimeType = sniffMime(bytes) ?? m[1] ?? "";
  if (!ALLOWED_IMAGE_TYPES.has(mimeType)) {
    skipped.push({ kind: "image", ref: sourceKey, reason: `unsupported image type ${mimeType || "unknown"}` });
    return null;
  }
  const size = imageSize(bytes);
  return {
    sourceKey,
    mimeType,
    base64: m[3],
    remoteUrl: null,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteSize: bytes.length,
    width: size?.width ?? null,
    height: size?.height ?? null,
  };
}

// --------------------------------------------------------------- transform

export function buildPlan(snap: Snapshot): MigrationPlan {
  const skipped: Skip[] = [];
  const users = new Map<string, PlannedUser>();
  const lastSeenName = new Map<string, { name: string; at: string }>();

  const touchUser = (uid: string, why: string) => {
    let u = users.get(uid);
    if (!u) {
      u = { firebaseUid: uid, email: null, emailVerified: false, displayName: null, createdAt: null, seenIn: [], hasAuthRecord: false, disabled: false };
      users.set(uid, u);
    }
    if (!u.seenIn.includes(why)) u.seenIn.push(why);
    return u;
  };
  const noteName = (uid: string, name: string | undefined, at: string | null) => {
    if (!name) return;
    const prev = lastSeenName.get(uid);
    if (!prev || (at ?? "") > prev.at) lastSeenName.set(uid, { name, at: at ?? "" });
  };

  // ---- posts
  const posts: PlannedPost[] = [];
  const reactionArchive: MigrationPlan["reactionArchive"] = [];
  const savedArchive: MigrationPlan["savedArchive"] = [];
  let imageCount = 0;

  for (const doc of snap.posts) {
    const d = doc.data;
    const author = authorUidOf(d);
    const createdAt = toIso(d.createdAt);
    const body = (str(d.text) ?? "").trim();
    const imageValue = str(d.imageDataUrl) ?? str(d.imageUrl) ?? str(d.image);
    if (imageValue) imageCount++;

    if (!author) { skipped.push({ kind: "post", ref: doc.path, reason: "no author id (authorId/userId/uid)" }); continue; }
    if (!createdAt) { skipped.push({ kind: "post", ref: doc.path, reason: "no usable createdAt" }); continue; }
    if (body.length > BODY_MAX) { skipped.push({ kind: "post", ref: doc.path, reason: `text longer than ${BODY_MAX} characters` }); continue; }

    const images: PlannedImage[] = [];
    if (imageValue) {
      const img = planImage(`${doc.path}#0`, imageValue, skipped);
      if (img) images.push(img);
    }
    if (!body && images.length === 0) { skipped.push({ kind: "post", ref: doc.path, reason: "no text and no usable image" }); continue; }

    touchUser(author, "post author");
    noteName(author, authorNameOf(d), createdAt);

    // Likes: reacted.heart (uid[]) and the older likes (uid[] | number).
    const reacted = map(d.reacted);
    const likers = new Set<string>();
    for (const u of arr(reacted[LIKE])) if (typeof u === "string" && u) likers.add(u);
    for (const u of arr(d.likes)) if (typeof u === "string" && u) likers.add(u);
    const declaredLikes = Math.max(
      typeof map(d.reactions)[LIKE] === "number" ? (map(d.reactions)[LIKE] as number) : 0,
      typeof d.likes === "number" ? d.likes : 0,
    );
    const unattributedLikes = Math.max(0, declaredLikes - likers.size);
    for (const u of likers) touchUser(u, "liker");
    if (unattributedLikes) skipped.push({ kind: "like", ref: doc.path, reason: `${unattributedLikes} like(s) stored only as a counter, no user id` });

    // Other reactions and saves → archives.
    for (const [kind, list] of Object.entries(reacted)) {
      if (kind === LIKE) continue;
      for (const u of arr(list)) if (typeof u === "string" && u) reactionArchive.push({ postPath: doc.path, uid: u, kind });
    }
    for (const u of arr(d.savedBy)) if (typeof u === "string" && u) savedArchive.push({ postPath: doc.path, uid: u });

    const rawMeta: Record<string, Plain> = {};
    for (const k of ["category", "reactions", "savedBy", "fire", "lol", "wow", "cry", "likes", "avatar"]) if (k in d) rawMeta[k] = d[k];
    rawMeta.fieldNames = Object.keys(d).sort();

    posts.push({ firebasePath: doc.path, kind: "post", parentFirebasePath: null, authorUid: author, body, createdAt, images, likerUids: [...likers], unattributedLikes, rawMeta });
  }

  // ---- comments → replies
  const postPaths = new Set(posts.map((p) => p.firebasePath));
  for (const doc of snap.comments) {
    const d = doc.data;
    const parentPath = `posts/${parentId(doc.path)}`;
    const author = authorUidOf(d);
    const createdAt = toIso(d.createdAt);
    const body = (str(d.text) ?? "").trim();
    if (!postPaths.has(parentPath)) { skipped.push({ kind: "comment", ref: doc.path, reason: "parent post was not migrated" }); continue; }
    if (!author) { skipped.push({ kind: "comment", ref: doc.path, reason: "no author id" }); continue; }
    if (!createdAt) { skipped.push({ kind: "comment", ref: doc.path, reason: "no usable createdAt" }); continue; }
    if (!body) { skipped.push({ kind: "comment", ref: doc.path, reason: "empty text" }); continue; }
    if (body.length > BODY_MAX) { skipped.push({ kind: "comment", ref: doc.path, reason: `text longer than ${BODY_MAX} characters` }); continue; }
    touchUser(author, "comment author");
    noteName(author, authorNameOf(d), createdAt);
    posts.push({ firebasePath: doc.path, kind: "comment", parentFirebasePath: parentPath, authorUid: author, body, createdAt, images: [], likerUids: [], unattributedLikes: 0, rawMeta: { fieldNames: Object.keys(d).sort() } });
  }

  // ---- follows (union of both mirrored sides)
  const edges = new Map<string, PlannedFollow>();
  const addEdge = (follower: string, followee: string, at: string | null, ref: string) => {
    if (follower === followee) { skipped.push({ kind: "follow", ref, reason: "self-follow" }); return; }
    const key = `${follower}->${followee}`;
    const prev = edges.get(key);
    if (!prev) edges.set(key, { followerUid: follower, followeeUid: followee, createdAt: at });
    else if (at && (!prev.createdAt || at < prev.createdAt)) prev.createdAt = at;
  };
  for (const f of snap.following) addEdge(parentId(f.path), f.id, toIso(f.data.followedAt), f.path);
  for (const f of snap.followers) addEdge(f.id, parentId(f.path), toIso(f.data.followedAt), f.path);
  for (const e of edges.values()) { touchUser(e.followerUid, "follower"); touchUser(e.followeeUid, "followee"); }

  // ---- chat archive
  const chatArchive: MigrationPlan["chatArchive"] = [];
  for (const m of snap.globalChat) {
    const body = (str(m.data.text) ?? "").trim();
    if (!body) { skipped.push({ kind: "chat", ref: m.path, reason: "empty message" }); continue; }
    const uid = authorUidOf(m.data) ?? null;
    if (uid) { touchUser(uid, "chat author"); noteName(uid, authorNameOf(m.data), toIso(m.data.createdAt)); }
    chatArchive.push({ id: m.id, uid, authorName: authorNameOf(m.data) ?? null, body, createdAt: toIso(m.data.createdAt) });
  }
  for (const r of reactionArchive) touchUser(r.uid, "reaction");
  for (const s of savedArchive) touchUser(s.uid, "saved post");

  // ---- identities: Auth export (authoritative) > users doc > names seen in content
  const userDocs = new Map(snap.users.map((u) => [u.id, u.data]));
  const authById = new Map((snap.authUsers ?? []).map((a) => [a.uid, a]));
  for (const u of users.values()) {
    const a = authById.get(u.firebaseUid);
    const doc = userDocs.get(u.firebaseUid);
    u.hasAuthRecord = !!a;
    u.disabled = a?.disabled ?? false;
    u.email = (a?.email ?? str(doc?.email) ?? null)?.toLowerCase() ?? null;
    u.emailVerified = a?.emailVerified ?? false;
    u.displayName = str(a?.displayName ?? undefined) ?? str(doc?.displayName) ?? lastSeenName.get(u.firebaseUid)?.name ?? null;
    u.createdAt = a?.createdAt ?? toIso(doc?.createdAt) ?? null;
  }
  // Auth users with no activity at all still get an account (they may come back).
  for (const a of snap.authUsers ?? []) {
    if (users.has(a.uid)) continue;
    const doc = userDocs.get(a.uid);
    users.set(a.uid, {
      firebaseUid: a.uid, email: a.email?.toLowerCase() ?? null, emailVerified: a.emailVerified,
      displayName: a.displayName ?? str(doc?.displayName) ?? null, createdAt: a.createdAt, seenIn: ["auth"],
      hasAuthRecord: true, disabled: a.disabled,
    });
  }
  for (const doc of snap.users) {
    if (users.has(doc.id)) continue;
    users.set(doc.id, {
      firebaseUid: doc.id, email: str(doc.data.email)?.toLowerCase() ?? null, emailVerified: false,
      displayName: str(doc.data.displayName) ?? null, createdAt: toIso(doc.data.createdAt), seenIn: ["users doc"],
      hasAuthRecord: authById.has(doc.id), disabled: false,
    });
  }

  // No known sign-up date: fall back to the person's earliest activity.
  const firstSeen = new Map<string, string>();
  const seen = (uid: string, at: string | null) => { if (at && (!firstSeen.has(uid) || at < firstSeen.get(uid)!)) firstSeen.set(uid, at); };
  for (const p of posts) seen(p.authorUid, p.createdAt);
  for (const f of edges.values()) { seen(f.followerUid, f.createdAt); }
  for (const m of chatArchive) if (m.uid) seen(m.uid, m.createdAt);
  for (const u of users.values()) if (!u.createdAt) u.createdAt = firstSeen.get(u.firebaseUid) ?? null;

  return {
    users: [...users.values()].sort((a, b) => a.firebaseUid.localeCompare(b.firebaseUid)),
    posts: posts.sort((a, b) => (a.kind === b.kind ? a.createdAt.localeCompare(b.createdAt) : a.kind === "post" ? -1 : 1)),
    follows: [...edges.values()],
    reactionArchive,
    savedArchive,
    chatArchive,
    skipped,
    source: {
      posts: snap.posts.length,
      comments: snap.comments.length,
      userDocs: snap.users.length,
      authUsers: snap.authUsers?.length ?? null,
      followEdges: edges.size,
      chat: snap.globalChat.length,
      images: imageCount,
    },
  };
}
