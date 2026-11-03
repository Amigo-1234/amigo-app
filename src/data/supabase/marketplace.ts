/**
 * Marketplace on Neon (migration 20261102090000_marketplace.sql). Reads and writes go through
 * checked functions; listing photos are business files uploaded through the media service.
 */
import {
  MarketplaceError,
  type AdminListing,
  type Listing,
  type ListingCard,
  type ListingInput,
  type ListingStatus,
  type MarketplaceApi,
  type MarketplaceErrorCode,
} from "../types";
import { makePreview } from "../../lib/image";
import type { MediaStore } from "./mediaStore";
import { dataError, type Db } from "./queries";

const CODES: Record<string, MarketplaceErrorCode> = {
  MK001: "off",
  MK002: "invalid",
  MK003: "not-found",
  MK004: "removed",
  BZ007: "suspended",
  RL001: "slow-down",
  MD001: "not-allowed",
  MD002: "invalid",
  "22023": "invalid",
};

async function call<T>(db: Db, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await db.rpc(fn as never, args as never);
  if (error) {
    const code = CODES[error.code];
    // MK001 is "not available yet" or "create a business page first"; the message says which.
    if (code === "off" && !/available/.test(error.message)) throw new MarketplaceError("not-allowed", error.message);
    if (code) throw new MarketplaceError(code, error.message);
    throw Object.assign(dataError(error), { code: error.code });
  }
  return data as T;
}

interface SearchRow {
  id: string;
  business_id: string;
  business_handle: string;
  business_name: string;
  business_logo: string | null;
  kind: ListingCard["kind"];
  title: string;
  category_id: string;
  section: string | null;
  price_minor: number | null;
  currency: string;
  price_unit: ListingCard["priceUnit"];
  condition: ListingCard["condition"];
  status: ListingStatus;
  area: string | null;
  cover_path: string | null;
  cover_preview: string | null;
  save_count: number;
  saved: boolean;
  created_at: string;
  updated_at: string;
}

interface ListingRow {
  id: string;
  business_id: string;
  kind: ListingCard["kind"];
  title: string;
  description: string;
  category_id: string;
  section: string | null;
  price_minor: number | null;
  currency: string;
  price_unit: ListingCard["priceUnit"];
  condition: ListingCard["condition"];
  status: ListingStatus;
  area: string | null;
  fulfilment: Listing["fulfilment"];
  delivery_note: string | null;
  save_count: number;
  created_at: string;
  updated_at: string;
  removed_by_admin_at?: string | null;
}

