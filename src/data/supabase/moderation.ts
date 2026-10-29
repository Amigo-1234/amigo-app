/**
 * Post tools (bookmarks, edit, delete, report), account standing and the
 * admin moderation queue (migration 20261017130000_moderation_and_post_tools.sql).
 */
import { SupportError, type AccountStatus, type AdminUserRow, type PlatformInsights, type BlockingApi, type ContentReport, type ModerationAdminApi, type PlatformStats, type PostToolsApi, type Suspension } from "../types";
import { dataError, fetchBookmarks, type Db } from "./queries";

async function call<T>(db: Db, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await db.rpc(fn as never, args as never);
  if (error) {
    if (error.code === "42501") throw new SupportError("not-admin", error.message);
    throw Object.assign(dataError(error), { code: error.code });
  }
  return data as T;
}

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  created_at: string;
  post_count: number;
  follower_count: number;
  email_verified: boolean;
  is_admin: boolean;
  suspended: boolean;
  suspended_until: string | null;
}

interface UserDetailRow extends Omit<UserRow, "post_count" | "follower_count" | "suspended" | "suspended_until"> {
  bio: string | null;
  posts: number;
  replies: number;
  followers: number;
  following: number;
  likes_given: number;
  moments_30d: number;
  last_active: string | null;
  suspension: { reason: string; since: string; until: string | null } | null;
  warnings: { message: string; at: string; acknowledged: boolean }[] | null;
  reports_against: { posts: number; profile: number; messages: number; moments: number; open: number };
  reports_made: number;
}

const toUserRow = (r: UserRow): AdminUserRow => ({
  id: r.id,
  handle: r.username,
  name: r.display_name || r.username,
  avatarUrl: r.avatar_url,
  joinedAt: new Date(r.created_at),
  posts: Number(r.post_count ?? 0),
  followers: Number(r.follower_count ?? 0),
  emailVerified: !!r.email_verified,
  isAdmin: !!r.is_admin,
  suspended: !!r.suspended,
  suspendedUntil: r.suspended_until ? new Date(r.suspended_until) : null,
});

interface ReportRow {
  id: string;
  reporter_username: string;
  target_type: ContentReport["targetType"];
  target_id: string;
  reason: ContentReport["reason"];
  note: string;
  status: ContentReport["status"];
  created_at: string;
  target_label: string;
  target_text: string | null;
  target_author_id: string | null;
  target_author_username: string | null;
  target_removed: boolean;
  report_count: number;
}

interface SuspensionRow {
  user_id: string;
  username: string;
  display_name: string;
  reason: string;
  suspended_at: string;
  until: string | null;
  suspended_by_username: string | null;
}

