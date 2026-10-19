/**
 * Legal versioning + creator monetization (migration 20261017090000).
 * Monetization is architecture only: no earnings, balances or payouts exist.
 */
import { SupportError, type AdminCreatorApplication, type AdminCreatorFeedback, type CreatorApplicationInput, type CreatorFeedback, type CreatorProgramme, type CreatorProgrammeAdminApi, type CreatorProgrammeApi, type CreatorStats, type CreatorApplication, type CreatorEngagement, type CreatorOverview, type FraudFlag, type LegalAdminApi, type LegalApi, type LegalSlug, type LegalVersion, type MonetizationAdminApi, type MonetizationApi, type PendingLegal } from "../types";
import type { Db } from "./queries";
import { toAuthor } from "./queries";

async function call<T>(db: Db, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await db.rpc(fn as never, args as never);
  if (error) {
    if (error.code === "42501") throw new SupportError("not-admin", error.message);
    throw Object.assign(new Error(error.message), { code: error.code });
  }
  return data as T;
}

interface LegalRow {
  slug: LegalSlug;
  version: string;
  title: string;
  effective_at: string;
  published_at: string | null;
  requires_acceptance: boolean;
  material_change: boolean;
  summary: string;
}
const toLegal = (r: LegalRow): LegalVersion => ({
  slug: r.slug,
  version: r.version,
  title: r.title,
  effectiveAt: new Date(r.effective_at),
  publishedAt: r.published_at ? new Date(r.published_at) : null,
  requiresAcceptance: r.requires_acceptance,
  materialChange: r.material_change,
  summary: r.summary,
});

type EngagementRow = Record<string, number>;
const toEngagement = (e: EngagementRow | null): CreatorEngagement => ({
  verifiedFollowers: Number(e?.verified_followers ?? 0),
  followers: Number(e?.followers ?? 0),
  posts30d: Number(e?.posts_30d ?? 0),
  supportReceived: Number(e?.support_received ?? 0),
  supportRequestsCompleted: Number(e?.support_requests_completed ?? 0),
  accountAgeDays: Number(e?.account_age_days ?? 0),
});