export function createMarketplaceApi(db: Db, media: MediaStore, myBusinessId: () => Promise<string | null>, onChanged: () => void): MarketplaceApi {
  const url = (key: string | null) => (key ? media.url(key) : null);
  const card = (r: SearchRow): ListingCard => ({
    id: r.id,
    title: r.title,
    kind: r.kind,
    categoryId: r.category_id,
    section: r.section,
    priceMinor: r.price_minor === null ? null : Number(r.price_minor),
    currency: r.currency,
    priceUnit: r.price_unit,
    condition: r.condition,
    status: r.status,
    area: r.area,
    coverUrl: url(r.cover_path),
    coverPreview: r.cover_preview,
    saveCount: r.save_count,
    saved: r.saved,
    business: { id: r.business_id, handle: r.business_handle, name: r.business_name, logoUrl: r.business_logo },
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  });

  /** Photos in order: kept ones by key; new ones are uploaded now (with their small copy and preview). */
  async function photos(input: ListingInput) {
    const needsUpload = input.photos.some((p) => !("key" in p));
    const businessId = needsUpload ? await myBusinessId() : null;
    if (needsUpload && !businessId) throw new MarketplaceError("not-allowed", "create a business page first");
    return Promise.all(
      input.photos.map(async (p) => {
        if ("key" in p) return { storage_path: p.key };
        const [key, preview] = await Promise.all([
          media.upload("business_listing", p.blob, { businessId: businessId! }),
          makePreview(p.blob).catch(() => null),
        ]);
        return { storage_path: key, mime_type: p.blob.type, width: p.width, height: p.height, alt: p.alt ?? "", preview };
      }),
    );
  }

  const fields = (i: ListingInput) => ({
    p_kind: i.kind,
    p_title: i.title.trim(),
    p_description: i.description.trim(),
    p_category: i.categoryId,
    p_price_minor: i.priceMinor,
    p_price_unit: i.priceUnit,
    p_condition: i.kind === "product" ? i.condition : null,
    p_section: i.section.trim() || null,
    p_area: i.area.trim() || null,
    p_fulfilment: i.fulfilment,
    p_delivery_note: i.deliveryNote.trim() || null,
    p_status: i.status,
  });

  const api: MarketplaceApi = {
    features: () => call<string[]>(db, "enabled_features"),
    categories: () => call(db, "listing_category_list"),
    async search(p, limit) {
      const rows = await call<SearchRow[]>(db, "search_listings", {
        p_query: p.query ?? "",
        p_category: p.categoryId ?? null,
        p_kind: p.kind ?? null,
        p_min_price: p.minPrice ?? null,
        p_max_price: p.maxPrice ?? null,
        p_area: p.area?.trim() || null,
        p_condition: p.condition ?? null,
        p_business: p.businessId ?? null,
        p_sort: p.sort ?? "newest",
        p_limit: limit,
        p_offset: p.offset ?? 0,
      });
      return rows.map(card);
    },
    async get(id) {
      const v = await call<{
        listing: ListingRow;
        removed_by_admin: boolean;
        business: { id: string; handle: string; name: string; logo_url: string | null; area: string | null; website_url: string | null; contact_email: string | null; contact_phone: string | null };
        media: { storage_path: string; width: number | null; height: number | null; alt: string | null; preview: string | null }[];
        saved: boolean;
        mine: boolean;
      } | null>(db, "listing_view", { p_listing: id });
      if (!v) return null;
      const l = v.listing;
      return {
        ...card({
          ...l,
          business_handle: v.business.handle,
          business_name: v.business.name,
          business_logo: v.business.logo_url,
          cover_path: v.media[0]?.storage_path ?? null,
          cover_preview: v.media[0]?.preview ?? null,
          saved: v.saved,
        }),
        description: l.description,
        fulfilment: l.fulfilment ?? [],
        deliveryNote: l.delivery_note,
        photos: v.media.map((m) => ({ url: media.url(m.storage_path), key: m.storage_path, width: m.width, height: m.height, alt: m.alt, preview: m.preview })),
        mine: v.mine,
        removedByAdmin: v.removed_by_admin,
        businessContact: { area: v.business.area, website: v.business.website_url, email: v.business.contact_email, phone: v.business.contact_phone },
      };
    },
    async mine() {
      const rows = await call<ListingRow[]>(db, "my_listings");
      const b = await myBusinessId();
      return rows.map((r) => ({
        ...card({ ...r, business_id: b ?? r.business_id, business_handle: "", business_name: "", business_logo: null, cover_path: null, cover_preview: null, saved: false }),
        removedByAdmin: !!r.removed_by_admin_at,
      }));
    },
    async create(input) {
      const media_ = await photos(input);
      const id = await call<string>(db, "create_listing", { ...fields(input), p_media: media_ });
      onChanged();
      return id;
    },
    async update(id, input) {
      const media_ = await photos(input);
      await call(db, "update_listing", { p_listing: id, ...fields(input), p_media: media_ });
      onChanged();
    },
    async setStatus(id, status) {
      await call(db, "set_listing_status", { p_listing: id, p_status: status });
      onChanged();
    },
    async remove(id) {
      await call(db, "delete_listing", { p_listing: id });
      onChanged();
    },
    save: (id, saved) => call<number>(db, "save_listing", { p_listing: id, p_save: saved }),
    async saved() {
      const ids = await call<string[]>(db, "my_saved_listings");
      const cards = await Promise.all(ids.slice(0, 60).map((id) => api.get(id)));
      return cards.filter((c): c is Listing => !!c);
    },
    admin: {
      async list(status, query) {
        const rows = await call<
          { id: string; title: string; status: ListingStatus; kind: AdminListing["kind"]; price_minor: number | null; currency: string; business_id: string;
            business_handle: string; business_name: string; owner_username: string; removed_note: string | null; open_reports: number; created_at: string }[]
        >(db, "admin_listings", { p_status: status, p_query: query });
        return rows.map(
          (r): AdminListing => ({
            id: r.id, title: r.title, status: r.status, kind: r.kind, priceMinor: r.price_minor === null ? null : Number(r.price_minor), currency: r.currency,
            business: { id: r.business_id, handle: r.business_handle, name: r.business_name }, ownerHandle: r.owner_username,
            removedNote: r.removed_note, openReports: Number(r.open_reports), createdAt: new Date(r.created_at),
          }),
        );
      },
      async remove(id, note) {
        await call(db, "admin_remove_listing", { p_listing: id, p_note: note });
        onChanged();
      },
      async restore(id) {
        await call(db, "admin_restore_listing", { p_listing: id });
        onChanged();
      },
      setFeature: (key, enabled) => call(db, "admin_set_feature", { p_key: key, p_enabled: enabled }),
    },
  };
  return api;
}
