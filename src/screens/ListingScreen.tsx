import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowLeft, Bookmark, CircleAlert, Flag, Globe, Link2, Mail, Package, Pencil, Phone, Trash2 } from "lucide-react";
import { dataSource, type Listing, type ListingStatus } from "../data";
import { BusinessLogo } from "../features/business/shared";
import { CONDITION_LABEL, FULFILMENT_LABEL, formatPrice, marketApi, marketErrorText, STATUS_LABEL, useMarketplace } from "../features/marketplace/shared";
import { ReportForm } from "../features/posts/PostOptions";
import { MediaImg } from "../lib/mediaLinks";
import { publicUrl } from "../lib/publicUrl";
import { timeAgoLong } from "../lib/time";
import { ScreenHeader } from "../shell/ScreenHeader";
import { useToast } from "../state/toast";
import { Button, IconButton } from "../ui/Button";
import { Sheet } from "../ui/Sheet";
import { StateMessage } from "../ui/StateMessage";
import "./SettingsScreen.css";

/** /l/:id — one listing: photos, price, details, the business selling it. */
export default function ListingScreen() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { categories } = useMarketplace();
  const [listing, setListing] = useState<Listing | null | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setListing(undefined);
    setError(null);
    marketApi!.get(id).then(
      (l) => live && setListing(l),
      (e) => live && setError(e ?? new Error("failed")),
    );
    return () => {
      live = false;
    };
  }, [id, attempt]);

  const back = () => (window.history.state?.idx > 0 ? navigate(-1) : navigate("/market"));
  return (
    <>
      <ScreenHeader
        title={listing ? listing.title : "Listing"}
        leading={
          <IconButton label="Back" onClick={back} className="back-btn">
            <ArrowLeft size={22} />
          </IconButton>
        }
      />
      {error ? (
        <StateMessage tone="error" icon={<CircleAlert size={24} />} title="Couldn't load this listing" body={marketErrorText(error)} action={<Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>Try again</Button>} />
      ) : listing === undefined ? (
        <p className="settings-muted" aria-busy="true" style={{ padding: 16 }}>Loading…</p>
      ) : listing === null ? (
        <StateMessage icon={<Package size={24} />} title="This listing isn't available" body="It may have been sold and removed, or the link is wrong." action={<Button variant="secondary" onClick={() => navigate("/market")}>Browse the Marketplace</Button>} />
      ) : (
        <ListingBody listing={listing} categoryLabel={categories.find((c) => c.id === listing.categoryId)?.label ?? ""} onChange={setListing} />
      )}
    </>
  );
}

