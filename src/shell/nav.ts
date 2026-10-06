import { Bell, Compass, HandHeart, House, Mail, Orbit, UserRound, type LucideIcon } from "lucide-react";
import { dataSource } from "../data";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Shown in the mobile bottom bar (Notifications lives in the Home header there). */
  mobile: boolean;
}

const worlds = !!dataSource.worlds;

export const NAV: NavItem[] = [
  { to: "/", label: "Home", icon: House, mobile: true },
  { to: "/explore", label: "Explore", icon: Compass, mobile: true },
  // Worlds only where the backend supports them; on phones they take Messages' slot (Messages isn't built yet).
  ...(worlds ? [{ to: "/worlds", label: "Worlds", icon: Orbit, mobile: true }] : []),
  // Support Hub: sidebar on larger screens; on phones it's in the Home header next to Notifications.
  ...(dataSource.support ? [{ to: "/support", label: "Support Hub", icon: HandHeart, mobile: false }] : []),
  { to: "/notifications", label: "Notifications", icon: Bell, mobile: false },
  { to: "/messages", label: "Messages", icon: Mail, mobile: !worlds },
  // Resolved to the viewer's own /u/<handle> in AppShell.
  { to: "/profile", label: "Profile", icon: UserRound, mobile: true },
];
