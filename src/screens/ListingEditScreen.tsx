import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { ArrowLeft, CircleAlert, ImagePlus, X } from "lucide-react";
import type { ListingCondition, ListingFulfilment, ListingInput, ListingKind, ListingPriceUnit, ListingStatus, NewMediaInput } from "../data";
import { useMyBusiness } from "../features/business/useMyBusiness";
import { CONDITION_LABEL, FULFILMENT_LABEL, marketApi, marketErrorText, parseNaira, STATUS_LABEL, UNIT_LABEL, useMarketplace } from "../features/marketplace/shared";
import { ImageError, processImage } from "../lib/image";
import { MediaImg } from "../lib/mediaLinks";
import { ScreenHeader } from "../shell/ScreenHeader";
import { useToast } from "../state/toast";
import { Button, IconButton } from "../ui/Button";
import { StateMessage } from "../ui/StateMessage";
import "./SettingsScreen.css";

type Photo = { key: string; url: string } | (NewMediaInput & { url: string });
const MAX_PHOTOS = 8;

/** /market/sell and /l/:id/edit — a business adds or edits a listing. */
export default function ListingEditScreen() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { state: my } = useMyBusiness();
  const { enabled } = useMarketplace();
  const [initial, setInitial] = useState<(ListingInput & { photoUrls: Photo[] }) | null | undefined>(id ? undefined : null);

  useEffect(() => {
    if (!id) return;
    marketApi!.get(id).then(
      (l) =>
        setInitial(
          l && l.mine && !l.removedByAdmin
            ? {
                kind: l.kind, title: l.title, description: l.description, categoryId: l.categoryId, section: l.section ?? "",
                priceMinor: l.priceMinor, priceUnit: l.priceUnit, condition: l.condition, area: l.area ?? "", fulfilment: l.fulfilment,
                deliveryNote: l.deliveryNote ?? "", status: l.status === "removed" ? "draft" : l.status, photos: [],
                photoUrls: l.photos.map((p) => ({ key: p.key, url: p.url })),
              }
            : null,
        ),
      () => setInitial(null),
    );
  }, [id]);

  const header = (
    <ScreenHeader
      title={id ? "Edit listing" : "New listing"}
      leading={
        <IconButton label="Back" onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate("/settings/business"))} className="back-btn">
          <ArrowLeft size={22} />
        </IconButton>
      }
    />
  );
  if (!my || enabled === null || initial === undefined) {
    return (
      <>
        {header}
        <p className="settings-muted" aria-busy="true" style={{ padding: 16 }}>Loading…</p>
      </>
    );
  }
  if (!my.business) {
    return (
      <>
        {header}
        <StateMessage icon={<CircleAlert size={24} />} title="Only business pages can sell for now" body="Create a business page first, then add your products and services." action={<Button onClick={() => navigate("/settings/business")}>Create a business page</Button>} />
      </>
    );
  }
  if (id && !initial) {
    return (
      <>
        {header}
        <StateMessage icon={<CircleAlert size={24} />} title="You can't edit this listing" body="It isn't one of your business's listings, or Amigo removed it." />
      </>
    );
  }
  return (
    <>
      {header}
      <ListingForm id={id ?? null} initial={initial} defaultArea={my.business.area ?? ""} defaultKind={my.business.category === "services" ? "service" : "product"} suspended={my.business.status === "suspended"} />
    </>
  );
}

