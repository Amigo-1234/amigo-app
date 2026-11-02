import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ArrowLeft, Bookmark, CircleAlert, Package, Plus, Store } from "lucide-react";
import type { ListingCard, ListingKind, ListingSort } from "../data";
import { useMyBusiness } from "../features/business/useMyBusiness";
import { ListingTile, marketApi, marketErrorText, parseNaira, useMarketplace } from "../features/marketplace/shared";
import { ScreenHeader } from "../shell/ScreenHeader";
import { Button, IconButton } from "../ui/Button";
import { StateMessage } from "../ui/StateMessage";
import "./SettingsScreen.css";

const PAGE = 30;
const SORTS: { id: ListingSort; label: string }[] = [
  { id: "newest", label: "Newest" },
  { id: "updated", label: "Recently updated" },
  { id: "price_asc", label: "Price: low to high" },
  { id: "price_desc", label: "Price: high to low" },
  { id: "relevance", label: "Best match" },
];

/** /market (and /market/saved): find products and services from businesses on Amigo. */
export default function MarketplaceScreen({ saved = false }: { saved?: boolean }) {
  const navigate = useNavigate();
  const { enabled, categories } = useMarketplace();
  const { state: my } = useMyBusiness();
  const [params, setParams] = useSearchParams();
  const kind = (params.get("kind") as ListingKind | null) ?? null;
  const category = params.get("category");
  const sort = (params.get("sort") as ListingSort | null) ?? "newest";
  const [typed, setTyped] = useState(params.get("q") ?? "");
  const [query, setQuery] = useState(typed.trim());
  const [minText, setMinText] = useState("");
  const [maxText, setMaxText] = useState("");
  const [area, setArea] = useState("");
  const [rows, setRows] = useState<ListingCard[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);

  const set = (key: string, value: string | null) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (value) n.set(key, value);
        else n.delete(key);
        if (key === "kind") n.delete("category");
        return n;
      },
      { replace: true },
    );

  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(typed.trim());
      set("q", typed.trim() || null);
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed]);

  const min = parseNaira(minText);
  const max = parseNaira(maxText);
  const priceOk = !Number.isNaN(min) && !Number.isNaN(max);

  useEffect(() => {
    if (!marketApi || enabled === false || !priceOk) return;
    let live = true;
    setRows(null);
    setError(null);
    const run = saved
      ? marketApi.saved()
      : marketApi.search({ query, kind, categoryId: category, sort, minPrice: min, maxPrice: max, area }, PAGE + 1);
    run.then(
      (r) => {
        if (!live) return;
        setMore(!saved && r.length > PAGE);
        setRows(r.slice(0, PAGE));
      },
      (e) => live && setError(e ?? new Error("failed")),
    );
    return () => {
      live = false;
    };
  }, [saved, query, kind, category, sort, min, max, area, enabled, priceOk, attempt]);

  const loadMore = async () => {
    if (!rows) return;
    const next = await marketApi!.search({ query, kind, categoryId: category, sort, minPrice: min, maxPrice: max, area, offset: rows.length }, PAGE + 1);
    setMore(next.length > PAGE);
    setRows([...rows, ...next.slice(0, PAGE)]);
  };

  const header = (
    <ScreenHeader
      title={saved ? "Saved listings" : "Marketplace"}
      leading={
        <IconButton label="Back" onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate(saved ? "/market" : "/explore"))} className="back-btn">
          <ArrowLeft size={22} />
        </IconButton>
      }
      actions={
        !saved ? (
          <Link to="/market/saved" className="icon-btn icon-btn--md" aria-label="Saved listings" title="Saved listings">
            <Bookmark size={21} aria-hidden="true" />
          </Link>
        ) : undefined
      }
    />
  );

  if (enabled === false) {
    return (
      <>
        {header}
        <StateMessage icon={<Package size={24} />} title="The Marketplace isn't open yet" body="Soon you'll be able to find products and services from businesses on Amigo here." />
      </>
    );
  }

  const shownCategories = categories.filter((c) => !kind || c.kind === kind);

  return (
    <>
      {header}
      <div className="mk-page">
        {!saved && (
          <>
            {my?.business ? (
              <p className="mk-note">
                Selling? <Link to="/market/sell">Add a listing</Link> for {my.business.name}.
              </p>
            ) : (
              my?.enabled && (
                <p className="mk-note">
                  Sell on Amigo with a <Link to="/settings/business">business page</Link>.
                </p>
              )
            )}
            <div className="mk-search">
              <label className="field" style={{ flex: 1 }}>
                <span className="visually-hidden">Search the Marketplace</span>
                <input className="field__input" type="search" placeholder="Search products and services" value={typed} maxLength={100} onChange={(e) => setTyped(e.target.value)} />
              </label>
              {my?.business && (
                <Button icon={<Plus size={18} aria-hidden="true" />} onClick={() => navigate("/market/sell")}>
                  Sell
                </Button>
              )}
            </div>
            <div className="mk-chips" role="group" aria-label="Kind">
              {([null, "product", "service"] as const).map((k) => (
                <button key={k ?? "all"} type="button" className="mk-chip" aria-pressed={kind === k} onClick={() => set("kind", k)}>
                  {k === null ? "Everything" : k === "product" ? "Products" : "Services"}
                </button>
              ))}
            </div>
            <div className="mk-chips" role="group" aria-label="Categories">
              {shownCategories.map((c) => (
                <button key={c.id} type="button" className="mk-chip" aria-pressed={category === c.id} onClick={() => set("category", category === c.id ? null : c.id)}>
                  {c.label}
                </button>
              ))}
            </div>
            <div className="mk-filters">
              <label className="field">
                <span className="visually-hidden">Lowest price in naira</span>
                <input className="field__input" inputMode="decimal" placeholder="Min ₦" value={minText} onChange={(e) => setMinText(e.target.value)} aria-invalid={Number.isNaN(min)} />
              </label>
              <label className="field">
                <span className="visually-hidden">Highest price in naira</span>
                <input className="field__input" inputMode="decimal" placeholder="Max ₦" value={maxText} onChange={(e) => setMaxText(e.target.value)} aria-invalid={Number.isNaN(max)} />
              </label>
              <label className="field">
                <span className="visually-hidden">Area</span>
                <input className="field__input" placeholder="Area, e.g. Lekki" value={area} maxLength={60} onChange={(e) => setArea(e.target.value)} />
              </label>
              <label className="field">
                <span className="visually-hidden">Sort</span>
                <select className="field__input" value={sort} onChange={(e) => set("sort", e.target.value === "newest" ? null : e.target.value)}>
                  {SORTS.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {!priceOk && <p className="form-error">Prices are numbers in naira, like 15000.</p>}
          </>
        )}

        {error ? (
          <StateMessage tone="error" icon={<CircleAlert size={24} />} title="Couldn't load listings" body={marketErrorText(error)} action={<Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>Try again</Button>} />
        ) : !rows ? (
          <p className="settings-muted" aria-busy="true">Loading…</p>
        ) : rows.length === 0 ? (
          saved ? (
            <StateMessage icon={<Bookmark size={24} />} title="No saved listings" body="Tap Save on a listing to keep it here. Only you can see what you save." />
          ) : (
            <StateMessage icon={<Store size={24} />} title="Nothing found" body={query || category || kind || area || min !== null || max !== null ? "Try other words, or clear a filter." : "Listings from businesses will show up here."} />
          )
        ) : (
          <>
            <ul className="mk-grid" aria-label="Listings">
              {rows.map((l) => (
                <li key={l.id}>
                  <ListingTile listing={l} />
                </li>
              ))}
            </ul>
            {more && (
              <Button variant="secondary" onClick={() => void loadMore()}>
                Show more
              </Button>
            )}
          </>
        )}
      </div>
    </>
  );
}
