/**
 * Step 4 — Validate. Recomputes what *should* exist from the snapshot and
 * compares it with what *does* exist in Supabase. Read-only.
 */
import { createHash } from "node:crypto";
import type pg from "pg";
import type { MigrationPlan, Skip } from "./normalize.ts";
import type { StoragePort } from "./ports.ts";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ValidationReport {
  rows: { entity: string; source: number; expected: number; migrated: number; skipped: number }[];
  checks: Check[];
  samples: { ref: string; ok: boolean; detail: string }[];
  skipReasons: { kind: string; reason: string; count: number }[];
}

export async function validate(db: pg.Client, storage: StoragePort, plan: MigrationPlan, skipped: Skip[], sampleSize = 10): Promise<ValidationReport> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail = "") => checks.push({ name, ok, detail });
  const one = async <T = number>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0] as T;

  const userMap = new Map((await db.query<{ firebase_uid: string; user_id: string }>("select firebase_uid, user_id from legacy.user_map")).rows.map((r) => [r.firebase_uid, r.user_id]));
  const postMap = new Map((await db.query<{ firebase_path: string; post_id: string }>("select firebase_path, post_id from legacy.post_map")).rows.map((r) => [r.firebase_path, r.post_id]));
  const migratedUsers = new Set(userMap.keys());

  // Expected = everything in the plan whose dependencies made it across.
  const expPosts = plan.posts.filter((p) => p.kind === "post" && migratedUsers.has(p.authorUid));
  const expPostPaths = new Set(expPosts.map((p) => p.firebasePath));
  const expComments = plan.posts.filter((p) => p.kind === "comment" && migratedUsers.has(p.authorUid) && expPostPaths.has(p.parentFirebasePath!));
  const expImages = expPosts.flatMap((p) => p.images);
  const expLikes = expPosts.flatMap((p) => p.likerUids.filter((u) => migratedUsers.has(u)).map((u) => `${p.firebasePath}|${u}`));
  const expFollows = plan.follows.filter((f) => migratedUsers.has(f.followerUid) && migratedUsers.has(f.followeeUid));

  const count = (kind: string) => skipped.filter((s) => s.kind === kind).length;
  const migratedPosts = [...postMap.keys()].filter((k) => !k.includes("/comments/")).length;
  const migratedComments = [...postMap.keys()].filter((k) => k.includes("/comments/")).length;
  const migratedMedia = (await one<{ n: number }>("select count(*)::int n from legacy.media_map")).n;
  const migratedLikes = (await one<{ n: number }>(
    "select count(*)::int n from public.post_likes l join legacy.post_map m on m.post_id = l.post_id where m.kind = 'post'")).n;
  const migratedFollows = (await one<{ n: number }>(
    `select count(*)::int n from public.follows f
       join legacy.user_map a on a.user_id = f.follower_id
       join legacy.user_map b on b.user_id = f.followee_id`)).n;
  const unattributed = plan.posts.reduce((s, p) => s + p.unattributedLikes, 0);

  const rows: ValidationReport["rows"] = [
    { entity: "users (accounts)", source: plan.users.length, expected: plan.users.length - count("user"), migrated: userMap.size, skipped: count("user") },
    { entity: "posts", source: plan.source.posts, expected: expPosts.length, migrated: migratedPosts, skipped: plan.source.posts - migratedPosts },
    { entity: "replies (comments)", source: plan.source.comments, expected: expComments.length, migrated: migratedComments, skipped: plan.source.comments - migratedComments },
    { entity: "post images", source: plan.source.images, expected: expImages.length, migrated: migratedMedia, skipped: plan.source.images - migratedMedia },
    { entity: "likes (with a user id)", source: plan.posts.reduce((s, p) => s + p.likerUids.length, 0), expected: expLikes.length, migrated: migratedLikes, skipped: plan.posts.reduce((s, p) => s + p.likerUids.length, 0) - migratedLikes },
    { entity: "likes (counter only, no user id)", source: unattributed, expected: 0, migrated: 0, skipped: unattributed },
    { entity: "follows", source: plan.source.followEdges, expected: expFollows.length, migrated: migratedFollows, skipped: plan.source.followEdges - migratedFollows },
    { entity: "global chat (archived)", source: plan.source.chat, expected: plan.chatArchive.length, migrated: (await one<{ n: number }>("select count(*)::int n from legacy.global_chat_archive")).n, skipped: plan.source.chat - plan.chatArchive.length },
  ];
  for (const r of rows) check(`${r.entity}: migrated = expected`, r.migrated === r.expected, `${r.migrated} / ${r.expected}`);

  // Counters must agree with rows (they're trigger-maintained).
  const badLikeCounts = (await one<{ n: number }>(
    "select count(*)::int n from public.posts p where p.like_count <> (select count(*) from public.post_likes l where l.post_id = p.id)")).n;
  check("posts.like_count matches like rows", badLikeCounts === 0, `${badLikeCounts} mismatches`);
  const badReplyCounts = (await one<{ n: number }>(
    "select count(*)::int n from public.posts p where p.reply_count <> (select count(*) from public.posts c where c.parent_id = p.id and c.deleted_at is null)")).n;
  check("posts.reply_count matches replies", badReplyCounts === 0, `${badReplyCounts} mismatches`);
  const badFollow = (await one<{ n: number }>(
    `select count(*)::int n from public.profiles pr
      where pr.follower_count <> (select count(*) from public.follows f where f.followee_id = pr.id)
         or pr.following_count <> (select count(*) from public.follows f where f.follower_id = pr.id)`)).n;
  check("profile follow counters match follows", badFollow === 0, `${badFollow} mismatches`);
  const dupUsers = (await one<{ n: number }>("select count(*)::int n from (select lower(email) from auth.users group by 1 having count(*) > 1) d")).n;
  check("no duplicate accounts per email", dupUsers === 0, `${dupUsers} duplicated emails`);
  const noProfile = (await one<{ n: number }>("select count(*)::int n from legacy.user_map m left join public.profiles p on p.id = m.user_id where p.id is null")).n;
  check("every migrated user has a profile", noProfile === 0, `${noProfile} missing`);

  // Every migrated image must be byte-identical to the Firestore original.
  let mediaOk = 0;
  const mediaRows = (await db.query<{ source_key: string; sha256: string; bucket: string; storage_path: string }>(
    "select mm.source_key, mm.sha256, pm.bucket, pm.storage_path from legacy.media_map mm join public.post_media pm on pm.id = mm.media_id")).rows;
  const expectedSha = new Map(expImages.map((i) => [i.sourceKey, i.sha256]));
  for (const m of mediaRows) {
    const bytes = await storage.get(m.bucket, m.storage_path);
    const sha = bytes ? createHash("sha256").update(bytes).digest("hex") : null;
    if (sha && sha === m.sha256 && (expectedSha.get(m.source_key) ?? sha) === sha) mediaOk++;
  }
  check("stored images are byte-identical to Firestore", mediaOk === mediaRows.length, `${mediaOk} / ${mediaRows.length} verified by SHA-256`);

  // Random sample, compared field by field.
  const samples: ValidationReport["samples"] = [];
  const pool = [...expPosts, ...expComments].filter((p) => postMap.has(p.firebasePath));
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  for (const p of pool.slice(0, sampleSize)) {
    const row = await one<{ author_id: string; body: string; created_at: Date; like_count: number; reply_count: number; parent_id: string | null; media: number }>(
      "select author_id, body, created_at, like_count, reply_count, parent_id, (select count(*)::int from public.post_media m where m.post_id = posts.id) media from public.posts where id = $1",
      [postMap.get(p.firebasePath)],
    );
    const problems: string[] = [];
    if (row.author_id !== userMap.get(p.authorUid)) problems.push("author");
    if (row.body !== p.body) problems.push("text");
    if (row.created_at.toISOString() !== new Date(p.createdAt).toISOString()) problems.push(`timestamp ${row.created_at.toISOString()} ≠ ${p.createdAt}`);
    const expLikeCount = p.likerUids.filter((u) => migratedUsers.has(u)).length;
    if (row.like_count !== expLikeCount) problems.push(`likes ${row.like_count} ≠ ${expLikeCount}`);
    if (p.kind === "post") {
      const expReplies = expComments.filter((c) => c.parentFirebasePath === p.firebasePath).length;
      if (row.reply_count !== expReplies) problems.push(`replies ${row.reply_count} ≠ ${expReplies}`);
    } else if (row.parent_id !== postMap.get(p.parentFirebasePath!)) problems.push("parent");
    if (row.media !== p.images.length) problems.push(`media ${row.media} ≠ ${p.images.length}`);
    samples.push({ ref: p.firebasePath, ok: problems.length === 0, detail: problems.join("; ") || "author, text, timestamp, likes, replies, media match" });
  }
  check(`random sample of ${samples.length} posts/replies matches source`, samples.every((s) => s.ok), `${samples.filter((s) => s.ok).length} / ${samples.length}`);

  const reasons = new Map<string, number>();
  for (const s of skipped) reasons.set(`${s.kind}\u0000${s.reason.replace(/\d+ like\(s\)/, "N like(s)")}`, (reasons.get(`${s.kind}\u0000${s.reason.replace(/\d+ like\(s\)/, "N like(s)")}`) ?? 0) + 1);
  const skipReasons = [...reasons].map(([k, n]) => ({ kind: k.split("\u0000")[0], reason: k.split("\u0000")[1], count: n }));

  return { rows, checks, samples, skipReasons };
}

