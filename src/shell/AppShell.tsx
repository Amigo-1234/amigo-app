import { Suspense, useEffect, useId, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router";
import { profilesEnabled } from "../features/profile/links";
import { CircleEllipsis, Plus, ShieldCheck, ShoppingBag } from "lucide-react";
import { dataSource } from "../data";
import { useMyBusiness } from "../features/business/useMyBusiness";
import { useMarketplace } from "../features/marketplace/shared";
import { useIsAdmin } from "../features/admin/useAdmin";
import { Composer, type ComposerHandle } from "../features/composer/Composer";
import { PublishStatusBar } from "./PublishStatusBar";
import { useComposer } from "../state/composer";
import { SignInNotice } from "../features/messages/SignInNotice";
import { messagesLabel, useUnreadMessages } from "../state/messages";
import { securityApi } from "../state/security";
import { badgeText, notificationsLabel, useUnread } from "../state/notifications";
import { useViewer } from "../state/session";
import { Avatar } from "../ui/Avatar";
import { Wordmark } from "../ui/Brand";
import { Button } from "../ui/Button";
import { Sheet } from "../ui/Sheet";
import { bottomNav, moreNav, sectionOf, sidebarNav, type NavItem } from "./nav";
import { useScrollMemory } from "./useScrollMemory";
import { useAutoHideNav } from "./useAutoHideNav";
import { RightRail } from "./RightRail";
import { SuspensionBanner } from "../features/moderation/SuspensionBanner";
import { UpdateBanner } from "../features/update/UpdateBanner";
import { InAppAlerts } from "../features/inapp/InAppAlerts";
import "./AppShell.css";

export function AppShell() {
  const viewer = useViewer();
  const composer = useComposer();
  const composerRef = useRef<ComposerHandle>(null);
  const { pathname, key: visit } = useLocation();
  const { unread } = useUnread();
  const isAdmin = useIsAdmin();
  const badge = badgeText(unread);
  const unreadMessages = useUnreadMessages();
  const messagesBadge = badgeText(unreadMessages);
  const badgeFor = (to: string) => (to === "/notifications" ? badge : to === "/messages" ? messagesBadge : null);
  const labelFor = (to: string) => (to === "/notifications" ? notificationsLabel(unread) : to === "/messages" ? messagesLabel(unreadMessages) : undefined);
  const inMessages = pathname === "/messages" || pathname.startsWith("/messages/");
  const inConversation = pathname.startsWith("/messages/");

  useScrollMemory();
  const [navHidden, showNav] = useAutoHideNav(pathname === "/", visit);

  // "n" opens the composer, like most social apps on desktop.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key !== "n" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (t.closest("input, textarea, select, [contenteditable='true'], dialog")) return;
      e.preventDefault();
      composer.setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [composer]);

  const meHref = profilesEnabled ? `/u/${viewer.handle}` : "/settings";
  // While the switch state is still loading, the slot shows Worlds (the safe default).
  const market = useMarketplace().enabled === true;
  const business = !!useMyBusiness().state?.enabled;
  const withMe = (items: NavItem[]) => items.map((n) => (n.to === "/profile" ? { ...n, to: meHref } : n));
  const nav = withMe(sidebarNav(market));
  const mobileItems = withMe(bottomNav(market));
  const more = moreNav({ market, business, creator: !!dataSource.creatorProgramme });
  // Admins can open the Marketplace before it's switched on for everyone.
  if (!market && isAdmin && dataSource.marketplace) more.unshift({ to: "/market", label: "Marketplace (admins)", icon: ShoppingBag });
  const section = sectionOf(pathname, nav.some((n) => n.to === "/worlds"));
  // Own profile, its follow lists and settings all count as "Profile" in the nav.
  const onMe = pathname === "/settings" || pathname === meHref || pathname.startsWith(`${meHref}/`);
  const isActive = (to: string) => (to === meHref ? onMe : section === to);
  const navClass = (to: string) => (isActive(to) ? "active" : "");

  const bottomLink = ({ to, label, icon: Icon }: NavItem) => (
    <Link key={to} to={to} className={`bottom-link ${navClass(to)}`} aria-label={labelFor(to) ?? label} aria-current={isActive(to) ? "page" : undefined}>
      {to === meHref ? (
        <span className={`bottom-avatar${onMe ? " is-active" : ""}`}>
          <Avatar name={viewer.name} src={viewer.avatarUrl} seed={viewer.id} size="xs" />
        </span>
      ) : (
        <span className="nav-icon">
          <Icon size={23} strokeWidth={isActive(to) ? 2.3 : 1.8} aria-hidden="true" />
          {badgeFor(to) && <span className="nav-badge" aria-hidden="true">{badgeFor(to)}</span>}
        </span>
      )}
      <span className="bottom-link__label" aria-hidden="true">{label}</span>
    </Link>
  );

  return (
    <div className={`shell${inMessages ? " shell--messages" : ""}${inConversation ? " shell--conversation" : ""}`}>
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      <aside className="sidebar" aria-label="Primary">
        <div className="sidebar__inner">
          <NavLink to="/" className="sidebar__brand" aria-label="Amigo World home">
            <span className="sidebar__brand-full"><Wordmark /></span>
            <span className="sidebar__brand-compact"><Wordmark compact /></span>
          </NavLink>

          <nav className="sidebar__nav">
            {nav.map(({ to, label, icon: Icon }) => (
              <Link
                key={to}
                to={to}
                className={`side-link ${navClass(to)}`}
                title={label}
                aria-label={labelFor(to)}
                aria-current={isActive(to) ? "page" : undefined}
              >
                <span className="nav-icon">
                  <Icon size={24} strokeWidth={isActive(to) ? 2.3 : 1.8} aria-hidden="true" />
                  {badgeFor(to) && <span className="nav-badge" aria-hidden="true">{badgeFor(to)}</span>}
                </span>
                <span className="side-link__label">{label}</span>
              </Link>
            ))}
            <SidebarMore items={more} pathname={pathname} />
          </nav>

          {isAdmin && (
            <NavLink to="/admin" className={({ isActive }) => `side-link side-link--admin ${isActive ? "active" : ""}`} title="Admin">
              <span className="nav-icon">
                <ShieldCheck size={22} strokeWidth={1.8} aria-hidden="true" />
              </span>
              <span className="side-link__label">Admin</span>
            </NavLink>
          )}

          <Button className="sidebar__post" size="lg" block aria-label="Create post" onClick={() => composer.setOpen(true)} icon={<Plus size={20} aria-hidden="true" />}>
            Post
          </Button>

          <NavLink to={meHref} className="sidebar__me" aria-label={`Your profile, ${viewer.name}`}>
            <Avatar name={viewer.name} src={viewer.avatarUrl} seed={viewer.id} size="sm" />
            <span className="sidebar__me-text">
              <span className="sidebar__me-name">{viewer.name}</span>
              <span className="sidebar__me-handle">@{viewer.handle}</span>
            </span>
          </NavLink>
        </div>
      </aside>

      <main id="main" className="main" tabIndex={-1}>
        <UpdateBanner />
        <InAppAlerts />
        <SuspensionBanner />
        {securityApi && !inMessages && <SignInNotice />}
        <Suspense fallback={null}>
          <Outlet />
        </Suspense>
      </main>

      <RightRail />

      <nav className={`bottom-nav${navHidden ? " bottom-nav--hidden" : ""}`} aria-label="Primary" onFocus={showNav}>
        {mobileItems.slice(0, 2).map(bottomLink)}
        <button className="bottom-create" onClick={() => composer.setOpen(true)} aria-label="Create post">
          <Plus size={24} strokeWidth={2.4} aria-hidden="true" />
        </button>
        {mobileItems.slice(2).map(bottomLink)}
      </nav>

      {/* Esc, backdrop and Cancel all go through the composer, which asks before discarding. */}
      <Sheet open={composer.open} onClose={() => composerRef.current?.requestClose()} label="New post" fullscreenOnMobile>
        <Composer ref={composerRef} variant="sheet" autoFocus onClose={() => composer.setOpen(false)} />
      </Sheet>

      {pathname !== "/" && <PublishStatusBar />}
    </div>
  );
}

/** The sidebar's "More" menu: a short list under the main destinations. Closes on Escape, outside click or navigation. */
function SidebarMore({ items, pathname }: { items: NavItem[]; pathname: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const current = items.some((n) => pathname === n.to || pathname.startsWith(`${n.to}/`));

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      ref.current?.querySelector<HTMLButtonElement>(".side-more__btn")?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!items.length) return null;
  return (
    <div className="side-more" ref={ref}>
      <button type="button" className={`side-link side-more__btn${current ? " active" : ""}`} aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)} title="More">
        <span className="nav-icon">
          <CircleEllipsis size={24} strokeWidth={current ? 2.3 : 1.8} aria-hidden="true" />
        </span>
        <span className="side-link__label">More</span>
      </button>
      {open && (
        <ul className="side-more__menu" id={id}>
          {items.map(({ to, label, icon: Icon }) => (
            <li key={to}>
              <Link to={to} className="side-more__item" aria-current={pathname === to ? "page" : undefined}>
                <Icon size={20} aria-hidden="true" />
                {label}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
