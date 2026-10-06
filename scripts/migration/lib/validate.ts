/**
 * Step 4 — Validate. Recomputes what *should* exist from the snapshot and
 * compares it with what *does* exist in Supabase. Read-only.
 */
import { createHash } from "node:crypto";
import type { MigrationDb } from "./db.ts";
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
  accounts: { ref: string; ok: boolean; detail: string }[];
  threads: { ref: string; ok: boolean; detail: string }[];
  skipReasons: { kind: string; reason: string; count: number }[];
}

interface DbSnapshot {
  users: { firebase_uid: string; user_id: string; link_method: string; username: string | null; display_name: string | null }[];
  posts: { path: string; kind: string; post_id: string; author_id: string; body: string; created_at: string; like_count: number; reply_count: number; parent_id: string | null; deleted: boolean; media: number }[];
  media: { source_key: string; sha256: string; bucket: string; storage_path: string }[];
  likes_on_migrated_posts: number;
  follows_between_migrated: number;
  chat_archive: number;
  bad_like_counts: number;
  bad_reply_counts: number;
  bad_follow_counts: number;
  duplicate_emails: number;
  missing_profiles: number;
}

function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export async function validate(db: MigrationDb, storage: StoragePort, plan: MigrationPlan, skipped: Skip[], sampleSize = 10): Promise<ValidationReport> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail = "") => checks.push({ name, ok, detail });
  const s = await db.rpc<DbSnapshot>("legacy_validation_snapshot");

  const userMap = new Map(s.users.map((u) => [u.firebase_uid, u]));
  const postByPath = new Map(s.posts.map((p) => [p.path, p]));
  const pathById = new Map(s.posts.map((p) => [p.post_id, p.path]));
  const migratedUsers = new Set(userMap.keys());

  // Expected = everything in the plan whose dependencies made it across.
  const expPosts = plan.posts.filter((p) => p.kind === "post" && migratedUsers.has(p.authorUid));
  const expPostPaths = new Set(expPosts.map((p) => p.firebasePath));
  const expComments = plan.posts.filter((p) => p.kind === "comment" && migratedUsers.has(p.authorUid) && expPostPaths.has(p.parentFirebasePath!));
  const expImages = expPosts.flatMap((p) => p.images);
  const expLikes = expPosts.reduce((n, p) => n + p.likerUids.filter((u) => migratedUsers.has(u)).length, 0);
  const expFollows = plan.follows.filter((f) => migratedUsers.has(f.followerUid) && migratedUsers.has(f.followeeUid));

  const count = (kind: string) => skipped.filter((x) => x.kind === kind).length;
  const migratedPosts = s.posts.filter((p) => p.kind === "post").length;
  const migratedComments = s.posts.filter((p) => p.kind === "comment").length;
  const allLikers = plan.posts.reduce((n, p) => n + p.likerUids.length, 0);
  const unattributed = plan.posts.reduce((n, p) => n + p.unattributedLikes, 0);

  const rows: ValidationReport["rows"] = [
    { entity: "users (accounts)", source: plan.users.length, expected: plan.users.length - count("user"), migrated: userMap.size, skipped: plan.users.length - userMap.size },
    { entity: "posts", source: plan.source.posts, expected: expPosts.length, migrated: migratedPosts, skipped: plan.source.posts - migratedPosts },
    { entity: "replies (comments)", source: plan.source.comments, expected: expComments.length, migrated: migratedComments, skipped: plan.source.comments - migratedComments },
    { entity: "post images", source: plan.source.images, expected: expImages.length, migrated: s.media.length, skipped: plan.source.images - s.media.length },
    { entity: "likes (with a user id)", source: allLikers, expected: expLikes, migrated: s.likes_on_migrated_posts, skipped: allLikers - s.likes_on_migrated_posts },
    { entity: "likes (counter only, no user id)", source: unattributed, expected: 0, migrated: 0, skipped: unattributed },
    { entity: "follows", source: plan.source.followEdges, expected: expFollows.length, migrated: s.follows_between_migrated, skipped: plan.source.followEdges - s.follows_between_migrated },
    { entity: "global chat (archived)", source: plan.source.chat, expected: plan.chatArchive.length, migrated: s.chat_archive, skipped: plan.source.chat - plan.chatArchive.length },
  ];
  for (const r of rows) check(`${r.entity}: migrated = expected`, r.migrated === r.expected, `${r.migrated} / ${r.expected}`);

  check("posts.like_count matches like rows", s.bad_like_counts === 0, `${s.bad_like_counts} mismatches`);
  check("posts.reply_count matches replies", s.bad_reply_counts === 0, `${s.bad_reply_counts} mismatches`);
  check("profile follow counters match follows", s.bad_follow_counts === 0, `${s.bad_follow_counts} mismatches`);
  check("no duplicate accounts per email", s.duplicate_emails === 0, `${s.duplicate_emails} duplicated emails`);
  check("every migrated user has a profile", s.missing_profiles === 0, `${s.missing_profiles} missing`);
  const badUsernames = s.users.filter((u) => !u.username || !/^[a-z0-9_]{3,24}$/.test(u.username)).length;
  check("every migrated user has a valid username", badUsernames === 0, `${badUsernames} invalid`);
  const deleted = s.posts.filter((p) => p.deleted).length;
  check("no migrated post is deleted", deleted === 0, `${deleted} deleted`);

  // Every migrated image must be byte-identical to the Firestore original.
  const expectedSha = new Map(expImages.map((i) => [i.sourceKey, i.sha256]));
  let mediaOk = 0;
  for (const m of s.media) {
    const bytes = await storage.get(m.bucket, m.storage_path);
    const sha = bytes ? createHash("sha256").update(bytes).digest("hex") : null;
    if (sha && sha === m.sha256 && (expectedSha.get(m.source_key) ?? sha) === sha) mediaOk++;
  }
  check("stored images are byte-identical to Firestore", mediaOk === s.media.length, `${mediaOk} / ${s.media.length} verified by SHA-256`);

  // Random posts/replies, field by field.
  const samples: ValidationReport["samples"] = [];
  for (const p of shuffle([...expPosts, ...expComments].filter((x) => postByPath.has(x.firebasePath))).slice(0, sampleSize)) {
    const row = postByPath.get(p.firebasePath)!;
    const problems: string[] = [];
    if (row.author_id !== userMap.get(p.authorUid)?.user_id) problems.push("author");
    if (row.body !== p.body) problems.push("text");
    if (new Date(row.created_at).toISOString() !== new Date(p.createdAt).toISOString()) problems.push(`timestamp ${row.created_at} ≠ ${p.createdAt}`);
    const expLikeCount = p.likerUids.filter((u) => migratedUsers.has(u)).length;
    if (row.like_count !== expLikeCount) problems.push(`likes ${row.like_count} ≠ ${expLikeCount}`);
    if (p.kind === "post") {
      const expReplies = expComments.filter((c) => c.parentFirebasePath === p.firebasePath).length;
      if (row.reply_count !== expReplies) problems.push(`replies ${row.reply_count} ≠ ${expReplies}`);
    } else if (pathById.get(row.parent_id ?? "") !== p.parentFirebasePath) problems.push("parent");
    if (row.media !== p.images.length) problems.push(`media ${row.media} ≠ ${p.images.length}`);
    samples.push({ ref: p.firebasePath, ok: problems.length === 0, detail: problems.join("; ") || "author, text, timestamp, likes, replies, media match" });
  }
  check(`random sample of ${samples.length} posts/replies matches source`, samples.every((x) => x.ok), `${samples.filter((x) => x.ok).length} / ${samples.length}`);

  // Random accounts: identity, name, and everything they authored/follow.
  const accounts: ValidationReport["accounts"] = [];
  for (const u of shuffle(plan.users.filter((x) => userMap.has(x.firebaseUid))).slice(0, 5)) {
    const m = userMap.get(u.firebaseUid)!;
    const problems: string[] = [];
    if (!m.username) problems.push("no username");
    if (m.link_method === "created" && u.displayName && m.display_name !== u.displayName.trim().slice(0, 50)) problems.push("display name");
    const authoredExp = [...expPosts, ...expComments].filter((p) => p.authorUid === u.firebaseUid).length;
    const authoredAct = s.posts.filter((p) => p.author_id === m.user_id).length;
    if (authoredExp !== authoredAct) problems.push(`authored ${authoredAct} ≠ ${authoredExp}`);
    const followsExp = expFollows.filter((f) => f.followerUid === u.firebaseUid).length;
    accounts.push({ ref: `${u.firebaseUid} → @${m.username}`, ok: problems.length === 0, detail: problems.join("; ") || `${m.link_method}; ${authoredAct} posts/replies; follows ${followsExp} people` });
  }
  check(`sample of ${accounts.length} accounts matches source`, accounts.every((x) => x.ok), `${accounts.filter((x) => x.ok).length} / ${accounts.length}`);

  // Whole conversations: every reply, in order, with its author.
  const threads: ValidationReport["threads"] = [];
  const withReplies = expPosts.filter((p) => expComments.some((c) => c.parentFirebasePath === p.firebasePath));
  for (const p of shuffle(withReplies).slice(0, 5)) {
    const root = postByPath.get(p.firebasePath);
    const expected = expComments.filter((c) => c.parentFirebasePath === p.firebasePath).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const actual = s.posts.filter((x) => root && x.parent_id === root.post_id).sort((a, b) => a.created_at.localeCompare(b.created_at));
    const same = !!root && expected.length === actual.length && expected.every((c, i) =>
      actual[i].body === c.body && actual[i].author_id === userMap.get(c.authorUid)?.user_id);
    threads.push({ ref: p.firebasePath, ok: same, detail: same ? `${actual.length} replies, same order, text and authors` : `expected ${expected.length} replies, found ${actual.length} or content differs` });
  }
  check(`sample of ${threads.length} conversations matches source`, threads.every((x) => x.ok), `${threads.filter((x) => x.ok).length} / ${threads.length}`);

  const reasons = new Map<string, number>();
  for (const x of skipped) {
    const key = `${x.kind}\u0000${x.reason.replace(/\d+ like\(s\)/, "N like(s)")}`;
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }
  const skipReasons = [...reasons].map(([k, n]) => ({ kind: k.split("\u0000")[0], reason: k.split("\u0000")[1], count: n }));
  return { rows, checks, samples, accounts, threads, skipReasons };
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
    for (const x of v.skipReasons) lines.push(`| ${x.kind} | ${x.reason} | ${x.count} |`);
  }
  for (const [heading, list] of [["Random posts and replies", v.samples], ["Random accounts", v.accounts], ["Random conversations", v.threads]] as const) {
    lines.push("", `## ${heading}`, "");
    for (const x of list) lines.push(`- ${x.ok ? "PASS" : "**FAIL**"} \`${x.ref}\` — ${x.detail}`);
  }
  return lines.join("\n") + "\n";
}
