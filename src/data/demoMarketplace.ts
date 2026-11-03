/**
 * Marketplace in demo mode: in memory, for UI work and browser tests. Off unless the page is
 * opened with ?demo=market (as on a real backend, where an admin switches it on).
 */
import type { DemoBusinessBridge } from "./demoBusiness";
import {
  MarketplaceError,
  type AdminListing,
  type Listing,
  type ListingCard,
  type ListingCategory,
  type ListingInput,
  type ListingPhoto,
  type ListingStatus,
  type MarketplaceApi,
  type Viewer,
} from "./types";

const CATEGORIES: ListingCategory[] = [
  { id: "phones_electronics", label: "Phones & electronics", kind: "product" },
  { id: "computers", label: "Computers & accessories", kind: "product" },
  { id: "fashion", label: "Fashion & accessories", kind: "product" },
  { id: "beauty", label: "Beauty & personal care", kind: "product" },
  { id: "home", label: "Home, furniture & appliances", kind: "product" },
  { id: "food_groceries", label: "Food & groceries", kind: "product" },
  { id: "health_wellness", label: "Health & wellness", kind: "product" },
  { id: "baby_kids", label: "Babies & kids", kind: "product" },
  { id: "sports_outdoors", label: "Sports & outdoors", kind: "product" },
  { id: "vehicle_parts", label: "Vehicle parts & accessories", kind: "product" },
  { id: "books_art", label: "Books, art & crafts", kind: "product" },
  { id: "other_products", label: "Other products", kind: "product" },
  { id: "food_catering", label: "Food & catering", kind: "service" },
  { id: "beauty_services", label: "Hair, beauty & grooming", kind: "service" },
  { id: "events_media", label: "Events, photography & media", kind: "service" },
  { id: "repairs", label: "Repairs & maintenance", kind: "service" },
  { id: "lessons", label: "Lessons & tutoring", kind: "service" },
  { id: "professional", label: "Professional services", kind: "service" },
  { id: "design_tech", label: "Design, web & tech", kind: "service" },
  { id: "delivery", label: "Delivery & logistics", kind: "service" },
  { id: "other_services", label: "Other services", kind: "service" },
];

type Rec = Omit<Listing, "saved" | "mine" | "business" | "businessContact" | "coverUrl" | "coverPreview" | "saveCount"> & {
  businessId: string;
  removedNote: string | null;
};

