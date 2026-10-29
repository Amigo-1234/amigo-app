/**
 * Business profiles on Neon (migration 20261028130000_business_profiles.sql). Everything goes
 * through checked functions; nothing here can read who owns a business.
 */
import { BusinessError, type AdminBusiness, type Business, type BusinessApi, type BusinessCategory, type BusinessErrorCode, type MyBusiness } from "../types";
import { makePreview } from "../../lib/image";
import type { MediaStore } from "./mediaStore";
import { dataError, POST_SELECT, toPost, type Db, type PostRow } from "./queries";

const CODES: Record<string, BusinessErrorCode> = {
  BZ002: "handle",
  BZ003: "name",
  BZ005: "handle-too-soon",
  BZ006: "already-have-one",
  BZ007: "suspended",
  RL001: "slow-down",
  "22023": "invalid",
  "22001": "invalid",
};

async function call<T>(db: Db, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await db.rpc(fn as never, args as never);
  if (error) {
    // BZ001 is "not available yet" or "not eligible"; the message says which.
    const code = error.code === "BZ001" ? (/available/.test(error.message) ? "off" : "not-eligible") : CODES[error.code];
    if (code) throw new BusinessError(code, error.message);
    throw Object.assign(dataError(error), { code: error.code });
  }
  return data as T;
}

interface BusinessRow {
  id: string;
  handle: string;
  name: string;
  category: BusinessCategory;
  description: string;
  logo_url: string | null;
  cover_url: string | null;
  website_url: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  follower_count: number;
  post_count: number;
  created_at: string;
  following?: boolean;
  mine?: boolean;
  status?: "active" | "suspended";
  can_change_handle_at?: string;
}

const toBusiness = (r: BusinessRow): Business => ({
  id: r.id,
  handle: r.handle,
  name: r.name,
  category: r.category,
  description: r.description,
  logoUrl: r.logo_url,
  coverUrl: r.cover_url,
  website: r.website_url,
  email: r.contact_email,
  phone: r.contact_phone,
  followerCount: r.follower_count,
  postCount: Number(r.post_count ?? 0),
  createdAt: new Date(r.created_at),
  following: !!r.following,
  mine: !!r.mine,
});

const fields = (i: { name: string; category: string; description: string; website: string; email: string; phone: string }) => ({
  p_name: i.name,
  p_category: i.category,
  p_description: i.description,
  p_website: i.website || null,
  p_email: i.email || null,
  p_phone: i.phone || null,
});

export function createBusinessApi(db: Db, media: MediaStore, onPostsChanged: () => void): BusinessApi {
  let mineId: string | null = null;
  const myId = async () => mineId ?? (await api.mine()).business?.id ?? null;

  const api: BusinessApi = {
    async mine() {
      const r = await call<{ enabled: boolean; business: BusinessRow | null }>(db, "my_business");
      mineId = r.business?.id ?? null;
      const business: MyBusiness | null = r.business
        ? { ...toBusiness({ ...r.business, mine: true }), status: r.business.status ?? "active", canChangeHandleAt: new Date(r.business.can_change_handle_at ?? 0) }
        : null;
      return { enabled: !!r.enabled, business };
    },
    async create(input) {
      const id = await call<string>(db, "create_business", { p_handle: input.handle, ...fields(input) });
      mineId = id;
      return id;
    },
    async update(input) {
      await call(db, "update_business", { ...fields(input), p_handle: input.handle || null });
    },
    async remove() {
      await call(db, "delete_business");
      mineId = null;
      onPostsChanged();
    },
    async setImage(kind, image) {
      const businessId = await myId();
      if (!businessId) throw new BusinessError("unknown", "no business");
      const key = image ? await media.upload(kind === "logo" ? "business_logo" : "business_cover", image, { businessId }) : null;
      await call(db, "set_business_image", { p_kind: kind, p_key: key });
    },
    async byHandle(handle) {
      const rows = await call<BusinessRow[]>(db, "business_by_handle", { p_handle: handle });
      return rows[0] ? toBusiness(rows[0]) : null;
    },
    async posts(businessId, limit) {
      const { data, error } = await db
        .from("posts")
        .select(POST_SELECT)
        .eq("business_id" as never, businessId as never)
        .is("parent_id", null)
        .order("created_at", { ascending: false })
        .limit(limit)
        .returns<PostRow[]>();
      if (error) throw dataError(error);
      return data.map((r) => toPost(db, r, new Set()));
    },
    async search(query, category) {
      const rows = await call<BusinessRow[]>(db, "search_businesses", { p_query: query, p_category: category, p_limit: 30 });
      return rows.map((r) => {
        const b = toBusiness({ ...r, cover_url: null, website_url: null, contact_email: null, contact_phone: null, post_count: 0, created_at: new Date(0).toISOString() });
        return { id: b.id, handle: b.handle, name: b.name, category: b.category, description: b.description, logoUrl: b.logoUrl, followerCount: b.followerCount, following: b.following };
      });
    },
    async follow(businessId, follow) {
      const n = await call<number>(db, "follow_business", { p_business: businessId, p_follow: follow });
      onPostsChanged();
      return n;
    },
    async followedIds() {
      const ids = await call<string[]>(db, "my_followed_businesses");
      return new Set(ids);
    },
    async createPost(text, images) {
      const businessId = await myId();
      if (!businessId) throw new BusinessError("unknown", "no business");
      const items = await Promise.all(
        images.map(async (m) => {
          const [key, preview] = await Promise.all([media.upload("business_post", m.blob, { businessId }), makePreview(m.blob).catch(() => null)]);
          return { kind: "image", storage_path: key, mime_type: m.blob.type, width: m.width, height: m.height, byte_size: m.blob.size, preview, alt: m.alt ?? "" };
        }),
      );
      const id = await call<string>(db, "create_business_post", { p_body: text, p_media: items });
      onPostsChanged();
      return id;
    },
    async deletePost(postId) {
      await call(db, "delete_post", { p_post_id: postId });
      onPostsChanged();
    },
    admin: {
      async list(status) {
        const rows = await call<
          { id: string; handle: string; name: string; category: BusinessCategory; status: "active" | "suspended"; suspended_note: string | null;
            follower_count: number; post_count: number; owner_username: string; created_at: string }[]
        >(db, "admin_businesses", { p_status: status });
        return rows.map(
          (r): AdminBusiness => ({
            id: r.id, handle: r.handle, name: r.name, category: r.category, status: r.status, suspendedNote: r.suspended_note,
            followerCount: r.follower_count, postCount: Number(r.post_count), ownerHandle: r.owner_username, createdAt: new Date(r.created_at),
          }),
        );
      },
      async setStatus(businessId, suspend, note) {
        await call(db, "admin_set_business_status", { p_business: businessId, p_suspend: suspend, p_note: note });
        onPostsChanged();
      },
      async setEnabled(enabled) {
        await call(db, "admin_set_businesses_enabled", { p_enabled: enabled });
      },
    },
  };
  return api;
}
