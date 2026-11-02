import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowLeft, CircleAlert, Plus, Store } from "lucide-react";
import { BUSINESS_CATEGORIES, WEEKDAYS, type BusinessCategory, type BusinessHours, type BusinessInput, type ListingCard, type ListingStatus, type MyBusiness, type Weekday } from "../data";
import { formatPrice, marketApi, marketErrorText, STATUS_LABEL, useMarketplace } from "../features/marketplace/shared";
import { businessApi, useMyBusiness } from "../features/business/useMyBusiness";
import { BusinessLogo, businessErrorText, HANDLE_RE } from "../features/business/shared";
import { ImageError, prepareAvatar, processImage } from "../lib/image";
import { MediaImg } from "../lib/mediaLinks";
import { ScreenHeader } from "../shell/ScreenHeader";
import { useToast } from "../state/toast";
import { Button, IconButton } from "../ui/Button";
import { StateMessage } from "../ui/StateMessage";
import "./SettingsScreen.css";

const dateFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long", year: "numeric" });

/** Settings → Your business: create the one business page you may have, or edit it. */
export default function BusinessManageScreen() {
  const navigate = useNavigate();
  const { state, reload } = useMyBusiness();

  return (
    <>
      <ScreenHeader
        title={state?.business ? "Your business" : "Create a business page"}
        leading={
          <IconButton label="Back" onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate("/settings"))} className="back-btn">
            <ArrowLeft size={22} />
          </IconButton>
        }
      />
      {!state ? (
        <p className="settings-muted" aria-busy="true" style={{ padding: "0 16px" }}>Loading…</p>
      ) : state.business ? (
        <>
          <ManageListings business={state.business} />
          <BusinessDetails key={`d-${state.business.id}`} business={state.business} onSaved={reload} />
          <BusinessForm key={state.business.id} business={state.business} onSaved={reload} />
        </>
      ) : !state.enabled ? (
        <StateMessage icon={<Store size={24} />} title="Business pages aren't available yet" body="We'll let you know when you can create one." />
      ) : (
        <BusinessForm business={null} onSaved={reload} />
      )}
    </>
  );
}

