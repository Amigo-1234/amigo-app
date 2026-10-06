/**
 * Step 3 — Load. Idempotent: every write first checks the legacy.* maps, so
 * running it again only fills in what is missing. Nothing is ever deleted.
 */
import type pg from "pg";
import type { MigrationPlan, PlannedUser, Skip } from "./normalize.ts";
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

export async function load(db: pg.Client, auth: AuthPort, storage: StoragePort, plan: MigrationPlan, opts: LoadOptions): Promise<LoadResult> {
  const r: LoadResult = {
    users: { ...tally(), linked: 0 }, posts: tally(), comments: tally(), media: tally(), likes: tally(), follows: tally(),
    reactionArchive: 0, savedArchive: 0, chatArchive: 0, skipped: [],
  };
  const skip = (s: Skip) => { r.skipped.push(s); opts.log(`  skip ${s.kind} ${s.ref}: ${s.reason}`); };

  // ------------------------------------------------------------- users
  opts.log(`users (${plan.users.length})`);
  const uidToUser = new Map<string, string>();
  {
    const { rows } = await db.query<{ firebase_uid: string; user_id: string }>("select firebase_uid, user_id from legacy.user_map");
    for (const row of rows) uidToUser.set(row.firebase_uid, row.user_id);
  }

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
    const existing = await db.query<{ id: string }>("select id from auth.users where lower(email) = lower($1) limit 1", [email]);
    let userId: string;
    let method: "created" | "linked";
    if (existing.rows[0]) {
      userId = existing.rows[0].id;
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

    await db.query(
      `insert into legacy.user_map (firebase_uid, user_id, link_method, email_at_migration)
       values ($1, $2, $3, $4) on conflict (firebase_uid) do nothing`,
      [u.firebaseUid, userId, method, u.email],
    );
    if (method === "created") await adoptLegacyProfile(db, userId, u);
    uidToUser.set(u.firebaseUid, userId);
  }

  // ------------------------------------------------------------- posts + comments
  opts.log(`posts and replies (${plan.posts.length})`);
  const pathToPost = new Map<string, string>();
  {
    const { rows } = await db.query<{ firebase_path: string; post_id: string }>("select firebase_path, post_id from legacy.post_map");
    for (const row of rows) pathToPost.set(row.firebase_path, row.post_id);
  }

  for (const p of plan.posts) {
    const t = p.kind === "post" ? r.posts : r.comments;
    if (pathToPost.has(p.firebasePath)) { t.existing++; continue; }
    const authorId = uidToUser.get(p.authorUid);
    if (!authorId) { t.skipped++; skip({ kind: p.kind, ref: p.firebasePath, reason: "author account was not migrated" }); continue; }
    const parentId = p.parentFirebasePath ? pathToPost.get(p.parentFirebasePath) : null;
    if (p.parentFirebasePath && !parentId) { t.skipped++; skip({ kind: p.kind, ref: p.firebasePath, reason: "parent post was not migrated" }); continue; }

    await db.query("begin");
    try {
      const { rows } = await db.query<{ id: string }>(
        `insert into public.posts (author_id, body, parent_id, visibility, created_at, updated_at)
         values ($1, $2, $3, 'public', $4, $4) returning id`,
        [authorId, p.body, parentId, p.createdAt],
      );
      await db.query("insert into legacy.post_map (firebase_path, post_id, kind, raw_meta) values ($1, $2, $3, $4)", [
        p.firebasePath, rows[0].id, p.kind, p.rawMeta,
      ]);
      await db.query("commit");
      pathToPost.set(p.firebasePath, rows[0].id);
      t.created++;
    } catch (e) {
      await db.query("rollback");
      throw e;
    }
  }

  // ------------------------------------------------------------- media
  const images = plan.posts.flatMap((p) => p.images.map((img, position) => ({ p, img, position })));
  opts.log(`media (${images.length})`);
  const doneMedia = new Set((await db.query<{ source_key: string }>("select source_key from legacy.media_map")).rows.map((x) => x.source_key));
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
    const { createHash } = await import("node:crypto");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    // Deterministic path → a re-run overwrites the same object instead of adding one.
    const fbPostId = p.firebasePath.split("/")[1];
    const path = `${ownerId}/legacy/${fbPostId}-${position}.${EXT[mimeType]}`;
    await storage.put("post-media", path, bytes, mimeType);

    await db.query("begin");
    try {
      const { rows } = await db.query<{ id: string }>(
        `insert into public.post_media (post_id, owner_id, position, kind, bucket, storage_path, mime_type, width, height, byte_size, created_at)
         values ($1, $2, $3, 'image', 'post-media', $4, $5, $6, $7, $8, $9)
         on conflict (bucket, storage_path) do update set byte_size = excluded.byte_size
         returning id`,
        [postId, ownerId, position, path, mimeType, img.width, img.height, bytes.length, p.createdAt],
      );
      await db.query("insert into legacy.media_map (source_key, media_id, sha256) values ($1, $2, $3)", [img.sourceKey, rows[0].id, sha256]);
      await db.query("commit");
      r.media.created++;
    } catch (e) {
      await db.query("rollback");
      throw e;
    }
  }

  // ------------------------------------------------------------- likes
  opts.log("likes");
  for (const p of plan.posts) {
    const postId = pathToPost.get(p.firebasePath);
    if (!postId) continue;
    for (const uid of p.likerUids) {
      const userId = uidToUser.get(uid);
      if (!userId) { r.likes.skipped++; skip({ kind: "like", ref: `${p.firebasePath} by ${uid}`, reason: "liker account was not migrated" }); continue; }
      const res = await db.query(
        "insert into public.post_likes (user_id, post_id, created_at) values ($1, $2, $3) on conflict do nothing",
        [userId, postId, p.createdAt],
      );
      if (res.rowCount) r.likes.created++;
      else r.likes.existing++;
    }
  }

  // ------------------------------------------------------------- follows
  opts.log(`follows (${plan.follows.length})`);
  for (const f of plan.follows) {
    const follower = uidToUser.get(f.followerUid);
    const followee = uidToUser.get(f.followeeUid);
    if (!follower || !followee) { r.follows.skipped++; skip({ kind: "follow", ref: `${f.followerUid}->${f.followeeUid}`, reason: "an account in this follow was not migrated" }); continue; }
    const res = await db.query(
      "insert into public.follows (follower_id, followee_id, created_at) values ($1, $2, coalesce($3::timestamptz, now())) on conflict do nothing",
      [follower, followee, f.createdAt],
    );
    if (res.rowCount) r.follows.created++;
    else r.follows.existing++;
  }

  // ------------------------------------------------------------- archives
  opts.log("archives");
  for (const a of plan.reactionArchive) {
    const res = await db.query(
      `insert into legacy.reaction_archive (firebase_post_path, firebase_uid, kind, user_id, post_id)
       values ($1, $2, $3, $4, $5) on conflict do nothing`,
      [a.postPath, a.uid, a.kind, uidToUser.get(a.uid) ?? null, pathToPost.get(a.postPath) ?? null],
    );
    r.reactionArchive += res.rowCount ?? 0;
  }
  for (const a of plan.savedArchive) {
    const res = await db.query(
      `insert into legacy.saved_post_archive (firebase_post_path, firebase_uid, user_id, post_id)
       values ($1, $2, $3, $4) on conflict do nothing`,
      [a.postPath, a.uid, uidToUser.get(a.uid) ?? null, pathToPost.get(a.postPath) ?? null],
    );
    r.savedArchive += res.rowCount ?? 0;
  }
  for (const m of plan.chatArchive) {
    const res = await db.query(
      `insert into legacy.global_chat_archive (firebase_id, firebase_uid, user_id, author_name, body, created_at)
       values ($1, $2, $3, $4, $5, $6) on conflict do nothing`,
      [m.id, m.uid, m.uid ? uidToUser.get(m.uid) ?? null : null, m.authorName, m.body, m.createdAt],
    );
    r.chatArchive += res.rowCount ?? 0;
  }

  return r;
}

/** Give a freshly created profile its legacy name and join date. */
async function adoptLegacyProfile(db: pg.Client, userId: string, u: PlannedUser) {
  if (u.createdAt) {
    await db.query("update public.profiles set created_at = least(created_at, $2::timestamptz) where id = $1", [userId, u.createdAt]);
  }
}
