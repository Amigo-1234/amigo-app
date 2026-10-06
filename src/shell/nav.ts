import { Bell, Compass, House, Mail, UserRound, type LucideIcon } from "lucide-react";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Shown in the mobile bottom bar (Notifications lives in the Home header there). */
  mobile: boolean;
}

export const NAV: NavItem[] = [
  { to: "/", label: "Home", icon: House, mobile: true },
  { to: "/explore", label: "Explore", icon: Compass, mobile: true },
  { to: "/notifications", label: "Notifications", icon: Bell, mobile: false },
  { to: "/messages", label: "Messages", icon: Mail, mobile: true },
  { to: "/profile", label: "Profile", icon: UserRound, mobile: true },
];
