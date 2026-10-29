/**
 * Step 3 — Load. Idempotent: every write is checked against the legacy.* maps
 * (inside the import functions), so running it again only fills in what is
 * missing. Nothing is ever deleted, and Firebase is never touched.
 */
import { createHash } from "node:crypto";
import type { MigrationDb } from "./db.ts";
import type { MigrationPlan, Skip } from "./normalize.ts";
import type { AuthPort, StoragePort } from "./ports.ts";

export type OrphanPolicy = "skip" | "placeholder";

export interface LoadOptions {
  orphans: OrphanPolicy;
  log: (msg: string) => void;
}

export interface Tally {
  created: number;
  existing: number;
  linked?: number;
  skipped: number;
}

export interface LoadResult {
  users: Tally;
  posts: Tally;
  comments: Tally;
  media: Tally;
  likes: Tally;
  follows: Tally;
  reactionArchive: number;
  savedArchive: number;
  chatArchive: number;
  skipped: Skip[];
}

const tally = (): Tally => ({ created: 0, existing: 0, skipped: 0 });
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

export async function load(db: MigrationDb, auth: AuthPort, storage: StoragePort, plan: MigrationPlan, opts: LoadOptions): Promise<LoadResult> {
  const r: LoadResult = {
    users: { ...tally(), linked: 0 }, posts: tally(), comments: tally(), media: tally(), likes: tally(), follows: tally(),
    reactionArchive: 0, savedArchive: 0, chatArchive: 0, skipped: [],
  };
  const skip = (s: Skip) => { r.skipped.push(s); opts.log(`  skip ${s.kind} ${s.ref}: ${s.reason}`); };
  const state = await db.state();

  // ------------------------------------------------------------- users
  opts.log(`users (${plan.users.length})`);
  const uidToUser = new Map(Object.entries(state.users));
  for (const u of plan.users) {
    if (uidToUser.has(u.firebaseUid)) { r.users.existing++; continue; }
    const placeholder = !u.email;
    if (placeholder && opts.orphans === "skip") {
      r.users.skipped++;
      skip({ kind: "user", ref: u.firebaseUid, reason: `no email on record (seen as ${u.seenIn.join(", ")}); rerun with an Auth export or --orphans placeholder` });
      continue;
    }
    const email = u.email ?? `firebase-${u.firebaseUid.toLowerCase()}@legacy.amigo.invalid`;

    // Never create a second account for an email that already exists.
    const existing = await db.rpc<string | null>("legacy_find_auth_user", { p_email: email });
    let userId: string;
    let method: "created" | "linked";
    if (existing) {
      userId = existing;
      method = "linked";
      r.users.linked!++;
      opts.log(`  link ${u.firebaseUid} → existing auth user ${userId}`);
    } else {
      userId = await auth.createUser({
        email,
        // Accounts were usable on Firebase without verification. Access still
        // needs the old password (verified by Google) or the inbox (reset link).
        emailConfirmed: !placeholder,
        displayName: u.displayName,
        firebaseUid: u.firebaseUid,
        placeholder,
        banned: u.disabled,
      });
      method = "created";
      r.users.created++;
    }
    await db.rpc("legacy_map_user", {
      p_firebase_uid: u.firebaseUid, p_user_id: userId, p_link_method: method, p_email: u.email, p_created_at: u.createdAt,
    });
    uidToUser.set(u.firebaseUid, userId);
  }

  // ------------------------------------------------------------- posts + comments
  opts.log(`posts and replies (${plan.posts.length})`);
  const pathToPost = new Map(Object.entries(state.posts));
  for (const p of plan.posts) {
    const t = p.kind === "post" ? r.posts : r.comments;
    if (pathToPost.has(p.firebasePath)) { t.existing++; continue; }
    const authorId = uidToUser.get(p.authorUid);
    if (!authorId) { t.skipped++; skip({ kind: p.kind, ref: p.firebasePath, reason: "author account was not migrated" }); continue; }
    const parentId = p.parentFirebasePath ? pathToPost.get(p.parentFirebasePath) : null;
    if (p.parentFirebasePath && !parentId) { t.skipped++; skip({ kind: p.kind, ref: p.firebasePath, reason: "parent post was not migrated" }); continue; }
    const id = await db.rpc<string>("legacy_import_post", {
      p_path: p.firebasePath, p_kind: p.kind, p_author_id: authorId, p_body: p.body, p_parent_id: parentId,
      p_created_at: p.createdAt, p_raw_meta: p.rawMeta,
    });
    pathToPost.set(p.firebasePath, id);
    t.created++;
  }

  // ------------------------------------------------------------- media
  const images = plan.posts.flatMap((p) => p.images.map((img, position) => ({ p, img, position })));
  opts.log(`media (${images.length})`);
  const doneMedia = new Set(state.media);
  for (const { p, img, position } of images) {
    if (doneMedia.has(img.sourceKey)) { r.media.existing++; continue; }
    const postId = pathToPost.get(p.firebasePath);
    const ownerId = uidToUser.get(p.authorUid);
    if (!postId || !ownerId) { r.media.skipped++; skip({ kind: "image", ref: img.sourceKey, reason: "post was not migrated" }); continue; }

    let bytes: Buffer;
    let mimeType = img.mimeType;
    if (img.base64) bytes = Buffer.from(img.base64, "base64");
    else {
      const res = await fetch(img.remoteUrl!);
      if (!res.ok) { r.media.skipped++; skip({ kind: "image", ref: img.sourceKey, reason: `download failed (${res.status})` }); continue; }
      bytes = Buffer.from(await res.arrayBuffer());
      mimeType = res.headers.get("content-type")?.split(";")[0] ?? "";
      if (!EXT[mimeType]) { r.media.skipped++; skip({ kind: "image", ref: img.sourceKey, reason: `unsupported remote type ${mimeType}` }); continue; }
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    // Deterministic path → a re-run overwrites the same object instead of adding one.
    const path = `${ownerId}/legacy/${p.firebasePath.split("/")[1]}-${position}.${EXT[mimeType]}`;
    await storage.put("post-media", path, bytes, mimeType);
    const created = await db.rpc<boolean>("legacy_import_media", {
      p_source_key: img.sourceKey, p_post_id: postId, p_owner_id: ownerId, p_position: position, p_storage_path: path,
      p_mime_type: mimeType, p_width: img.width, p_height: img.height, p_byte_size: bytes.length, p_created_at: p.createdAt, p_sha256: sha256,
    });
    if (created) r.media.created++;
    else r.media.existing++;
  }

  // ------------------------------------------------------------- likes
  opts.log("likes");
  const likeRows: { user_id: string; post_id: string; created_at: string }[] = [];
  for (const p of plan.posts) {
    const postId = pathToPost.get(p.firebasePath);
    if (!postId) continue;
    for (const uid of p.likerUids) {
      const userId = uidToUser.get(uid);
      if (!userId) { r.likes.skipped++; skip({ kind: "like", ref: `${p.firebasePath} by ${uid}`, reason: "liker account was not migrated" }); continue; }
      likeRows.push({ user_id: userId, post_id: postId, created_at: p.createdAt });
    }
  }
  for (let i = 0; i < likeRows.length; i += 500) {
    const batch = likeRows.slice(i, i + 500);
    const n = await db.rpc<number>("legacy_import_likes", { p_rows: batch });
    r.likes.created += n;
    r.likes.existing += batch.length - n;
  }

  // ------------------------------------------------------------- follows
  opts.log(`follows (${plan.follows.length})`);
  const followRows: { follower_id: string; followee_id: string; created_at: string | null }[] = [];
  for (const f of plan.follows) {
    const follower = uidToUser.get(f.followerUid);
    const followee = uidToUser.get(f.followeeUid);
    if (!follower || !followee) { r.follows.skipped++; skip({ kind: "follow", ref: `${f.followerUid}->${f.followeeUid}`, reason: "an account in this follow was not migrated" }); continue; }
    followRows.push({ follower_id: follower, followee_id: followee, created_at: f.createdAt });
  }
  for (let i = 0; i < followRows.length; i += 500) {
    const batch = followRows.slice(i, i + 500);
    const n = await db.rpc<number>("legacy_import_follows", { p_rows: batch });
    r.follows.created += n;
    r.follows.existing += batch.length - n;
  }

  // ------------------------------------------------------------- archives
  opts.log("archives");
  const archived = await db.rpc<{ reactions: number; saved: number; chat: number }>("legacy_import_archives", {
    p_reactions: plan.reactionArchive.map((a) => ({ post_path: a.postPath, uid: a.uid, kind: a.kind, user_id: uidToUser.get(a.uid) ?? null, post_id: pathToPost.get(a.postPath) ?? null })),
    p_saved: plan.savedArchive.map((a) => ({ post_path: a.postPath, uid: a.uid, user_id: uidToUser.get(a.uid) ?? null, post_id: pathToPost.get(a.postPath) ?? null })),
    p_chat: plan.chatArchive.map((m) => ({ id: m.id, uid: m.uid, user_id: m.uid ? uidToUser.get(m.uid) ?? null : null, author_name: m.authorName, body: m.body, created_at: m.createdAt })),
  });
  r.reactionArchive = archived.reactions;
  r.savedArchive = archived.saved;
  r.chatArchive = archived.chat;

  return r;
}
