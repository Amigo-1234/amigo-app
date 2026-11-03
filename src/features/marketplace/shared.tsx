import { useEffect, useSyncExternalStore } from "react";
import { Link } from "react-router";
import { Package } from "lucide-react";
import { dataSource, MarketplaceError, type ListingCard, type ListingCategory, type ListingCondition, type ListingFulfilment, type ListingPriceUnit, type ListingStatus } from "../../data";
import { MediaImg } from "../../lib/mediaLinks";
import "./Marketplace.css";

/** The Marketplace backend (null where it isn't built). */
export const marketApi = dataSource.marketplace ?? null;

// Feature switches and the category list: asked once, shared by every screen.
let features: string[] | null = null;
let categories: ListingCategory[] | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
function load(force = false) {
  if (!marketApi || (loading && !force)) return;
  loading = Promise.all([marketApi.features(), marketApi.categories()]).then(
    ([f, c]) => {
      features = f;
      categories = c;
      listeners.forEach((l) => l());
    },
    () => undefined,
  );
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Whether the Marketplace is switched on (null while unknown), and its categories. */
export function useMarketplace() {
  const f = useSyncExternalStore(subscribe, () => features);
  const c = useSyncExternalStore(subscribe, () => categories);
  useEffect(() => load(), []);
  return { enabled: f ? f.includes("marketplace") : marketApi ? null : false, categories: c ?? [], reload: () => load(true) };
}

const naira = new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", maximumFractionDigits: 0 });
const nairaKobo = new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", minimumFractionDigits: 2 });

const UNIT: Record<ListingPriceUnit, string> = { item: "", hour: " / hour", session: " / session", day: " / day", from: "" };

/** "₦15,000", "from ₦250,000", "₦25,000 / session", or "Price on request". */
export function formatPrice(minor: number | null, currency: string, unit: ListingPriceUnit) {
  if (minor === null) return "Price on request";
  const amount = currency === "NGN" ? (minor % 100 === 0 ? naira : nairaKobo).format(minor / 100) : `${(minor / 100).toFixed(2)} ${currency}`;
  return `${unit === "from" ? "from " : ""}${amount}${UNIT[unit]}`;
}

/** Naira text ("15,000" or "15000.50") to kobo; null when empty, NaN when not a price. */
export function parseNaira(text: string): number | null {
  const t = text.replace(/[₦,\s]/g, "");
  if (!t) return null;
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(t)) return Number.NaN;
  return Math.round(Number(t) * 100);
}

export const STATUS_LABEL: Record<ListingStatus, string> = {
  draft: "Draft",
  available: "Available",
  reserved: "Reserved",
  sold: "Sold",
  removed: "Removed by Amigo",
};

export const CONDITION_LABEL: Record<ListingCondition, string> = { new: "New", like_new: "Like new", good: "Good", fair: "Fair" };

export const FULFILMENT_LABEL: Record<ListingFulfilment, string> = {
  collection: "Collection",
  delivery: "Delivery",
  online: "Online",
  on_site: "In person",
};

export const UNIT_LABEL: Record<ListingPriceUnit, string> = { item: "Each", hour: "Per hour", session: "Per session", day: "Per day", from: "Starting from" };

export function marketErrorText(e: unknown): string {
  const code = e instanceof MarketplaceError ? e.code : "unknown";
  switch (code) {
    case "off":
      return "The Marketplace isn't available yet.";
    case "not-allowed":
      return "Only business pages can sell for now. Create a business page first.";
    case "invalid":
      return e instanceof MarketplaceError && e.message !== e.code ? capitalise(e.message) + "." : "Check the details and try again.";
    case "not-found":
      return "This listing isn't available.";
    case "removed":
      return "Amigo removed this listing, so it can't be changed.";
    case "suspended":
      return "This business is suspended. Contact Amigo support.";
    case "slow-down":
      return "You're doing that too often. Try again later.";
    default:
      return "Something went wrong. Try again.";
  }
}
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A listing in a grid: photo, price, title, seller. */
export function ListingTile({ listing, showBusiness = true }: { listing: ListingCard; showBusiness?: boolean }) {
  return (
    <Link to={`/l/${listing.id}`} className="mk-tile" aria-label={`${listing.title}, ${formatPrice(listing.priceMinor, listing.currency, listing.priceUnit)}`}>
      <span className="mk-tile__photo">
        {listing.coverUrl ? <MediaImg src={listing.coverUrl} size="sm" alt="" loading="lazy" decoding="async" /> : <Package aria-hidden="true" />}
        {listing.status !== "available" && <span className={`mk-badge mk-badge--${listing.status}`}>{STATUS_LABEL[listing.status]}</span>}
      </span>
      <span className="mk-tile__price">{formatPrice(listing.priceMinor, listing.currency, listing.priceUnit)}</span>
      <span className="mk-tile__title">{listing.title}</span>
      {showBusiness && (
        <span className="mk-tile__meta">
          {listing.business.name}
          {listing.area ? ` · ${listing.area}` : ""}
        </span>
      )}
    </Link>
  );
}

/** A listing shared in a post: the listing as it is now. */
export function ListingPostCard({ id, card }: { id: string; card: ListingCard | null }) {
  if (!card) {
    return (
      <p className="mk-postcard mk-postcard--gone" data-listing={id}>
        <Package size={18} aria-hidden="true" /> This listing is no longer available
      </p>
    );
  }
  return (
    <Link to={`/l/${card.id}`} className="mk-postcard">
      <span className="mk-postcard__photo">{card.coverUrl ? <MediaImg src={card.coverUrl} size="sm" alt="" loading="lazy" /> : <Package aria-hidden="true" />}</span>
      <span className="mk-postcard__text">
        <strong>{card.title}</strong>
        <span>
          {formatPrice(card.priceMinor, card.currency, card.priceUnit)}
          {card.status !== "available" && <span className={`mk-badge mk-badge--inline mk-badge--${card.status}`}>{STATUS_LABEL[card.status]}</span>}
        </span>
      </span>
    </Link>
  );
}
