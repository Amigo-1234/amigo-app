/**
 * Supabase Moments (migration 20261006220000_moments.sql). Photos live in the
 * private moment-media bucket and are shown through short-lived signed URLs,
 * which Storage only issues to people the database lets see the Moment.
 * Replies don't go through here — they're direct messages (MessagesApi).
 */
import type { RealtimeChannel } from "@supabase/supabase-js";
import { groupMoments } from "../momentGroups";
import {
  MomentError,
  SupportError,
  type MediaItem,
  type Moment,
  type MomentAudience,
  type MomentBackground,
  type MomentGroup,
  type MomentReport,
  type MomentsAdminApi,
  type MomentsApi,
  type MessageReportReason,
  type Subscription,
} from "../types";
import { fetchAuthors, toAuthor, type Db } from "./queries";
import type { MediaStore } from "./mediaStore";
import { makePreview } from "../../lib/image";

type LiveQuery = <T>(name: string, fetcher: () => Promise<T>, sub: Subscription<T>, listen: (ch: RealtimeChannel, refresh: () => void) => RealtimeChannel) => () => void;

const BUCKET = "moment-media";
const URL_TTL_S = 60 * 60;

const CODES: Record<string, MomentError["code"]> = { MO001: "empty", MO002: "not-found", MO003: "not-allowed", MO004: "not-allowed" };
function fail(error: { code?: string; message: string }): never {
  if (error.code === "42501") throw new SupportError("not-admin", error.message);
  throw new MomentError(CODES[error.code ?? ""] ?? "unknown", error.message);
}

interface FeedRow {
  id: string;
  author_id: string;
  body: string;
  background: string;
  media_path: string | null;
  media_width: number | null;
  media_height: number | null;
  audience: string;
  created_at: string;
  expires_at: string;
  seen: boolean;
  my_reaction: string | null;
  view_count: number | null;
  // Migration 20261019100000 (absent on older databases).
  photo_fit?: "cover" | "contain";
  photo_zoom?: number;
  photo_x?: number;
  photo_y?: number;
  text_y?: number;
  media_preview?: string | null;
}

