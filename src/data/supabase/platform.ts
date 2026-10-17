/**
 * Legal versioning + creator monetization (migration 20261017090000).
 * Monetization is architecture only: no earnings, balances or payouts exist.
 */
import { SupportError, type CreatorApplication, type CreatorEngagement, type CreatorOverview, type FraudFlag, type LegalAdminApi, type LegalApi, type LegalSlug, type LegalVersion, type MonetizationAdminApi, type MonetizationApi, type PendingLegal } from "../types";
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

export function createPlatform(db: Db): { legal: LegalApi; legalAdmin: LegalAdminApi; monetization: MonetizationApi; monetizationAdmin: MonetizationAdminApi } {
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

  return { legal, legalAdmin, monetization, monetizationAdmin };
}