function ListingForm({ id, initial, defaultArea, defaultKind, suspended }: {
  id: string | null; initial: (ListingInput & { photoUrls: Photo[] }) | null; defaultArea: string; defaultKind: ListingKind; suspended: boolean;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const { categories } = useMarketplace();
  const [kind, setKind] = useState<ListingKind>(initial?.kind ?? defaultKind);
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [categoryId, setCategoryId] = useState(initial?.categoryId ?? "");
  const [section, setSection] = useState(initial?.section ?? "");
  const [priceText, setPriceText] = useState(initial?.priceMinor != null ? String(initial.priceMinor / 100) : "");
  const [priceUnit, setPriceUnit] = useState<ListingPriceUnit>(initial?.priceUnit ?? "item");
  const [condition, setCondition] = useState<ListingCondition | "">(initial?.condition ?? "");
  const [area, setArea] = useState(initial?.area ?? defaultArea);
  const [fulfilment, setFulfilment] = useState<ListingFulfilment[]>(initial?.fulfilment ?? []);
  const [deliveryNote, setDeliveryNote] = useState(initial?.deliveryNote ?? "");
  const [status, setStatus] = useState<Exclude<ListingStatus, "removed">>(initial?.status ?? "available");
  const [photos, setPhotos] = useState<Photo[]>(initial?.photoUrls ?? []);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const urls = useRef(new Set<string>());
  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const shown = categories.filter((c) => c.kind === kind);
  const priceMinor = parseNaira(priceText);
  const valid = title.trim().length >= 3 && title.trim().length <= 80 && shown.some((c) => c.id === categoryId) && !Number.isNaN(priceMinor) && description.length <= 2000;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const input: ListingInput = {
      kind, title, description, categoryId, section, priceMinor, priceUnit, condition: kind === "product" && condition ? condition : null,
      area, fulfilment, deliveryNote, status,
      photos: photos.map((p) => ("key" in p ? { key: p.key } : { kind: "image" as const, blob: p.blob, width: p.width, height: p.height, alt: p.alt })),
    };
    try {
      const listingId = id ?? (await marketApi!.create(input));
      if (id) await marketApi!.update(id, input);
      toast(id ? "Listing saved" : status === "draft" ? "Saved as a draft" : "Your listing is live");
      navigate(`/l/${listingId}`, { replace: true });
    } catch (e) {
      setError(marketErrorText(e));
      setBusy(false);
    }
  };

  return (
    <form
      className="mk-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !busy) void submit();
      }}
    >
      {suspended && <p className="form-error">This business is suspended, so it can't list anything. Contact Amigo support.</p>}
      <div className="mk-chips" role="group" aria-label="What are you listing?">
        {(["product", "service"] as const).map((k) => (
          <button
            key={k}
            type="button"
            className="mk-chip"
            aria-pressed={kind === k}
            onClick={() => {
              setKind(k);
              setCategoryId("");
            }}
          >
            {k === "product" ? "A product" : "A service"}
          </button>
        ))}
      </div>

      <div>
        <span className="field__label">Photos (up to {MAX_PHOTOS}; the first is the cover)</span>
        <div className="mk-photos" style={{ marginTop: 6 }}>
          {photos.map((p, i) => (
            <span key={p.url} className="mk-photos__item">
              <MediaImg src={p.url} size="sm" alt="" />
              {i === 0 && <span className="mk-photos__cover">Cover</span>}
              <IconButton label={`Remove photo ${i + 1}`} size="sm" className="mk-photos__remove" onClick={() => setPhotos((list) => list.filter((_, j) => j !== i))}>
                <X size={14} />
              </IconButton>
            </span>
          ))}
          {photos.length < MAX_PHOTOS && (
            <button type="button" className="mk-photos__add" onClick={() => fileRef.current?.click()} disabled={picking} aria-label="Add photos">
              <ImagePlus size={22} aria-hidden="true" />
            </button>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={async (e) => {
            const files = Array.from(e.target.files ?? []).slice(0, MAX_PHOTOS - photos.length);
            e.target.value = "";
            if (!files.length) return;
            setPicking(true);
            try {
              const done = await Promise.all(files.map(processImage));
              setPhotos((list) =>
                [
                  ...list,
                  ...done.map((d) => {
                    const url = URL.createObjectURL(d.blob);
                    urls.current.add(url);
                    return { kind: "image" as const, blob: d.blob, width: d.width, height: d.height, url };
                  }),
                ].slice(0, MAX_PHOTOS),
              );
            } catch (err) {
              toast(err instanceof ImageError ? err.message : "Couldn't use that photo", "error");
            } finally {
              setPicking(false);
            }
          }}
        />
      </div>

      <label className="field">
        <span className="field__label">Title</span>
        <input className="field__input" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder={kind === "product" ? "e.g. Red running shoes, size 42" : "e.g. Bridal makeup"} required />
      </label>
      <label className="field">
        <span className="field__label">Category</span>
        <select className="field__input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} required>
          <option value="">Choose…</option>
          {shown.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <div className="mk-form__row">
        <label className="field">
          <span className="field__label">Price (₦, optional)</span>
          <input className="field__input" inputMode="decimal" value={priceText} onChange={(e) => setPriceText(e.target.value)} placeholder="Price on request" aria-invalid={Number.isNaN(priceMinor)} />
        </label>
        <label className="field">
          <span className="field__label">Price is</span>
          <select className="field__input" value={priceUnit} onChange={(e) => setPriceUnit(e.target.value as ListingPriceUnit)}>
            {(Object.keys(UNIT_LABEL) as ListingPriceUnit[]).map((u) => (
              <option key={u} value={u}>
                {UNIT_LABEL[u]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {Number.isNaN(priceMinor) && <p className="form-error">Write the price as a number in naira, like 15000.</p>}
      {kind === "product" && (
        <label className="field">
          <span className="field__label">Condition</span>
          <select className="field__input" value={condition} onChange={(e) => setCondition(e.target.value as ListingCondition | "")}>
            <option value="">Not stated</option>
            {(Object.keys(CONDITION_LABEL) as ListingCondition[]).map((c) => (
              <option key={c} value={c}>
                {CONDITION_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        <span className="field__label">Description</span>
        <textarea className="field__input" rows={5} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Size, colour, what's included, how long it takes…" />
      </label>
      <label className="field">
        <span className="field__label">Group (optional, e.g. a menu section)</span>
        <input className="field__input" value={section} maxLength={40} onChange={(e) => setSection(e.target.value)} placeholder="e.g. Mains, Bridal, Repairs" />
      </label>
      <label className="field">
        <span className="field__label">Area</span>
        <input className="field__input" value={area} maxLength={60} onChange={(e) => setArea(e.target.value)} placeholder="e.g. Lekki, Lagos" />
      </label>
      <fieldset className="mk-form__checks">
        <legend>{kind === "service" ? "Where you provide it" : "How buyers get it"}</legend>
        {(Object.keys(FULFILMENT_LABEL) as ListingFulfilment[]).map((f) => (
          <label key={f} className="choice">
            <input type="checkbox" checked={fulfilment.includes(f)} onChange={(e) => setFulfilment((list) => (e.target.checked ? [...list, f] : list.filter((x) => x !== f)))} />
            {FULFILMENT_LABEL[f]}
          </label>
        ))}
      </fieldset>
      <label className="field">
        <span className="field__label">Delivery or booking details (optional)</span>
        <input className="field__input" value={deliveryNote} maxLength={300} onChange={(e) => setDeliveryNote(e.target.value)} placeholder="e.g. Same-day delivery in Lagos" />
      </label>
      <label className="field">
        <span className="field__label">Status</span>
        <select className="field__input" value={status} onChange={(e) => setStatus(e.target.value as Exclude<ListingStatus, "removed">)}>
          {(["available", "reserved", "sold", "draft"] as const).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
              {s === "draft" ? " (only you can see it)" : ""}
            </option>
          ))}
        </select>
      </label>
      <p className="mk-note">Don't list prohibited items. Amigo doesn't process payments; buyers contact you directly.</p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="mk-actions">
        <Button type="submit" loading={busy} disabled={!valid || suspended || picking}>
          {id ? "Save" : status === "draft" ? "Save draft" : "Publish listing"}
        </Button>
      </div>
    </form>
  );
}
