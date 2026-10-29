import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowLeft, CircleAlert, Store } from "lucide-react";
import { BUSINESS_CATEGORIES, type BusinessCategory, type BusinessSummary } from "../data";
import { businessApi, useMyBusiness } from "../features/business/useMyBusiness";
import { BusinessLogo, categoryLabel } from "../features/business/shared";
import { formatCount } from "../lib/format";
import { ScreenHeader } from "../shell/ScreenHeader";
import { useToast } from "../state/toast";
import { Button, IconButton } from "../ui/Button";
import { StateMessage } from "../ui/StateMessage";
import "./SettingsScreen.css";

/** /business: find business pages by name or category. */
export default function BusinessScreen() {
  const navigate = useNavigate();
  const { state: my } = useMyBusiness();
  const [query, setQuery] = useState("");
  const [typed, setTyped] = useState("");
  const [category, setCategory] = useState<BusinessCategory | null>(null);
  const [rows, setRows] = useState<BusinessSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setQuery(typed.trim()), 250);
    return () => clearTimeout(t);
  }, [typed]);

  useEffect(() => {
    let live = true;
    setRows(null);
    setFailed(false);
    businessApi!.search(query, category).then(
      (r) => live && setRows(r),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [query, category, attempt]);

  return (
    <>
      <ScreenHeader
        title="Businesses"
        leading={
          <IconButton label="Back" onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate("/explore"))} className="back-btn">
            <ArrowLeft size={22} />
          </IconButton>
        }
      />
      <div className="biz-dir">
        {my?.business ? (
          <p className="biz-dir__intro">
            Your page: <Link to={`/b/${my.business.handle}`}>/b/{my.business.handle}</Link>
          </p>
        ) : (
          my?.enabled && (
            <p className="biz-dir__intro">
              Run a business? <Link to="/settings/business">Create a business page</Link>
            </p>
          )
        )}
        <label className="field">
          <span className="field__label visually-hidden">Search businesses</span>
          <input className="field__input" type="search" placeholder="Search businesses" value={typed} onChange={(e) => setTyped(e.target.value)} maxLength={60} />
        </label>
        <div className="biz-cats" role="group" aria-label="Categories">
          <button type="button" className="biz-cat" aria-pressed={category === null} onClick={() => setCategory(null)}>
            All
          </button>
          {BUSINESS_CATEGORIES.map((c) => (
            <button key={c.id} type="button" className="biz-cat" aria-pressed={category === c.id} onClick={() => setCategory(category === c.id ? null : c.id)}>
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {failed ? (
        <StateMessage tone="error" icon={<CircleAlert size={24} />} title="Couldn't load businesses" body="This is usually temporary." action={<Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>Try again</Button>} />
      ) : !rows ? (
        <p className="settings-muted" aria-busy="true" style={{ padding: "0 16px" }}>Loading…</p>
      ) : rows.length === 0 ? (
        <StateMessage icon={<Store size={24} />} title="No businesses found" body={query || category ? "Try another word or category." : "Business pages will show up here."} />
      ) : (
        <ul className="biz-list">
          {rows.map((b) => (
            <BusinessRow key={b.id} business={b} />
          ))}
        </ul>
      )}
    </>
  );
}

function BusinessRow({ business }: { business: BusinessSummary }) {
  const { state: my } = useMyBusiness();
  return (
    <li className="biz-row">
      <Link to={`/b/${business.handle}`} className="biz-row__link">
        <BusinessLogo name={business.name} src={business.logoUrl} />
        <span className="biz-row__text">
          <strong>{business.name}</strong>
          <span>
            {categoryLabel(business.category)} · {formatCount(business.followerCount)} {business.followerCount === 1 ? "follower" : "followers"}
          </span>
        </span>
      </Link>
      {my?.business?.id !== business.id && <BusinessFollowButton id={business.id} name={business.name} following={business.following} />}
    </li>
  );
}

/** Follow / Following for a business page. Following is private to you. */
export function BusinessFollowButton({ id, name, following, onChange }: { id: string; name: string; following: boolean; onChange?: (following: boolean, count: number) => void }) {
  const toast = useToast();
  const [on, setOn] = useState(following);
  const [busy, setBusy] = useState(false);
  useEffect(() => setOn(following), [following]);
  return (
    <Button
      size="sm"
      variant={on ? "secondary" : "primary"}
      loading={busy}
      aria-pressed={on}
      aria-label={`${on ? "Unfollow" : "Follow"} ${name}`}
      onClick={async () => {
        setBusy(true);
        try {
          const count = await businessApi!.follow(id, !on);
          setOn(!on);
          onChange?.(!on, count);
        } catch {
          toast("Couldn't update. Try again.", "error");
        } finally {
          setBusy(false);
        }
      }}
    >
      {on ? "Following" : "Follow"}
    </Button>
  );
}
