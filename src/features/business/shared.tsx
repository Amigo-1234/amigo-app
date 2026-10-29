import { Store } from "lucide-react";
import { MediaImg } from "../../lib/mediaLinks";
import { BUSINESS_CATEGORIES, BusinessError, type BusinessCategory } from "../../data";
import "./Business.css";

export const categoryLabel = (id: BusinessCategory) => BUSINESS_CATEGORIES.find((c) => c.id === id)?.label ?? "Other";

/** What to tell the person when a business action is refused. */
export function businessErrorText(e: unknown): string {
  const code = e instanceof BusinessError ? e.code : "unknown";
  switch (code) {
    case "off":
      return "Business pages aren't available yet.";
    case "not-eligible":
      return "To create a business page, verify your email first. Suspended accounts can't create one.";
    case "handle":
      return "That handle isn't available. Use 3–24 lowercase letters, numbers or underscores.";
    case "name":
      return "That name isn't allowed. Use up to 50 characters, and not the Amigo name.";
    case "handle-too-soon":
      return "You can change the handle once every 30 days.";
    case "already-have-one":
      return "You already have a business page.";
    case "suspended":
      return "This business is suspended. Contact Amigo support.";
    case "invalid":
      return "Check the details: websites start with https://, and emails and phone numbers need to be valid.";
    case "slow-down":
      return "You're doing that too often. Try again later.";
    default:
      return "Something went wrong. Try again.";
  }
}

/** A square logo, or a shop icon when there isn't one. */
export function BusinessLogo({ name, src, size = "md" }: { name: string; src: string | null; size?: "sm" | "md" | "xl" }) {
  return (
    <span className={`biz-logo biz-logo--${size}`}>
      {src ? <MediaImg src={src} alt="" loading="lazy" decoding="async" /> : <Store aria-hidden="true" />}
      <span className="visually-hidden">{name}</span>
    </span>
  );
}

export const HANDLE_RE = /^[a-z0-9_]{3,24}$/;