export function reportMarkdown(title: string, meta: Record<string, string>, v: ValidationReport): string {
  const lines = [`# ${title}`, ""];
  for (const [k, val] of Object.entries(meta)) lines.push(`- **${k}:** ${val}`);
  lines.push("", "## Counts", "", "| | Source | Expected | Migrated | Not migrated |", "|---|---:|---:|---:|---:|");
  for (const r of v.rows) lines.push(`| ${r.entity} | ${r.source} | ${r.expected} | ${r.migrated} | ${r.skipped} |`);
  lines.push("", "## Checks", "");
  for (const c of v.checks) lines.push(`- ${c.ok ? "PASS" : "**FAIL**"} — ${c.name}${c.detail ? ` (${c.detail})` : ""}`);
  lines.push("", "## Not migrated, by reason", "");
  if (!v.skipReasons.length) lines.push("Nothing was skipped.");
  else {
    lines.push("| Kind | Reason | Count |", "|---|---|---:|");
    for (const s of v.skipReasons) lines.push(`| ${s.kind} | ${s.reason} | ${s.count} |`);
  }
  lines.push("", "## Random sample", "");
  for (const s of v.samples) lines.push(`- ${s.ok ? "PASS" : "**FAIL**"} \`${s.ref}\` — ${s.detail}`);
  return lines.join("\n") + "\n";
}