function BusinessForm({ business, onSaved }: { business: MyBusiness | null; onSaved: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [handle, setHandle] = useState(business?.handle ?? "");
  const [form, setForm] = useState<BusinessInput>({
    name: business?.name ?? "",
    category: business?.category ?? "other",
    description: business?.description ?? "",
    website: business?.website ?? "",
    email: business?.email ?? "",
    phone: business?.phone ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof BusinessInput>(k: K, v: BusinessInput[K]) => setForm((f) => ({ ...f, [k]: v }));

  const suspended = business?.status === "suspended";
  const handleLocked = !!business && business.canChangeHandleAt.getTime() > Date.now();
  const cleanHandle = handle.trim().toLowerCase();
  const valid =
    HANDLE_RE.test(cleanHandle) &&
    form.name.trim().length > 0 &&
    form.name.trim().length <= 50 &&
    form.description.length <= 500 &&
    (!form.website || /^https:\/\//i.test(form.website.trim()));

  const submit = async () => {
    setBusy(true);
    setError(null);
    const input = { ...form, name: form.name.trim(), description: form.description.trim(), website: form.website.trim(), email: form.email.trim(), phone: form.phone.trim() };
    try {
      if (business) {
        await businessApi!.update({ ...input, handle: cleanHandle !== business.handle ? cleanHandle : undefined });
        toast("Business page saved");
      } else {
        await businessApi!.create({ ...input, handle: cleanHandle });
        toast("Your business page is ready");
        navigate(`/b/${cleanHandle}`);
      }
      onSaved();
    } catch (e) {
      setError(businessErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="biz-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !busy && !suspended) void submit();
      }}
    >
      {suspended && <p className="form-error">This business is suspended by the Amigo team, so it can't be edited, post or be deleted. Contact Amigo support.</p>}
      {!business && (
        <p className="settings-muted">
          One business page per person. Your name and account aren't shown on the page. Business posts are public; your likes and replies stay your own.
        </p>
      )}
      {business && (
        <p className="settings-muted">
          <Link to={`/b/${business.handle}`}>View your page</Link> · {business.followerCount} {business.followerCount === 1 ? "follower" : "followers"} · {business.postCount} {business.postCount === 1 ? "post" : "posts"}
        </p>
      )}

      {business && !suspended && <ImagesEditor business={business} onSaved={onSaved} />}

      <label className="field">
        <span className="field__label">Business name</span>
        <input className="field__input" value={form.name} maxLength={50} onChange={(e) => set("name", e.target.value)} required disabled={suspended} />
      </label>
      <label className="field">
        <span className="field__label">Handle</span>
        <input
          className="field__input"
          value={handle}
          maxLength={24}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => setHandle(e.target.value.toLowerCase())}
          disabled={suspended || handleLocked}
          aria-describedby="biz-handle-hint"
        />
        <span id="biz-handle-hint" className="biz-form__hint">
          Your page is at /b/{cleanHandle || "handle"}. 3–24 lowercase letters, numbers or underscores.{" "}
          {handleLocked ? `You can change it again on ${dateFmt.format(business!.canChangeHandleAt)}.` : "You can change it once every 30 days."}
        </span>
      </label>
      <label className="field">
        <span className="field__label">Category</span>
        <select className="field__input" value={form.category} onChange={(e) => set("category", e.target.value as BusinessCategory)} disabled={suspended}>
          {BUSINESS_CATEGORIES.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field__label">About (optional)</span>
        <textarea className="field__input" rows={4} maxLength={500} value={form.description} onChange={(e) => set("description", e.target.value)} disabled={suspended} />
      </label>
      <label className="field">
        <span className="field__label">Website (optional)</span>
        <input className="field__input" type="url" inputMode="url" placeholder="https://" value={form.website} maxLength={200} onChange={(e) => set("website", e.target.value)} disabled={suspended} />
      </label>
      <label className="field">
        <span className="field__label">Contact email (optional, shown on your page)</span>
        <input className="field__input" type="email" value={form.email} maxLength={254} onChange={(e) => set("email", e.target.value)} disabled={suspended} />
      </label>
      <label className="field">
        <span className="field__label">Phone (optional, shown on your page)</span>
        <input className="field__input" type="tel" value={form.phone} maxLength={32} onChange={(e) => set("phone", e.target.value)} disabled={suspended} />
      </label>

      {error && (
        <p className="form-error" role="alert">
          <CircleAlert size={15} aria-hidden="true" style={{ verticalAlign: -2, marginRight: 6 }} />
          {error}
        </p>
      )}
      <div className="biz-form__actions">
        <Button type="submit" loading={busy} disabled={!valid || suspended}>
          {business ? "Save" : "Create business page"}
        </Button>
      </div>

      {business && !suspended && <DeleteBusiness name={business.name} onDeleted={onSaved} />}
    </form>
  );
}

function ImagesEditor({ business, onSaved }: { business: MyBusiness; onSaved: () => void }) {
  const toast = useToast();
  const logoRef = useRef<HTMLInputElement>(null);
  const coverRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<null | "logo" | "cover">(null);

  const put = async (kind: "logo" | "cover", file: File | null) => {
    setBusy(kind);
    try {
      const blob = !file ? null : kind === "logo" ? await (await fetch((await prepareAvatar(file)).dataUrl)).blob() : (await processImage(file)).blob;
      await businessApi!.setImage(kind, blob);
      toast(file ? (kind === "logo" ? "Logo updated" : "Cover updated") : kind === "logo" ? "Logo removed" : "Cover removed");
      onSaved();
    } catch (e) {
      toast(e instanceof ImageError ? e.message : businessErrorText(e), "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="biz-form__images">
      <BusinessLogo name={business.name} src={business.logoUrl} size="xl" />
      <div className="biz-form__actions">
        <Button type="button" size="sm" variant="secondary" loading={busy === "logo"} onClick={() => logoRef.current?.click()}>
          {business.logoUrl ? "Change logo" : "Add logo"}
        </Button>
        {business.logoUrl && (
          <Button type="button" size="sm" variant="ghost" disabled={!!busy} onClick={() => put("logo", null)}>
            Remove
          </Button>
        )}
      </div>
      <span className="biz-form__cover">{business.coverUrl && <MediaImg src={business.coverUrl} alt="" decoding="async" />}</span>
      <div className="biz-form__actions">
        <Button type="button" size="sm" variant="secondary" loading={busy === "cover"} onClick={() => coverRef.current?.click()}>
          {business.coverUrl ? "Change cover" : "Add cover"}
        </Button>
        {business.coverUrl && (
          <Button type="button" size="sm" variant="ghost" disabled={!!busy} onClick={() => put("cover", null)}>
            Remove
          </Button>
        )}
      </div>
      <input ref={logoRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void put("logo", f); }} />
      <input ref={coverRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void put("cover", f); }} />
    </div>
  );
}

function DeleteBusiness({ name, onDeleted }: { name: string; onDeleted: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setConfirming(false), [name]);
  return (
    <div className="biz-form__danger">
      {!confirming ? (
        <Button type="button" variant="ghost" onClick={() => setConfirming(true)}>
          Delete business page
        </Button>
      ) : (
        <>
          <p className="settings-muted">Delete {name}? Its page, posts, photos and followers are removed for everyone. This can't be undone.</p>
          <div className="biz-form__actions">
            <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await businessApi!.remove();
                  toast("Business page deleted");
                  onDeleted();
                  navigate("/settings", { replace: true });
                } catch (e) {
                  toast(businessErrorText(e), "error");
                  setBusy(false);
                }
              }}
            >
              Delete
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- listings

/** Manage Business → Listings: every listing with its status (drafts included). */
function ManageListings({ business }: { business: MyBusiness }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { enabled } = useMarketplace();
  const [rows, setRows] = useState<(ListingCard & { removedByAdmin: boolean })[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    marketApi!.mine().then(setRows, () => setRows([]));
  }, [enabled]);
  if (!enabled) return null;
  const suspended = business.status === "suspended";

  return (
    <section className="biz-form" aria-labelledby="listings-title" style={{ paddingBottom: 0 }}>
      <div className="mk-toolbar">
        <h2 id="listings-title" className="sheet-form__title" style={{ fontSize: "var(--text-lg)" }}>
          Products & services
        </h2>
        <Button size="sm" icon={<Plus size={16} aria-hidden="true" />} disabled={suspended} onClick={() => navigate("/market/sell")}>
          Add a listing
        </Button>
      </div>
      {!rows ? (
        <p className="settings-muted" aria-busy="true">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="settings-muted">No listings yet. They show on your business page and in the Marketplace.</p>
      ) : (
        <ul className="mk-rows">
          {rows.map((l) => (
            <li key={l.id} className="mk-row">
              <span className="mk-row__text">
                <Link to={`/l/${l.id}`}>
                  <strong>{l.title}</strong>
                </Link>
                <span>
                  {formatPrice(l.priceMinor, l.currency, l.priceUnit)} · {l.kind === "service" ? "Service" : "Product"}
                  {l.saveCount > 0 ? ` · saved ${l.saveCount}×` : ""}
                </span>
              </span>
              {l.removedByAdmin ? (
                <span className="mk-badge mk-badge--inline mk-badge--removed">{STATUS_LABEL.removed}</span>
              ) : (
                <select
                  aria-label={`Status of ${l.title}`}
                  value={l.status}
                  disabled={busy === l.id || suspended}
                  onChange={async (e) => {
                    const status = e.target.value as Exclude<ListingStatus, "removed">;
                    setBusy(l.id);
                    try {
                      await marketApi!.setStatus(l.id, status);
                      setRows((list) => list?.map((x) => (x.id === l.id ? { ...x, status } : x)) ?? null);
                      toast(`Marked ${STATUS_LABEL[status].toLowerCase()}`);
                    } catch (err) {
                      toast(marketErrorText(err), "error");
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  {(["available", "reserved", "sold", "draft"] as const).map((st) => (
                    <option key={st} value={st}>
                      {STATUS_LABEL[st]}
                    </option>
                  ))}
                </select>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ------------------------------------------------------------ area and hours

const DAY_SHORT: Record<Weekday, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

/** Area and opening hours (one range a day here; the API allows two). */
function BusinessDetails({ business, onSaved }: { business: MyBusiness; onSaved: () => void }) {
  const toast = useToast();
  const [area, setArea] = useState(business.area ?? "");
  const [hours, setHours] = useState<Record<Weekday, { open: boolean; from: string; to: string }>>(() =>
    Object.fromEntries(
      WEEKDAYS.map((d) => {
        const r = business.hours?.[d]?.[0];
        return [d, { open: !!r, from: r?.[0] ?? "09:00", to: r?.[1] ?? "17:00" }];
      }),
    ) as Record<Weekday, { open: boolean; from: string; to: string }>,
  );
  const [busy, setBusy] = useState(false);
  const anyOpen = WEEKDAYS.some((d) => hours[d].open);
  const valid = WEEKDAYS.every((d) => !hours[d].open || hours[d].from < hours[d].to);

  return (
    <form
      className="biz-form"
      style={{ paddingBottom: 0 }}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!valid) return;
        setBusy(true);
        try {
          const h: BusinessHours = {};
          for (const d of WEEKDAYS) if (hours[d].open) h[d] = [[hours[d].from, hours[d].to]];
          await businessApi!.setDetails(area.trim() || null, anyOpen ? h : null);
          toast("Area and hours saved");
          onSaved();
        } catch (err) {
          toast(businessErrorText(err), "error");
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2 className="sheet-form__title" style={{ fontSize: "var(--text-lg)" }}>Area and opening hours</h2>
      <label className="field">
        <span className="field__label">Area (shown on your page, e.g. "Lekki, Lagos")</span>
        <input className="field__input" value={area} maxLength={60} onChange={(e) => setArea(e.target.value)} disabled={business.status === "suspended"} />
      </label>
      <fieldset className="mk-form__checks" style={{ display: "grid", gap: 8 }}>
        <legend>Opening hours (leave every day off to hide them)</legend>
        {WEEKDAYS.map((d) => (
          <div key={d} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <label className="choice" style={{ minWidth: 72 }}>
              <input type="checkbox" checked={hours[d].open} onChange={(e) => setHours((h) => ({ ...h, [d]: { ...h[d], open: e.target.checked } }))} />
              {DAY_SHORT[d]}
            </label>
            {hours[d].open ? (
              <>
                <input type="time" className="field__input" style={{ height: 40, width: 120 }} aria-label={`${DAY_SHORT[d]} opens`} value={hours[d].from} onChange={(e) => setHours((h) => ({ ...h, [d]: { ...h[d], from: e.target.value } }))} />
                <span aria-hidden="true">–</span>
                <input type="time" className="field__input" style={{ height: 40, width: 120 }} aria-label={`${DAY_SHORT[d]} closes`} value={hours[d].to} onChange={(e) => setHours((h) => ({ ...h, [d]: { ...h[d], to: e.target.value } }))} />
              </>
            ) : (
              <span className="settings-muted">Closed</span>
            )}
          </div>
        ))}
      </fieldset>
      {!valid && <p className="form-error">Closing time must be after opening time.</p>}
      <div className="biz-form__actions">
        <Button type="submit" variant="secondary" loading={busy} disabled={!valid || business.status === "suspended"}>
          Save area and hours
        </Button>
      </div>
    </form>
  );
}
