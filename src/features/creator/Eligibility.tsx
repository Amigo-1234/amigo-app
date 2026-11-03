import { Check, CircleDashed } from "lucide-react";
import type { CreatorEligibility, EligibilityKey, EligibilityRequirement } from "../../data";
import "./Eligibility.css";

const LABEL: Record<EligibilityKey, string> = {
  views_90d: "Views (last 90 days)",
  supporters: "Supporters",
  posts: "Posts",
  replies: "Replies",
  email_verified: "Email",
  account_age_days: "Account age",
  good_standing: "Account standing",
};

const STANDING_REASON: Record<string, string> = {
  account_suspended: "Account suspended",
  under_review: "Under review",
  creator_suspended: "Creator access suspended",
  creator_revoked: "Creator approval revoked",
};

const n = (v: number | boolean) => (typeof v === "number" ? v.toLocaleString() : "");

/** "32,000 / 50,000", "Verified", "120 / 90 days", "Good" — exactly what the server reported. */
function figure(r: EligibilityRequirement): string {
  if (r.key === "email_verified") return r.met ? "Verified" : "Not verified";
  if (r.key === "good_standing") return r.met ? "Good" : r.reasons.map((x) => STANDING_REASON[x] ?? x).join(", ") || "Not in good standing";
  if (r.key === "account_age_days") return `${n(r.value)} / ${n(r.required)} days`;
  return `${n(r.value)} / ${n(r.required)}`;
}

/** What one unmet requirement still needs, in a few words. */
function stillNeeded(r: EligibilityRequirement): string {
  const gap = typeof r.value === "number" && typeof r.required === "number" ? Math.max(0, r.required - r.value) : 0;
  switch (r.key) {
    case "views_90d":
      return `${gap.toLocaleString()} more ${gap === 1 ? "view" : "views"}`;
    case "supporters":
      return `${gap.toLocaleString()} more ${gap === 1 ? "supporter" : "supporters"}`;
    case "posts":
      return `${gap.toLocaleString()} more ${gap === 1 ? "post" : "posts"}`;
    case "replies":
      return `${gap.toLocaleString()} more ${gap === 1 ? "reply" : "replies"}`;
    case "account_age_days":
      return `${gap.toLocaleString()} more ${gap === 1 ? "day" : "days"} on Amigo`;
    case "email_verified":
      return "a verified email";
    case "good_standing":
      return "good account standing";
  }
}

/** "Still needed: 18,000 more views, 8 more supporters and a verified email." */
export function eligibilitySummary(e: CreatorEligibility): string {
  const missing = e.requirements.filter((r) => !r.met).map(stillNeeded);
  if (missing.length === 0) return "Meets every requirement.";
  const list = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`;
  return `Still needed: ${list}.`;
}

/** Which requirements aren't met, for a short admin reason ("views, supporters"). */
export const unmetLabels = (e: CreatorEligibility) =>
  e.requirements.filter((r) => !r.met).map((r) => LABEL[r.key].replace(" (last 90 days)", "").toLowerCase());

/** One row per requirement: label, figure against the threshold, a bar for counts, met or not. */
export function EligibilityList({ e, compact = false }: { e: CreatorEligibility; compact?: boolean }) {
  return (
    <ul className={`eligibility${compact ? " eligibility--compact" : ""}`}>
      {e.requirements.map((r) => {
        const counted = typeof r.value === "number" && typeof r.required === "number" && r.required > 0;
        const share = counted ? Math.min(1, (r.value as number) / (r.required as number)) : 0;
        return (
          <li key={r.key} className={`eligibility__row${r.met ? " is-met" : ""}`}>
            <span className="eligibility__mark" aria-hidden="true">
              {r.met ? <Check size={16} strokeWidth={2.4} /> : <CircleDashed size={16} />}
            </span>
            <span className="eligibility__label">{LABEL[r.key]}</span>
            <span className="eligibility__figure">
              {figure(r)}
              <span className="visually-hidden">{r.met ? " — met" : " — not met yet"}</span>
            </span>
            {counted && !compact && (
              <span className="eligibility__bar" aria-hidden="true">
                <span style={{ width: `${Math.round(share * 100)}%` }} />
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