function ListingBody({ listing, categoryLabel, onChange }: { listing: Listing; categoryLabel: string; onChange: (l: Listing | null) => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [sheet, setSheet] = useState<null | "report" | "delete">(null);
  const c = listing.businessContact;

  const toggleSave = async () => {
    setBusy("save");
    try {
      const count = await marketApi!.save(listing.id, !listing.saved);
      onChange({ ...listing, saved: !listing.saved, saveCount: count });
      toast(listing.saved ? "Removed from saved" : "Saved. Find it in Marketplace → Saved");
    } catch (e) {
      toast(marketErrorText(e), "error");
    } finally {
      setBusy(null);
    }
  };
  const setStatus = async (status: Exclude<ListingStatus, "removed">) => {
    setBusy("status");
    try {
      await marketApi!.setStatus(listing.id, status);
      onChange({ ...listing, status });
      toast(`Marked ${STATUS_LABEL[status].toLowerCase()}`);
    } catch (e) {
      toast(marketErrorText(e), "error");
    } finally {
      setBusy(null);
    }
  };
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(publicUrl(`/l/${listing.id}`));
      toast("Link copied");
    } catch {
      toast("Couldn't copy the link", "error");
    }
  };

  return (
    <article className="mk-page" aria-labelledby="listing-title">
      {listing.removedByAdmin && <p className="form-error">Amigo removed this listing. Only your business can see it, and it can't be changed.</p>}
      {listing.photos.length ? (
        <div className="mk-gallery" aria-label={`${listing.photos.length} photos`}>
          {listing.photos.map((p, i) => (
            <div key={p.key} className="mk-gallery__item">
              <MediaImg src={p.url} alt={p.alt ?? `${listing.title}, photo ${i + 1}`} decoding="async" />
            </div>
          ))}
        </div>
      ) : (
        <div className="mk-gallery__empty">
          <Package size={36} aria-hidden="true" />
        </div>
      )}

      <div>
        <h2 id="listing-title" className="mk-title">
          {listing.title}
        </h2>
        <p className="mk-price">
          {formatPrice(listing.priceMinor, listing.currency, listing.priceUnit)}
          {listing.status !== "available" && <span className={`mk-badge mk-badge--inline mk-badge--${listing.status}`}>{STATUS_LABEL[listing.status]}</span>}
        </p>
        <p className="mk-note">
          {listing.kind === "service" ? "Service" : "Product"}
          {categoryLabel ? ` · ${categoryLabel}` : ""}
          {listing.section ? ` · ${listing.section}` : ""} · listed {timeAgoLong(listing.createdAt)}
        </p>
      </div>

      <div className="mk-actions">
        {!listing.mine && listing.status !== "draft" && (
          <Button variant={listing.saved ? "secondary" : "primary"} icon={<Bookmark size={18} aria-hidden="true" fill={listing.saved ? "currentColor" : "none"} />} loading={busy === "save"} aria-pressed={listing.saved} onClick={() => void toggleSave()}>
            {listing.saved ? "Saved" : "Save"}
          </Button>
        )}
        <Button variant="secondary" icon={<Link2 size={18} aria-hidden="true" />} onClick={() => void copyLink()}>
          Copy link
        </Button>
        {!listing.mine && dataSource.postTools && (
          <Button variant="ghost" icon={<Flag size={18} aria-hidden="true" />} onClick={() => setSheet("report")}>
            Report
          </Button>
        )}
      </div>

      {listing.mine && !listing.removedByAdmin && (
        <section className="mk-actions" aria-label="Manage this listing">
          <Button variant="secondary" icon={<Pencil size={18} aria-hidden="true" />} onClick={() => navigate(`/l/${listing.id}/edit`)}>
            Edit
          </Button>
          <label className="field" style={{ minWidth: 170 }}>
            <span className="visually-hidden">Status</span>
            <select className="field__input" value={listing.status} disabled={busy === "status"} onChange={(e) => void setStatus(e.target.value as Exclude<ListingStatus, "removed">)}>
              {(["available", "reserved", "sold", "draft"] as const).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <Button variant="ghost" icon={<Trash2 size={18} aria-hidden="true" />} onClick={() => setSheet("delete")}>
            Delete
          </Button>
        </section>
      )}

      <Link to={`/b/${listing.business.handle}`} className="mk-seller">
        <BusinessLogo name={listing.business.name} src={listing.business.logoUrl} />
        <span className="mk-seller__text">
          <strong>{listing.business.name}</strong>
          <span>
            Business · /b/{listing.business.handle}
            {c.area ? ` · ${c.area}` : ""}
          </span>
        </span>
      </Link>

      {listing.description && <p className="mk-desc">{listing.description}</p>}

      <dl className="mk-facts">
        {listing.condition && (
          <>
            <dt>Condition</dt>
            <dd>{CONDITION_LABEL[listing.condition]}</dd>
          </>
        )}
        {listing.area && (
          <>
            <dt>Area</dt>
            <dd>{listing.area}</dd>
          </>
        )}
        {listing.fulfilment.length > 0 && (
          <>
            <dt>{listing.kind === "service" ? "Where" : "Getting it"}</dt>
            <dd>{listing.fulfilment.map((f) => FULFILMENT_LABEL[f]).join(", ")}</dd>
          </>
        )}
        {listing.deliveryNote && (
          <>
            <dt>Details</dt>
            <dd>{listing.deliveryNote}</dd>
          </>
        )}
      </dl>

      {!listing.mine && (
        <section aria-labelledby="contact-title">
          <h3 id="contact-title" className="sheet-form__title" style={{ fontSize: "var(--text-md)" }}>
            Contact {listing.business.name}
          </h3>
          {c.website || c.email || c.phone ? (
            <ul className="mk-contact">
              {c.phone && (
                <li>
                  <a href={`tel:${c.phone.replace(/[^\d+]/g, "")}`}>
                    <Phone size={16} aria-hidden="true" /> {c.phone}
                  </a>
                </li>
              )}
              {c.email && (
                <li>
                  <a href={`mailto:${c.email}?subject=${encodeURIComponent(`About: ${listing.title}`)}`}>
                    <Mail size={16} aria-hidden="true" /> {c.email}
                  </a>
                </li>
              )}
              {c.website && (
                <li>
                  <a href={c.website} target="_blank" rel="noopener noreferrer nofollow ugc">
                    <Globe size={16} aria-hidden="true" /> {c.website.replace(/^https:\/\//, "").replace(/\/$/, "")}
                  </a>
                </li>
              )}
            </ul>
          ) : (
            <p className="mk-note">This business hasn't added contact details yet. Messaging businesses is coming soon.</p>
          )}
          <p className="mk-note" style={{ marginTop: 8 }}>
            Amigo doesn't handle payments or deliveries. Check the item and the seller before you pay.
          </p>
        </section>
      )}

      <Sheet open={sheet === "report"} onClose={() => setSheet(null)} label="Report">
        {sheet === "report" && <ReportForm target="listing" targetId={listing.id} what="listing" onDone={() => setSheet(null)} />}
      </Sheet>
      <Sheet open={sheet === "delete"} onClose={() => setSheet(null)} label="Delete listing">
        <div className="sheet-form">
          <h2 className="sheet-form__title">Delete this listing?</h2>
          <p className="sheet-form__body">It's removed for everyone, with its photos. Posts that shared it will say it's no longer available.</p>
          <div className="sheet-form__actions">
            <Button variant="ghost" onClick={() => setSheet(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={busy === "delete"}
              onClick={async () => {
                setBusy("delete");
                try {
                  await marketApi!.remove(listing.id);
                  toast("Listing deleted");
                  navigate("/settings/business", { replace: true });
                } catch (e) {
                  toast(marketErrorText(e), "error");
                  setBusy(null);
                }
              }}
            >
              Delete
            </Button>
          </div>
        </div>
      </Sheet>
    </article>
  );
}