export function createModeration(db: Db, invalidate: () => void) {
  const postTools: PostToolsApi = {
    async setBookmarked(_viewerId, postId, saved) {
      await call(db, "set_post_bookmark", { p_post: postId, p_saved: saved });
      invalidate();
    },
    bookmarks: (viewerId, limit) => fetchBookmarks(db, viewerId, limit),
    async edit(_viewerId, postId, text) {
      await call(db, "edit_post", { p_post: postId, p_body: text });
      invalidate();
    },
    async remove(_viewerId, postId) {
      await call(db, "delete_post", { p_post_id: postId });
      invalidate();
    },
    async report(_viewerId, target, targetId, input) {
      await call(db, "report_content", { p_type: target, p_target: targetId, p_reason: input.reason, p_note: input.note });
    },
  };

  async function accountStatus(): Promise<AccountStatus> {
    const [s, w] = await Promise.all([
      call<{ suspended: boolean; reason: string | null; until: string | null } | null>(db, "my_account_status"),
      call<{ id: string; message: string; issued_at: string }[]>(db, "my_warnings").catch(() => []),
    ]);
    return {
      suspended: !!s?.suspended,
      reason: s?.reason ?? null,
      until: s?.until ? new Date(s.until) : null,
      warnings: (w ?? []).map((x) => ({ id: x.id, message: x.message, issuedAt: new Date(x.issued_at) })),
    };
  }

  const acknowledgeWarning = (id: string) => call<void>(db, "acknowledge_warning", { p_warning: id });

  const blocking: BlockingApi = {
    async list() {
      const rows = await call<{ user_id: string; username: string; display_name: string; avatar_url: string | null; blocked_at: string }[]>(db, "my_blocked_accounts");
      return rows.map((r) => ({ id: r.user_id, handle: r.username, name: r.display_name, avatarUrl: r.avatar_url, blockedAt: new Date(r.blocked_at) }));
    },
    async block(userId) {
      await call(db, "dm_block", { p_user: userId });
      invalidate();
    },
    async unblock(userId) {
      await call(db, "dm_unblock", { p_user: userId });
      invalidate();
    },
  };

  const admin: ModerationAdminApi = {
    async listReports(status) {
      const rows = await call<ReportRow[]>(db, "admin_content_reports", { p_status: status });
      return rows.map((r) => ({
        id: r.id,
        reporterHandle: r.reporter_username,
        targetType: r.target_type,
        targetId: r.target_id,
        targetLabel: r.target_label,
        targetText: r.target_text ?? "",
        targetAuthor: r.target_author_id ? { id: r.target_author_id, handle: r.target_author_username ?? "" } : null,
        targetRemoved: r.target_removed,
        reportCount: Number(r.report_count),
        reason: r.reason,
        note: r.note,
        status: r.status,
        createdAt: new Date(r.created_at),
      }));
    },
    async setReportStatus(reportId, status) {
      await call(db, "admin_content_report_set_status", { p_report: reportId, p_status: status });
    },
    async removePost(postId, note) {
      await call(db, "admin_remove_post", { p_post: postId, p_note: note });
      invalidate();
    },
    async listSuspensions() {
      const rows = await call<SuspensionRow[]>(db, "admin_suspensions");
      return rows.map(
        (r): Suspension => ({
          userId: r.user_id,
          handle: r.username,
          name: r.display_name,
          reason: r.reason,
          suspendedAt: new Date(r.suspended_at),
          until: r.until ? new Date(r.until) : null,
          suspendedBy: r.suspended_by_username,
        }),
      );
    },
    async suspend(userId, reason, until) {
      await call(db, "admin_suspend_user", { p_user: userId, p_reason: reason, p_until: until?.toISOString() ?? null });
    },
    async unsuspend(userId, note) {
      await call(db, "admin_unsuspend_user", { p_user: userId, p_note: note });
    },
    async warn(userId, message) {
      await call(db, "admin_warn_user", { p_user: userId, p_message: message });
    },
    async clientErrors(hours) {
      const r = await call<{ total: number; top: { message: string; route: string; app_version: string; n: number; last_at: string }[] }>(db, "admin_client_errors", { p_hours: hours });
      return {
        total: Number(r?.total ?? 0),
        top: (r?.top ?? []).map((t) => ({ message: t.message, route: t.route, version: t.app_version, count: Number(t.n), lastAt: new Date(t.last_at) })),
      };
    },
    async insights() {
      const s = await call<Record<string, unknown>>(db, "admin_insights");
      const n = (k: string) => Number(s?.[k] ?? 0);
      const out: PlatformInsights = {
        generatedAt: new Date(String(s.generated_at)),
        users: n("users"),
        usersVerifiedEmail: n("users_verified_email"),
        newUsersToday: n("new_users_today"),
        newUsers7d: n("new_users_7d"),
        dau: n("dau"),
        wau: n("wau"),
        mau: n("mau"),
        posts: n("posts"),
        replies: n("replies"),
        posts7d: n("posts_7d"),
        momentsLive: n("moments_live"),
        moments7d: n("moments_7d"),
        worlds: n("worlds"),
        worldsLive: n("worlds_live"),
        worldsUpcoming: n("worlds_upcoming"),
        supportRequests: n("support_requests"),
        supportOpen: n("support_open"),
        reportsOpen: n("reports_open"),
        moderationActions7d: n("moderation_actions_7d"),
        suspended: n("suspended"),
        admins: n("admins"),
        daily: ((s.daily as { day: string; signups: number; posts: number; active: number }[] | null) ?? []).map((d) => ({
          day: d.day,
          signups: Number(d.signups),
          posts: Number(d.posts),
          active: Number(d.active),
        })),
        recentUsers: ((s.recent_users as { id: string; username: string; display_name: string; avatar_url: string | null; created_at: string }[] | null) ?? []).map((u) => ({
          id: u.id,
          handle: u.username,
          name: u.display_name || u.username,
          avatarUrl: u.avatar_url,
          joinedAt: new Date(u.created_at),
        })),
      };
      return out;
    },
    async searchUsers(query) {
      const rows = await call<UserRow[]>(db, "admin_user_search", { p_query: query, p_limit: 30 });
      return (rows ?? []).map(toUserRow);
    },
    async userDetail(userId) {
      const d = await call<UserDetailRow>(db, "admin_user_detail", { p_user: userId });
      return {
        ...toUserRow({ ...d, post_count: d.posts, follower_count: d.followers, suspended: !!d.suspension, suspended_until: d.suspension?.until ?? null }),
        bio: d.bio ?? "",
        replies: Number(d.replies),
        following: Number(d.following),
        likesGiven: Number(d.likes_given),
        moments30d: Number(d.moments_30d),
        lastActive: d.last_active ? new Date(d.last_active) : null,
        suspension: d.suspension ? { reason: d.suspension.reason, since: new Date(d.suspension.since), until: d.suspension.until ? new Date(d.suspension.until) : null } : null,
        warnings: (d.warnings ?? []).map((w) => ({ message: w.message, at: new Date(w.at), acknowledged: w.acknowledged })),
        reportsAgainst: d.reports_against,
        reportsMade: Number(d.reports_made),
      };
    },
    async addNote(targetType, targetId, note) {
      await call(db, "admin_add_note", { p_target_type: targetType, p_target: targetId, p_note: note });
    },
    async history(targetId) {
      const rows = await call<{ id: string; admin_username: string | null; action: string; target_type: string; summary: string; created_at: string }[]>(db, "admin_target_history", { p_target: targetId });
      return (rows ?? []).map((r) => ({ id: r.id, admin: r.admin_username, action: r.action, targetType: r.target_type, summary: r.summary, at: new Date(r.created_at) }));
    },
    async stats() {
      const s = await call<Record<string, number>>(db, "admin_platform_stats");
      const n = (k: string) => Number(s?.[k] ?? 0);
      const out: PlatformStats = {
        users: n("users"),
        usersVerifiedEmail: n("users_verified_email"),
        newUsers24h: n("new_users_24h"),
        newUsers7d: n("new_users_7d"),
        active24h: n("active_24h"),
        posts24h: n("posts_24h"),
        replies24h: n("replies_24h"),
        messages24h: n("messages_24h"),
        worldJoins7d: n("world_joins_7d"),
        supportSubmissions7d: n("support_submissions_7d"),
        openReports: n("open_reports"),
        suspended: n("suspended"),
      };
      return out;
    },
  };

  async function reportError(kind: "error" | "unhandledrejection" | "render", message: string, route: string) {
    await call(db, "log_client_error", { p_kind: kind, p_message: message, p_route: route, p_version: __APP_VERSION__ });
  }

  /** Performance samples (migration 20261018092000): metric names and numbers only, unlinked to people. */
  async function reportPerf(samples: { m: string; v: number; r: string; n: string }[]) {
    await call(db, "log_client_perf", { p_samples: samples, p_version: __APP_VERSION__ });
  }

  return { postTools, accountStatus, acknowledgeWarning, blocking, reportError, reportPerf, admin };
}
