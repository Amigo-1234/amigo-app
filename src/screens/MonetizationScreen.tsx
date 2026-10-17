import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowLeft, Sparkles } from "lucide-react";
import { dataSource, type CreatorOverview } from "../data";
import { ScreenHeader } from "../shell/ScreenHeader";
import { useToast } from "../state/toast";
import { Button, IconButton } from "../ui/Button";
import { Skeleton } from "../ui/Skeleton";
import { StateMessage } from "../ui/StateMessage";
import "./SettingsScreen.css";

const STANDING: Record<CreatorOverview["standing"], string> = {
  good: "Good standing",
  under_review: "Under review",
  restricted: "Restricted",
};

/** Settings → Creator monetization. Information only: no earnings, balances or payouts exist. */
export default function MonetizationScreen() {
  const navigate = useNavigate();
  const toast = useToast();
  const api = dataSource.monetization;
  const [o, setO] = useState<CreatorOverview | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!api) return setO(null);
    void api.overview().then(setO, () => setO(null));
  }, [api]);

  const header = (
    <ScreenHeader
      title="Creator monetization"
      leading={
        <IconButton label="Back" onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate("/settings"))} className="back-btn">
          <ArrowLeft size={22} />
        </IconButton>
      }
    />
  );

  if (o === undefined) {
    return (
      <>
        {header}
        <div className="settings" aria-busy="true">
          <Skeleton width="70%" height={22} />
          <Skeleton width="100%" height={120} />
        </div>
      </>
    );
  }
  if (!o) {
    return (
      <>
        {header}
        <StateMessage icon={<Sparkles size={24} />} title="Creator monetization is coming soon." body="Check back later." />
      </>
    );
  }

  const e = o.engagement;
  const stats: [string, number][] = [
    ["Followers with verified accounts", e.verifiedFollowers],
    ["All followers", e.followers],
    ["Posts in the last 30 days", e.posts30d],
    ["Support Hub support from verified accounts", e.supportReceived],
    ["Completed Support Hub requests", e.supportRequestsCompleted],
    ["Account age (days)", e.accountAgeDays],
  ];
  const criteria = Object.entries(o.criteria);

  return (
    <>
      {header}
      <div className="settings">
        <div className="settings-hero">
          <span className="settings-row__icon" aria-hidden="true">
            <Sparkles size={20} />
          </span>
          <div className="settings-hero__text">
            <h2 className="settings-hero__name">{o.programmeOpen ? "Creator monetization" : "Creator monetization is coming soon."}</h2>
            <p className="settings-hero__handle">
              {o.programmeOpen ? "The programme is open. Eligibility is reviewed by the Amigo team." : "No one can earn on Amigo yet. Nothing here is a promise of earnings."}
            </p>
          </div>
        </div>

        {o.publicNote && <p className="settings-panel__text">{o.publicNote}</p>}

        <section className="settings-section" aria-labelledby="mon-standing">
          <h3 id="mon-standing" className="settings-section__title">Your account</h3>
          <div className="settings-card">
            <div className="settings-row">
              <span className="settings-row__text">
                <span className="settings-row__title">Account standing</span>
                <span className="settings-row__detail">
                  <span className={`settings-badge settings-badge--${o.standing === "good" ? "ok" : "warn"}`}>{STANDING[o.standing]}</span>
                  {o.statusReason && ` · ${o.statusReason}`}
                </span>
              </span>
            </div>
            {o.application && (
              <div className="settings-row">
                <span className="settings-row__text">
                  <span className="settings-row__title">Your application</span>
                  <span className="settings-row__detail">
                    {o.application.status === "pending" ? "Waiting for review" : o.application.status === "approved" ? "Approved — you're eligible when the programme launches" : o.application.status === "rejected" ? "Not approved" : "Withdrawn"}
                    {o.application.reviewNote && ` · ${o.application.reviewNote}`}
                  </span>
                </span>
              </div>
            )}
          </div>
        </section>

        <section className="settings-section" aria-labelledby="mon-stats">
          <h3 id="mon-stats" className="settings-section__title">Authentic engagement</h3>
          <div className="settings-card">
            {stats.map(([label, value]) => (
              <div className="settings-row" key={label}>
                <span className="settings-row__text">
                  <span className="settings-row__title">{value.toLocaleString()}</span>
                  <span className="settings-row__detail">{label}</span>
                </span>
              </div>
            ))}
          </div>
          <p className="settings-panel__text">Engagement from accounts with a verified email counts here. Support is one per person per request and needs a real visit.</p>
        </section>

        {criteria.length > 0 && (
          <section className="settings-section" aria-labelledby="mon-criteria">
            <h3 id="mon-criteria" className="settings-section__title">Programme requirements</h3>
            <div className="settings-card">
              {criteria.map(([k, v]) => (
                <div className="settings-row" key={k}>
                  <span className="settings-row__text">
                    <span className="settings-row__title">{k.replace(/_/g, " ")}</span>
                    <span className="settings-row__detail">{String(v)}</span>
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {o.applicationsOpen && o.application?.status !== "pending" && o.status !== "suspended" && (
          <Button
            loading={busy}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api!.apply();
                toast("Application sent for review");
                setO(await api!.overview());
              } catch {
                toast("Couldn't send your application", "error");
              } finally {
                setBusy(false);
              }
            }}
          >
            Apply for review
          </Button>
        )}

        <p className="settings-panel__text">
          Read the <Link to="/legal/monetization">Monetization Programme Terms</Link>.
        </p>
      </div>
    </>
  );
}
