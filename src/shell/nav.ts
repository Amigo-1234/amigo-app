import { Bell, Bookmark, Compass, HandHeart, House, Mail, Orbit, Settings, ShoppingBag, Sparkles, Store, UserRound, type LucideIcon } from "lucide-react";
import { dataSource } from "../data";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

const worlds = !!dataSource.worlds;
const messages = !!dataSource.messages;

export const HOME: NavItem = { to: "/", label: "Home", icon: House };
export const EXPLORE: NavItem = { to: "/explore", label: "Explore", icon: Compass };
export const MARKET: NavItem = { to: "/market", label: "Market", icon: ShoppingBag };
export const WORLDS: NavItem = { to: "/worlds", label: "Worlds", icon: Orbit };
export const MESSAGES: NavItem = { to: "/messages", label: "Messages", icon: Mail };
export const NOTIFICATIONS: NavItem = { to: "/notifications", label: "Notifications", icon: Bell };
/** Resolved to the viewer's own /u/<handle> in AppShell. */
export const PROFILE: NavItem = { to: "/profile", label: "Profile", icon: UserRound };

/**
 * The third main destination: the Marketplace once it's switched on for this
 * viewer, otherwise Worlds (so no slot ever leads to a page that isn't there).
 */
function thirdSlot(market: boolean): NavItem | null {
  return market ? MARKET : worlds ? WORLDS : null;
}

/** Desktop sidebar: the main destinations; everything else is under "More". */
export function sidebarNav(market: boolean): NavItem[] {
  return [HOME, EXPLORE, thirdSlot(market), messages ? MESSAGES : null, NOTIFICATIONS, PROFILE].filter((n): n is NavItem => !!n);
}

/**
 * Phone bottom bar: Home · Explore · (Create) · Market · Messages.
 * Notifications and the profile are in the Home header. Without messages the
 * profile takes the last slot.
 */
export function bottomNav(market: boolean): NavItem[] {
  return [HOME, EXPLORE, thirdSlot(market), messages ? MESSAGES : PROFILE].filter((n): n is NavItem => !!n);
}

/** The sidebar's "More" menu: places people visit less often, all still one click away. */
export function moreNav(opts: { market: boolean; business: boolean; creator: boolean }): NavItem[] {
  return [
    // Worlds is a main destination only while the Marketplace isn't.
    opts.market && worlds ? WORLDS : null,
    opts.business ? { to: "/business", label: "Businesses", icon: Store } : null,
    dataSource.support ? { to: "/support", label: "Help Hub", icon: HandHeart } : null,
    dataSource.postTools ? { to: "/bookmarks", label: "Bookmarks", icon: Bookmark } : null,
    opts.creator ? { to: "/settings/monetization", label: "Creator Programme", icon: Sparkles } : null,
    { to: "/settings", label: "Settings", icon: Settings },
  ].filter((n): n is NavItem => !!n);
}

/**
 * Which main destination a path belongs to, so sub-pages keep their tab lit.
 * Worlds and business pages are part of Explore unless Worlds has its own slot.
 */
export function sectionOf(pathname: string, worldsInNav: boolean): string | null {
  if (pathname === "/") return "/";
  if (pathname.startsWith("/worlds")) return worldsInNav ? "/worlds" : "/explore";
  if (/^\/(explore|business|b\/)/.test(pathname)) return "/explore";
  if (/^\/(market|l\/)/.test(pathname)) return "/market";
  if (pathname.startsWith("/messages")) return "/messages";
  if (pathname.startsWith("/notifications")) return "/notifications";
  return null;
}
