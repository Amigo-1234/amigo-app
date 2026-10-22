import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { ArrowLeft, Coins } from "lucide-react";
import { dataSource, SUPPORT_LIMITS, type SupportAsk, type SupportCategory } from "../data";
import { checkSupportUrl, SUPPORT_ASKS, SUPPORT_CATEGORIES } from "../data/supportRules";
import { supportErrorText, useSupportConfig, useWallet } from "../features/support/useSupport";
import { ScreenHeader } from "../shell/ScreenHeader";
import { useViewer } from "../state/session";
import { useToast } from "../state/toast";
import { Button, IconButton } from "../ui/Button";
import "../features/support/Support.css";

type Errors = Partial<Record<"title" | "description" | "url" | "category" | "target", string>>;

/** One clear flow: fill in → review (with the credit cost) → submit. */
export default function SupportNewScreen() {
  const viewer = useViewer();
  const navigate = useNavigate();
  const toast = useToast();
  const config = useSupportConfig();
  const wallet = useWallet(0);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [url, setUrl] = useState("");
  const [category, setCategory] = useState<SupportCategory | "">("");
  const [ask, setAsk] = useState<SupportAsk>("visit");
  const [target, setTarget] = useState<number | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const goal = target ?? config?.defaultTarget ?? 10;

  function validate(): Errors {
    const e: Errors = {};
    const t = title.trim();
    const d = description.trim();
    if (t.length < SUPPORT_LIMITS.titleMin) e.title = `Give it a title (at least ${SUPPORT_LIMITS.titleMin} characters).`;
    if (d.length < SUPPORT_LIMITS.descriptionMin) e.description = `Say a bit more (at least ${SUPPORT_LIMITS.descriptionMin} characters).`;
    const u = checkSupportUrl(url);
    if (!u.ok) e.url = u.error;
    if (!category) e.category = "Pick a category.";
    if (config && (goal < config.minTarget || goal > config.maxTarget)) e.target = `Between ${config.minTarget} and ${config.maxTarget}.`;
    return e;
  }

  const review = (ev: FormEvent) => {
    ev.preventDefault();
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length) {
      document.querySelector<HTMLElement>(`[name="${Object.keys(e)[0]}"]`)?.focus();
      return;
    }
    setReviewing(true);
  };

  const submit = async () => {
    setBusy(true);
    try {
      const res = await dataSource.support!.createRequest(viewer.id, { title, description, url, category: category as SupportCategory, ask, target: goal });
      toast(res.status === "pending" ? "Request sent — it'll appear once it's reviewed" : "Your request is live");
      navigate(`/support/${res.id}`, { replace: true });
    } catch (e) {
      toast(supportErrorText(e), "error");
      setBusy(false);
    }
  };

  const cost = config?.requestCost ?? 0;
  const canAfford = wallet ? wallet.credits >= cost : true;
  const checked = checkSupportUrl(url);

  return (
    <>
      <ScreenHeader
        title="Ask for support"
        leading={
          <IconButton label="Back" onClick={() => (reviewing ? setReviewing(false) : navigate(-1))} className="back-btn">
            <ArrowLeft size={22} />
          </IconButton>
        }
      />
      {!reviewing ? (
        <form className="support-form" onSubmit={review} noValidate>
          <p className="support-form__intro">Share one thing you want genuine help or feedback on. People visit it, then tell you what they think.</p>

          <Field label="Title" error={errors.title} count={`${title.length}/${SUPPORT_LIMITS.titleMax}`}>
            <input name="title" className="field__input" value={title} maxLength={SUPPORT_LIMITS.titleMax} onChange={(e) => setTitle(e.target.value)} placeholder="Listen to my song and tell me what you think of the chorus" />
          </Field>

          <Field label="Short description" error={errors.description} count={`${description.length}/${SUPPORT_LIMITS.descriptionMax}`}>
            <textarea name="description" className="field__input" rows={3} value={description} maxLength={SUPPORT_LIMITS.descriptionMax} onChange={(e) => setDescription(e.target.value)} placeholder="What is it, and what feedback would help most?" />
          </Field>

          <Field label="Link" error={errors.url} hint={!errors.url && url && checked.ok ? `Opens ${checked.host}` : "A web link (https://…) to your song, video, app, page…"}>
            <input name="url" className="field__input" inputMode="url" autoComplete="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
          </Field>

          <fieldset className="support-form__group" aria-describedby={errors.category ? "err-category" : undefined}>
            <legend>Category</legend>
            <div className="support-chips support-chips--wrap">
              {SUPPORT_CATEGORIES.map((c) => (
                <label key={c.id} className="chip chip--radio">
                  <input type="radio" name="category" value={c.id} checked={category === c.id} onChange={() => setCategory(c.id)} />
                  {c.label}
                </label>
              ))}
            </div>
            {errors.category && <p className="form-error" id="err-category">{errors.category}</p>}
          </fieldset>

          <Field label="What kind of support do you want?">
            <select name="ask" className="field__input" value={ask} onChange={(e) => setAsk(e.target.value as SupportAsk)}>
              {SUPPORT_ASKS.map((a) => (
                <option key={a.id} value={a.id}>{a.label}</option>
              ))}
            </select>
          </Field>

          <Field label="How many supporters are you hoping for?" error={errors.target} hint={config ? `${config.minTarget}–${config.maxTarget}. The request completes when it reaches this.` : undefined}>
            <input name="target" className="field__input support-form__num" type="number" min={config?.minTarget} max={config?.maxTarget} value={goal} onChange={(e) => setTarget(Number(e.target.value))} />
          </Field>

          <div className="support-form__foot">
            <p className="support-cost">
              <Coins size={16} aria-hidden="true" /> Costs <strong>{cost} Support Credits</strong>
              {wallet && <> · you have {wallet.credits}</>}
            </p>
            <Button type="submit">Review request</Button>
          </div>
        </form>
      ) : (
        <section className="support-form" aria-labelledby="review-title">
          <h2 id="review-title" className="support-form__review-title">Review and confirm</h2>
          <dl className="support-review">
            <div><dt>Title</dt><dd>{title.trim()}</dd></div>
            <div><dt>Description</dt><dd>{description.trim()}</dd></div>
            <div><dt>Link</dt><dd className="support-detail__url">{checked.ok ? checked.url : url}</dd></div>
            <div><dt>Category</dt><dd>{SUPPORT_CATEGORIES.find((c) => c.id === category)?.label}</dd></div>
            <div><dt>Asking for</dt><dd>{SUPPORT_ASKS.find((a) => a.id === ask)?.label}</dd></div>
            <div><dt>Goal</dt><dd>{goal} supporters</dd></div>
          </dl>
          <div className={`support-confirm${canAfford ? "" : " is-short"}`} role="status">
            <Coins size={18} aria-hidden="true" />
            {canAfford ? (
              <p>
                Submitting costs <strong>{cost} Support Credits</strong>. You have {wallet?.credits ?? "…"}, so you'll have {(wallet?.credits ?? cost) - cost} left.
                {config?.moderation && " A quick review happens before it's shown to others."} No real money is involved.
              </p>
            ) : (
              <p>
                You need <strong>{cost} Support Credits</strong> and have {wallet?.credits}. Support {cost - (wallet?.credits ?? 0)} more{" "}
                {cost - (wallet?.credits ?? 0) === 1 ? "person" : "people"} to earn the rest.
              </p>
            )}
          </div>
          <div className="support-form__foot">
            <Button variant="ghost" onClick={() => setReviewing(false)}>Edit</Button>
            {canAfford ? (
              <Button onClick={submit} loading={busy} disabled={busy}>Submit for {cost} credits</Button>
            ) : (
              <Button variant="secondary" onClick={() => navigate("/support?section=needs")}>Find someone to support</Button>
            )}
          </div>
        </section>
      )}
    </>
  );
}

function Field({ label, error, hint, count, children }: { label: string; error?: string; hint?: string; count?: string; children: React.ReactElement }) {
  return (
    <label className={`field support-field${error ? " has-error" : ""}`}>
      <span className="field__label">
        {label}
        {count && <span className="support-field__count">{count}</span>}
      </span>
      {children}
      {error ? <span className="form-error">{error}</span> : hint ? <span className="support-field__hint">{hint}</span> : null}
    </label>
  );
}