export function createSupabaseMoments(
  db: Db,
  liveQuery: LiveQuery,
  invalidate: () => void,
  { photos = true, media: store = null }: { photos?: boolean; media?: MediaStore | null } = {},
): { api: MomentsApi; admin: MomentsAdminApi } {
  async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    const { data, error } = await db.rpc(fn as never, args as never);
    if (error) fail(error);
    return data as T;
  }

  // Signed URLs, reused until shortly before they expire.
  const urls = new Map<string, { url: string; until: number }>();
  async function signed(paths: string[]): Promise<Map<string, string>> {
    const now = Date.now();
    // Media service (Neon): one same-origin URL per file, authorized on each request.
    if (store) return new Map(paths.map((p) => [p, store.url(p)] as const));
    const need = [...new Set(paths)].filter((p) => (urls.get(p)?.until ?? 0) < now + 60_000);
    if (need.length && photos) {
      const { data } = await db.storage.from(BUCKET).createSignedUrls(need, URL_TTL_S);
      for (const s of data ?? []) if (s.signedUrl && s.path) urls.set(s.path, { url: s.signedUrl, until: now + URL_TTL_S * 1000 });
    }
    return new Map(paths.flatMap((p) => (urls.has(p) ? [[p, urls.get(p)!.url] as const] : [])));
  }

  const media = (path: string | null, w: number | null, h: number | null, signedUrls: Map<string, string>): MediaItem | null =>
    path && signedUrls.has(path) ? { type: "image", url: signedUrls.get(path)!, width: w ?? undefined, height: h ?? undefined } : null;

  const withPreview = (m: MediaItem | null, preview: string | null | undefined): MediaItem | null => (m && preview ? { ...m, preview } : m);

  async function feed(viewerId: string): Promise<MomentGroup[]> {
    const rows = await rpc<FeedRow[]>("moments_feed");
    const [people, signedUrls] = await Promise.all([
      fetchAuthors(db, rows.map((r) => r.author_id)),
      signed(rows.flatMap((r) => (r.media_path ? [r.media_path] : []))),
    ]);
    const moments = rows.map(
      (r): Moment => ({
        id: r.id,
        author: people.get(r.author_id) ?? toAuthor(null),
        text: r.body,
        background: r.background as MomentBackground,
        media: withPreview(media(r.media_path, r.media_width, r.media_height, signedUrls), r.media_preview),
        audience: r.audience as MomentAudience,
        createdAt: new Date(r.created_at),
        expiresAt: new Date(r.expires_at),
        seen: r.seen,
        viewerReaction: r.my_reaction,
        viewCount: r.view_count ?? undefined,
        layout:
          r.photo_fit !== undefined
            ? { fit: r.photo_fit, zoom: r.photo_zoom ?? 1, x: r.photo_x ?? 0.5, y: r.photo_y ?? 0.5, textY: r.text_y ?? 0.5 }
            : undefined,
      }),
    );
    return groupMoments(moments, viewerId);
  }

  const api: MomentsApi = {
    photos,
    subscribeFeed: (viewerId, sub) =>
      liveQuery("moments", () => feed(viewerId), sub, (ch, refresh) => ch.on("postgres_changes", { event: "*", schema: "public", table: "moments" }, refresh)),

    async forAuthor(authorId, viewerId) {
      return (await feed(viewerId)).find((g) => g.author.id === authorId)?.moments ?? [];
    },

    async create(viewer, input) {
      let path: string | null = null;
      let preview: string | null = null;
      if (input.image && !photos) throw new MomentError("unknown", "Photo Moments aren't available yet");
      if (input.image && store) {
        // Keep the media error (its code says quota / too large) for the composer's message.
        [path, preview] = await Promise.all([store.upload("moment", input.image.blob), makePreview(input.image.blob).catch(() => null)]);
      } else if (input.image) {
        // Same processed photo as posts (src/lib/image.ts), into your own folder of the private bucket.
        const ext = input.image.blob.type === "image/png" ? "png" : input.image.blob.type === "image/gif" ? "gif" : input.image.blob.type === "image/webp" ? "webp" : "jpg";
        path = `${viewer.id}/${crypto.randomUUID()}.${ext}`;
        const { error } = await db.storage.from(BUCKET).upload(path, input.image.blob, { contentType: input.image.blob.type || "image/jpeg" });
        if (error) throw new MomentError("unknown", error.message);
      }
      try {
        const id = await rpc<string>("create_moment", {
          p_body: input.text.trim(),
          p_background: input.background,
          p_media_path: path,
          p_media_width: input.image?.width ?? null,
          p_media_height: input.image?.height ?? null,
          p_audience: input.audience,
          // Framing and preview (migration 20261019100000); left out when not set, for older databases.
          ...(input.layout ? { p_layout: input.layout } : {}),
          ...(preview ? { p_preview: preview } : {}),
        });
        invalidate();
        return { id };
      } catch (e) {
        if (path && !store) void db.storage.from(BUCKET).remove([path]);
        throw e;
      }
    },

    async delete(_viewerId, momentId) {
      const path = await rpc<string | null>("delete_moment", { p_moment: momentId });
      // With the media service the database queues the file for deletion itself.
      if (path && photos && !store) void db.storage.from(BUCKET).remove([path]);
      invalidate();
    },

    async markSeen(_viewerId, momentId) {
      await rpc("mark_moment_seen", { p_moment: momentId });
      invalidate();
    },

    async react(_viewerId, momentId, emoji) {
      await rpc("react_to_moment", { p_moment: momentId, p_emoji: emoji });
      invalidate();
    },

    async viewers(_viewerId, momentId) {
      const rows = await rpc<{ viewer_id: string; viewed_at: string; reaction: string | null }[]>("moment_viewers", { p_moment: momentId });
      const people = await fetchAuthors(db, rows.map((r) => r.viewer_id));
      return rows.map((r) => ({ person: people.get(r.viewer_id) ?? toAuthor(null), viewedAt: new Date(r.viewed_at), reaction: r.reaction }));
    },

    async report(_viewerId, momentId, input) {
      await rpc("report_moment", { p_moment: momentId, p_reason: input.reason, p_note: input.note });
    },
  };

  const admin: MomentsAdminApi = {
    async listReports() {
      const rows = await rpc<
        {
          id: string; reporter_id: string; reporter_username: string; reason: string; note: string; status: string; created_at: string;
          moment_id: string | null; author_id: string | null; body: string | null; background: string | null; media_path: string | null;
          media_width: number | null; media_height: number | null; moment_created_at: string | null; removed: boolean | null;
        }[]
      >("admin_moment_reports");
      const [people, signedUrls] = await Promise.all([
        fetchAuthors(db, rows.flatMap((r) => (r.author_id ? [r.author_id] : []))),
        signed(rows.flatMap((r) => (r.media_path ? [r.media_path] : []))),
      ]);
      return rows.map(
        (r): MomentReport => ({
          id: r.id,
          reporter: { id: r.reporter_id, handle: r.reporter_username },
          reason: r.reason as MessageReportReason,
          note: r.note,
          status: r.status === "reviewed" ? "reviewed" : "open",
          createdAt: new Date(r.created_at),
          moment:
            r.moment_id && r.author_id
              ? {
                  id: r.moment_id,
                  author: people.get(r.author_id) ?? toAuthor(null),
                  text: r.body ?? "",
                  media: media(r.media_path, r.media_width, r.media_height, signedUrls),
                  background: (r.background ?? "plain") as MomentBackground,
                  createdAt: new Date(r.moment_created_at!),
                  removed: !!r.removed,
                }
              : null,
        }),
      );
    },
    async remove(_adminId, momentId, note) {
      await rpc("admin_remove_moment", { p_moment: momentId, p_note: note });
      invalidate();
    },
    async setReportStatus(_adminId, reportId, status) {
      await rpc("admin_moment_report_set_status", { p_report: reportId, p_status: status });
      invalidate();
    },
  };

  return { api, admin };
}