export function createPlatform(db: Db): { legal: LegalApi; legalAdmin: LegalAdminApi; monetization: MonetizationApi; monetizationAdmin: MonetizationAdminApi; creatorProgramme: CreatorProgrammeApi; creatorProgrammeAdmin: CreatorProgrammeAdminApi } {
  const legal: LegalApi = {
    current: async () => (await call<LegalRow[]>(db, "legal_current")).map(toLegal),
    pending: async () => call<PendingLegal[]>(db, "legal_pending"),
    async accept(docs) {
      await call(db, "legal_accept", { p_docs: docs });
    },
  };

  const legalAdmin: LegalAdminApi = {
    list: async () => (await call<LegalRow[]>(db, "admin_legal_documents")).map(toLegal),
    async publish(i) {
      await call(db, "admin_legal_publish", {
        p_slug: i.slug,
        p_version: i.version,
        p_title: i.title,
        p_effective_at: i.effectiveAt.toISOString(),
        p_requires_acceptance: i.requiresAcceptance,
        p_material_change: i.materialChange,
        p_summary: i.summary,
      });
    },
  };

  const monetization: MonetizationApi = {
    async overview() {
      const o = await call<Record<string, unknown>>(db, "my_creator_overview");
      const app = o.application as Record<string, string> | null;
      return {
        programmeOpen: !!o.programme_open,
        applicationsOpen: !!o.applications_open,
        criteria: (o.criteria as Record<string, unknown>) ?? {},
        publicNote: String(o.public_note ?? ""),
        status: o.status as CreatorOverview["status"],
        statusReason: String(o.status_reason ?? ""),
        standing: o.standing as CreatorOverview["standing"],
        application: app
          ? {
              status: app.status as NonNullable<CreatorOverview["application"]>["status"],
              submittedAt: new Date(app.submitted_at),
              reviewedAt: app.reviewed_at ? new Date(app.reviewed_at) : null,
              reviewNote: app.review_note ?? "",
            }
          : null,
        engagement: toEngagement(o.engagement as EngagementRow),
      };
    },
    async apply() {
      await call(db, "apply_for_monetization");
    },
  };

  const monetizationAdmin: MonetizationAdminApi = {
    async settings() {
      const s = await call<Record<string, unknown>>(db, "admin_monetization_settings");
      return {
        programmeOpen: !!s.programme_open,
        applicationsOpen: !!s.applications_open,
        criteria: (s.criteria as Record<string, unknown>) ?? {},
        publicNote: String(s.public_note ?? ""),
        updatedAt: new Date(String(s.updated_at)),
      };
    },
    async saveSettings(i) {
      await call(db, "admin_monetization_settings_set", { p_programme_open: i.programmeOpen, p_applications_open: i.applicationsOpen, p_criteria: i.criteria, p_public_note: i.publicNote });
    },
    async applications(status) {
      const rows = await call<Record<string, unknown>[]>(db, "admin_creator_applications", { p_status: status });
      return rows.map(
        (r): CreatorApplication => ({
          id: String(r.id),
          person: toAuthor({ id: r.user_id, username: r.username, display_name: r.display_name, avatar_url: r.avatar_url } as never),
          status: r.status as CreatorApplication["status"],
          snapshot: toEngagement(r.snapshot as EngagementRow),
          current: { ...toEngagement(r.current as EngagementRow), openFraudFlags: Number((r.current as EngagementRow)?.open_fraud_flags ?? 0) },
          submittedAt: new Date(String(r.submitted_at)),
          reviewedAt: r.reviewed_at ? new Date(String(r.reviewed_at)) : null,
          reviewNote: String(r.review_note ?? ""),
        }),
      );
    },
    async review(id, decision, note) {
      await call(db, "admin_creator_application_review", { p_application: id, p_decision: decision, p_note: note });
    },
    async setStatus(userId, status, reason) {
      await call(db, "admin_monetization_status_set", { p_user: userId, p_status: status, p_reason: reason });
    },
    async flags(openOnly) {
      const rows = await call<Record<string, string | null>[]>(db, "admin_monetization_flags", { p_open_only: openOnly });
      return rows.map(
        (r): FraudFlag => ({
          id: r.id!,
          userId: r.user_id!,
          handle: r.username!,
          kind: r.kind as FraudFlag["kind"],
          detail: r.detail ?? "",
          createdAt: new Date(r.created_at!),
          resolvedAt: r.resolved_at ? new Date(r.resolved_at) : null,
        }),
      );
    },
    async flag(userId, kind, detail) {
      await call(db, "admin_monetization_flag", { p_user: userId, p_kind: kind, p_detail: detail });
    },
    async resolveFlag(id) {
      await call(db, "admin_monetization_flag_resolve", { p_flag: id });
    },
  };

  const fields = (i: CreatorApplicationInput) => ({
    p_category: i.category,
    p_description: i.description,
    p_reason: i.reason,
    p_links: i.links.map((l) => l.trim()).filter(Boolean),
    p_extra: i.extra,
  });
  type StatsRow = {
    posts: number; likes_received: number; replies_received: number; followers: number; verified_followers: number;
    recent_posts: { id: string; body: string; likes: number; replies: number; created_at: string }[] | null;
    weekly: { week: string; posts: number; likes: number; replies: number }[] | null;
  };
  const toStats = (r: StatsRow): CreatorStats => ({
    posts: Number(r.posts),
    likesReceived: Number(r.likes_received),
    repliesReceived: Number(r.replies_received),
    followers: Number(r.followers ?? 0),
    verifiedFollowers: Number(r.verified_followers),
    recentPosts: (r.recent_posts ?? []).map((p) => ({ id: p.id, body: p.body, likes: Number(p.likes), replies: Number(p.replies), createdAt: new Date(p.created_at) })),
    weekly: (r.weekly ?? []).map((w) => ({ week: w.week, posts: Number(w.posts), likes: Number(w.likes), replies: Number(w.replies) })),
  });
  type FeedbackRow = { id: string; category: CreatorFeedback["category"]; rating: number | null; body: string; status: CreatorFeedback["status"]; admin_response: string; responded_at: string | null; created_at: string };
  const toFeedback = (r: FeedbackRow): CreatorFeedback => ({
    id: r.id,
    category: r.category,
    rating: r.rating,
    body: r.body,
    status: r.status,
    adminResponse: r.admin_response ?? "",
    respondedAt: r.responded_at ? new Date(r.responded_at) : null,
    createdAt: new Date(r.created_at),
  });

  const creatorProgramme: CreatorProgrammeApi = {
    async get() {
      const o = await call<Record<string, unknown>>(db, "my_creator_programme");
      const a = o.application as Record<string, unknown> | null;
      const out: CreatorProgramme = {
        applicationsOpen: !!o.applications_open,
        publicNote: String(o.public_note ?? ""),
        creatorStatus: o.creator_status as CreatorProgramme["creatorStatus"],
        creatorReason: String(o.creator_reason ?? ""),
        accountSuspended: !!o.account_suspended,
        applicationsThisMonth: Number(o.applications_this_month ?? 0),
        application: a
          ? {
              id: String(a.id),
              status: a.status as NonNullable<CreatorProgramme["application"]>["status"],
              category: a.category as CreatorApplicationInput["category"],
              description: String(a.description ?? ""),
              reason: String(a.reason ?? ""),
              links: (a.links as string[] | null) ?? [],
              extra: String(a.extra ?? ""),
              submittedAt: new Date(String(a.submitted_at)),
              updatedAt: new Date(String(a.updated_at ?? a.submitted_at)),
              reviewedAt: a.reviewed_at ? new Date(String(a.reviewed_at)) : null,
              infoRequest: String(a.info_request ?? ""),
              reviewNote: String(a.review_note ?? ""),
            }
          : null,
        stats: o.stats ? toStats(o.stats as StatsRow) : null,
      };
      return out;
    },
    async apply(i) {
      await call(db, "creator_apply", fields(i));
    },
    async update(id, i) {
      await call(db, "creator_application_update", { p_application: id, ...fields(i) });
    },
    async withdraw(id) {
      await call(db, "creator_application_withdraw", { p_application: id });
    },
    async feedback() {
      return (await call<FeedbackRow[]>(db, "my_creator_feedback")).map(toFeedback);
    },
    async sendFeedback(i) {
      await call(db, "creator_feedback_submit", { p_category: i.category, p_rating: i.rating, p_body: i.body });
    },
  };

  const creatorProgrammeAdmin: CreatorProgrammeAdminApi = {
    async applications(status, query) {
      const rows = await call<Record<string, unknown>[]>(db, "admin_creator_applications_v2", { p_status: status, p_query: query });
      return rows.map(
        (r): AdminCreatorApplication => ({
          id: String(r.id),
          person: toAuthor({ id: r.user_id, username: r.username, display_name: r.display_name, avatar_url: r.avatar_url } as never),
          status: r.status as AdminCreatorApplication["status"],
          category: r.category as AdminCreatorApplication["category"],
          description: String(r.description ?? ""),
          reason: String(r.reason ?? ""),
          links: (r.links as string[] | null) ?? [],
          extra: String(r.extra ?? ""),
          infoRequest: String(r.info_request ?? ""),
          creatorStatus: r.creator_status as AdminCreatorApplication["creatorStatus"],
          current: { ...toEngagement(r.current as EngagementRow), openFraudFlags: Number((r.current as EngagementRow)?.open_fraud_flags ?? 0) },
          submittedAt: new Date(String(r.submitted_at)),
          updatedAt: new Date(String(r.updated_at)),
          reviewedAt: r.reviewed_at ? new Date(String(r.reviewed_at)) : null,
          reviewedBy: (r.reviewed_by_username as string | null) ?? null,
          reviewNote: String(r.review_note ?? ""),
        }),
      );
    },
    async decide(id, decision, note) {
      await call(db, "admin_creator_application_decide", { p_application: id, p_decision: decision, p_note: note });
    },
    async stats(userId) {
      return toStats(await call<StatsRow>(db, "admin_creator_stats", { p_user: userId }));
    },
    async feedback(status) {
      const rows = await call<(FeedbackRow & { user_id: string; username: string; display_name: string; avatar_url: string | null; responded_by_username: string | null })[]>(db, "admin_creator_feedback", { p_status: status });
      return rows.map(
        (r): AdminCreatorFeedback => ({
          ...toFeedback(r),
          person: toAuthor({ id: r.user_id, username: r.username, display_name: r.display_name, avatar_url: r.avatar_url } as never),
          respondedBy: r.responded_by_username,
        }),
      );
    },
    async updateFeedback(id, status, response) {
      await call(db, "admin_creator_feedback_update", { p_feedback: id, p_status: status, p_response: response });
    },
  };

  return { legal, legalAdmin, monetization, monetizationAdmin, creatorProgramme, creatorProgrammeAdmin };
}
