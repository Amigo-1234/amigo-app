/**
 * Post tools (bookmarks, edit, delete, report), account standing and the
 * admin moderation queue (migration 20261017130000_moderation_and_post_tools.sql).
 */
import { SupportError, type AccountStatus, type ContentReport, type ModerationAdminApi, type PostToolsApi, type Suspension } from "../types";
import { dataError, fetchBookmarks, type Db } from "./queries";

async function call<T>(db: Db, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await db.rpc(fn as never, args as never);
  if (error) {
    if (error.code === "42501") throw new SupportError("not-admin", error.message);
    throw Object.assign(dataError(error), { code: error.code });
  }
  return data as T;
}

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
    const s = await call<{ suspended: boolean; reason: string | null; until: string | null } | null>(db, "my_account_status");
    return { suspended: !!s?.suspended, reason: s?.reason ?? null, until: s?.until ? new Date(s.until) : null };
  }

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
  };

  return { postTools, accountStatus, admin };
}