export function createDemoMarketplace(deps: {
  enabled: boolean;
  viewer: () => Viewer;
  later: <T>(fn: () => T, ms?: number) => Promise<T>;
  businesses: DemoBusinessBridge;
}): MarketplaceApi {
  let enabled = deps.enabled;
  const days = (n: number) => new Date(Date.now() - n * 86_400_000);
  const base = (id: string, businessId: string, over: Partial<Rec>): Rec => ({
    id, businessId, kind: "product", title: "", description: "", categoryId: "other_products", section: null, priceMinor: null, currency: "NGN",
    priceUnit: "item", condition: null, status: "available", area: null, fulfilment: [], deliveryNote: null, photos: [],
    removedByAdmin: false, removedNote: null, createdAt: days(1), updatedAt: days(1), ...over,
  });
  const recs: Rec[] = [
    base("lst-jollof", "biz-kitchen", { kind: "product", title: "Party jollof tray (serves 10)", description: "Smoky party jollof with grilled chicken and plantain. Order 24 hours ahead.", categoryId: "food_groceries", section: "Trays", priceMinor: 3500000, area: "Victoria Island, Lagos", fulfilment: ["delivery", "collection"], deliveryNote: "Delivery across the island", createdAt: days(2), updatedAt: days(2) }),
    base("lst-suya", "biz-kitchen", { kind: "product", title: "Beef suya (large)", description: "Spicy, fresh off the grill.", categoryId: "food_groceries", section: "Grill", priceMinor: 450000, area: "Victoria Island, Lagos", fulfilment: ["collection"], createdAt: days(4), updatedAt: days(4) }),
    base("lst-catering", "biz-kitchen", { kind: "service", title: "Event catering", description: "Weddings, birthdays and office lunches.", categoryId: "food_catering", priceMinor: 25000000, priceUnit: "from", area: "Lagos", fulfilment: ["on_site"], createdAt: days(6), updatedAt: days(6) }),
    base("lst-portrait", "biz-studio", { kind: "service", title: "Portrait session", description: "One hour in studio, 10 edited photos.", categoryId: "events_media", priceMinor: 2500000, priceUnit: "session", area: "Yaba, Lagos", fulfilment: ["on_site"], createdAt: days(3), updatedAt: days(3) }),
    base("lst-screen", "biz-tech", { kind: "service", title: "iPhone screen replacement", description: "Most models, same day.", categoryId: "repairs", priceMinor: 6000000, priceUnit: "from", area: "Ikeja, Lagos", fulfilment: ["on_site"], createdAt: days(1), updatedAt: days(1) }),
    base("lst-case", "biz-tech", { kind: "product", title: "Phone case (used)", description: "Clear case, iPhone 13.", categoryId: "phones_electronics", priceMinor: 300000, condition: "good", status: "sold", area: "Ikeja, Lagos", fulfilment: ["collection"], createdAt: days(9), updatedAt: days(5) }),
  ];
  const saves = new Map<string, Set<string>>([["lst-portrait", new Set(["someone"])]]);
  const me = () => deps.viewer().id;
  const isAdmin = () => true; // the demo signs you in as the owner account (an admin)
  const biz = (id: string) => deps.businesses.records().find((b) => b.id === id);
  const live = (r: Rec) => biz(r.businessId)?.status === "active";
  const visible = (r: Rec) => (enabled || isAdmin()) && (r.status === "draft" ? biz(r.businessId)?.ownerId === me() : r.status !== "removed" && live(r));
  const savedBy = (id: string) => saves.get(id) ?? new Set<string>();

  const card = (r: Rec): ListingCard => {
    const b = biz(r.businessId)!;
    return {
      id: r.id, title: r.title, kind: r.kind, categoryId: r.categoryId, section: r.section, priceMinor: r.priceMinor, currency: r.currency,
      priceUnit: r.priceUnit, condition: r.condition, status: r.status, area: r.area,
      coverUrl: r.photos[0]?.url ?? null, coverPreview: null, saveCount: savedBy(r.id).size, saved: savedBy(r.id).has(me()),
      business: { id: b.id, handle: b.handle, name: b.name, logoUrl: b.logoUrl }, createdAt: r.createdAt, updatedAt: r.updatedAt,
    };
  };
  deps.businesses.listingCard = (id) => {
    const r = recs.find((x) => x.id === id);
    return r && visible(r) ? card(r) : null;
  };
  deps.businesses.listingCount = (businessId) =>
    enabled || isAdmin() ? recs.filter((r) => r.businessId === businessId && (r.status === "available" || r.status === "reserved")).length : 0;

  const mineOrThrow = (id: string) => {
    const r = recs.find((x) => x.id === id);
    if (!r || biz(r.businessId)?.ownerId !== me()) throw new MarketplaceError("not-found");
    if (!live(r)) throw new MarketplaceError("suspended");
    if (r.removedByAdmin) throw new MarketplaceError("removed");
    return r;
  };
  const check = (i: ListingInput) => {
    const c = CATEGORIES.find((x) => x.id === i.categoryId);
    if (!c || c.kind !== i.kind) throw new MarketplaceError("invalid", "choose a category for this kind of listing");
    if (i.title.trim().length < 3 || i.title.trim().length > 80) throw new MarketplaceError("invalid", "check the details");
    if (i.priceMinor !== null && i.priceMinor < 0) throw new MarketplaceError("invalid", "check the details");
    if (i.photos.length > 8) throw new MarketplaceError("invalid", "at most 8 photos");
  };
  const toPhotos = (i: ListingInput, old: ListingPhoto[]): ListingPhoto[] =>
    i.photos.map((p) =>
      "key" in p
        ? (old.find((o) => o.key === p.key) ?? { url: p.key, key: p.key, width: null, height: null, alt: null, preview: null })
        : { url: URL.createObjectURL(p.blob), key: `demo-${Math.random().toString(16).slice(2)}`, width: p.width, height: p.height, alt: p.alt ?? null, preview: null },
    );

  const api: MarketplaceApi = {
    features: () => deps.later(() => (enabled ? ["marketplace"] : []), 50),
    categories: () => deps.later(() => CATEGORIES, 50),
    search: (p, limit) =>
      deps.later(() => {
        if (!enabled && !isAdmin()) return [];
        const words = (p.query ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
        const out = recs.filter(
          (r) =>
            (r.status === "available" || r.status === "reserved") && live(r) &&
            words.every((w) => `${r.title} ${r.section ?? ""} ${r.description}`.toLowerCase().split(/[^\p{L}\p{N}]+/u).some((t) => t.startsWith(w))) &&
            (!p.categoryId || r.categoryId === p.categoryId) && (!p.kind || r.kind === p.kind) &&
            (p.minPrice == null || (r.priceMinor ?? -1) >= p.minPrice) && (p.maxPrice == null || (r.priceMinor !== null && r.priceMinor <= p.maxPrice)) &&
            (!p.area?.trim() || (r.area ?? "").toLowerCase().includes(p.area.trim().toLowerCase())) &&
            (!p.condition || r.condition === p.condition) && (!p.businessId || r.businessId === p.businessId),
        );
        const by = p.sort ?? "newest";
        out.sort((a, b) =>
          by === "price_asc" ? (a.priceMinor ?? Infinity) - (b.priceMinor ?? Infinity)
          : by === "price_desc" ? (b.priceMinor ?? -1) - (a.priceMinor ?? -1)
          : by === "updated" ? b.updatedAt.getTime() - a.updatedAt.getTime()
          : b.createdAt.getTime() - a.createdAt.getTime(),
        );
        return out.slice(p.offset ?? 0, (p.offset ?? 0) + limit).map(card);
      }),
    get: (id) =>
      deps.later(() => {
        const r = recs.find((x) => x.id === id);
        const b = r && biz(r.businessId);
        if (!r || !b) return null;
        const mine = b.ownerId === me();
        if (!visible(r) && !(mine && (enabled || isAdmin()))) return null;
        return {
          ...card(r), description: r.description, fulfilment: r.fulfilment, deliveryNote: r.deliveryNote, photos: r.photos, mine,
          removedByAdmin: r.removedByAdmin, businessContact: { area: b.area ?? null, website: b.website, email: b.email, phone: b.phone },
        };
      }),
    mine: () =>
      deps.later(() => {
        const b = deps.businesses.mine();
        if (!b) return [];
        return recs.filter((r) => r.businessId === b.id).sort((x, y) => y.updatedAt.getTime() - x.updatedAt.getTime()).map((r) => ({ ...card(r), removedByAdmin: r.removedByAdmin }));
      }),
    create: (input) =>
      deps.later(() => {
        if (!enabled && !isAdmin()) throw new MarketplaceError("off");
        const b = deps.businesses.mine();
        if (!b) throw new MarketplaceError("not-allowed", "create a business page first");
        if (b.status !== "active") throw new MarketplaceError("suspended");
        check(input);
        const id = `lst-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
        recs.push(base(id, b.id, {
          kind: input.kind, title: input.title.trim(), description: input.description.trim(), categoryId: input.categoryId, section: input.section.trim() || null,
          priceMinor: input.priceMinor, priceUnit: input.priceUnit, condition: input.kind === "product" ? input.condition : null, status: input.status,
          area: input.area.trim() || b.area || null, fulfilment: input.fulfilment, deliveryNote: input.deliveryNote.trim() || null,
          photos: toPhotos(input, []), createdAt: new Date(), updatedAt: new Date(),
        }));
        return id;
      }),
    update: (id, input) =>
      deps.later(() => {
        const r = mineOrThrow(id);
        check(input);
        Object.assign(r, {
          kind: input.kind, title: input.title.trim(), description: input.description.trim(), categoryId: input.categoryId, section: input.section.trim() || null,
          priceMinor: input.priceMinor, priceUnit: input.priceUnit, condition: input.kind === "product" ? input.condition : null, status: input.status,
          area: input.area.trim() || null, fulfilment: input.fulfilment, deliveryNote: input.deliveryNote.trim() || null,
          photos: toPhotos(input, r.photos), updatedAt: new Date(),
        });
      }),
    setStatus: (id, status) =>
      deps.later(() => {
        const r = mineOrThrow(id);
        r.status = status;
        r.updatedAt = new Date();
      }),
    remove: (id) =>
      deps.later(() => {
        const r = mineOrThrow(id);
        recs.splice(recs.indexOf(r), 1);
        deps.businesses.listingDeleted(id);
      }),
    save: (id, saved) =>
      deps.later(() => {
        const r = recs.find((x) => x.id === id);
        if (!r || !visible(r) || r.status === "draft") throw new MarketplaceError("not-found");
        const s = saves.get(id) ?? new Set<string>();
        if (saved) s.add(me());
        else s.delete(me());
        saves.set(id, s);
        return s.size;
      }, 150),
    saved: () => deps.later(() => recs.filter((r) => savedBy(r.id).has(me()) && visible(r)).map(card)),
    admin: {
      list: (status, query) =>
        deps.later(() =>
          recs
            .filter((r) => (status === "all" || r.status === status) && (!query.trim() || r.title.toLowerCase().includes(query.trim().toLowerCase())))
            .map((r): AdminListing => {
              const b = biz(r.businessId)!;
              return {
                id: r.id, title: r.title, status: r.status, kind: r.kind, priceMinor: r.priceMinor, currency: r.currency,
                business: { id: b.id, handle: b.handle, name: b.name }, ownerHandle: b.ownerId, removedNote: r.removedNote, openReports: 0, createdAt: r.createdAt,
              };
            }),
        ),
      remove: (id, note) =>
        deps.later(() => {
          const r = recs.find((x) => x.id === id);
          if (!r) throw new MarketplaceError("not-found");
          r.status = "removed" as ListingStatus;
          r.removedByAdmin = true;
          r.removedNote = note.trim() || null;
        }),
      restore: (id) =>
        deps.later(() => {
          const r = recs.find((x) => x.id === id);
          if (!r?.removedByAdmin) throw new MarketplaceError("not-found");
          r.status = "draft";
          r.removedByAdmin = false;
          r.removedNote = null;
        }),
      setFeature: (key, on) =>
        deps.later(() => {
          if (key === "marketplace") enabled = on;
        }),
    },
  };
  return api;
}
