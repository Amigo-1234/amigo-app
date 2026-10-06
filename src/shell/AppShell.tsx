import { Suspense, useEffect } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { profilesEnabled } from "../features/profile/links";
import { Plus } from "lucide-react";
import { Composer } from "../features/composer/Composer";
import { useComposer } from "../state/composer";
import { useViewer } from "../state/session";
import { Avatar } from "../ui/Avatar";
import { Wordmark } from "../ui/Brand";
import { Button } from "../ui/Button";
import { Sheet } from "../ui/Sheet";
import { NAV } from "./nav";
import { RightRail } from "./RightRail";
import "./AppShell.css";

export function AppShell() {
  const viewer = useViewer();
  const composer = useComposer();
  const { pathname } = useLocation();

  useEffect(() => window.scrollTo(0, 0), [pathname]);

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
  const nav = NAV.map((n) => (n.to === "/profile" ? { ...n, to: meHref } : n));
  const mobileItems = nav.filter((n) => n.mobile);
  // Own profile, its follow lists and settings all count as "Profile" in the nav.
  const onMe = pathname === "/settings" || pathname === meHref || pathname.startsWith(`${meHref}/`);
  const navClass = (to: string) => ({ isActive }: { isActive: boolean }) =>
    `${isActive || (to === meHref && onMe) ? "active" : ""}`;

  return (
    <div className="shell">
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
              <NavLink key={to} to={to} end={to === "/"} className={(a) => `side-link ${navClass(to)(a)}`} title={label}>
                {({ isActive: routeActive }) => {
                  const isActive = routeActive || (to === meHref && onMe);
                  return (
                  <>
                    <Icon size={24} strokeWidth={isActive ? 2.3 : 1.8} aria-hidden="true" />
                    <span className="side-link__label">{label}</span>
                  </>
                  );
                }}
              </NavLink>
            ))}
          </nav>

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
        <Suspense fallback={null}>
          <Outlet />
        </Suspense>
      </main>

      <RightRail />

      <nav className="bottom-nav" aria-label="Primary">
        {mobileItems.slice(0, 2).map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to} end={to === "/"} className={(a) => `bottom-link ${navClass(to)(a)}`} aria-label={label}>
            {({ isActive }) => <Icon size={25} strokeWidth={isActive ? 2.3 : 1.8} aria-hidden="true" />}
          </NavLink>
        ))}
        <button className="bottom-create" onClick={() => composer.setOpen(true)} aria-label="Create post">
          <Plus size={24} strokeWidth={2.4} aria-hidden="true" />
        </button>
        {mobileItems.slice(2).map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to} className={(a) => `bottom-link ${navClass(to)(a)}`} aria-label={label}>
            {({ isActive }) =>
              to === meHref ? (
                <span className={`bottom-avatar${isActive || onMe ? " is-active" : ""}`}>
                  <Avatar name={viewer.name} src={viewer.avatarUrl} seed={viewer.id} size="xs" />
                </span>
              ) : (
                <Icon size={25} strokeWidth={isActive ? 2.3 : 1.8} aria-hidden="true" />
              )
            }
          </NavLink>
        ))}
      </nav>

      <Sheet open={composer.open} onClose={() => composer.setOpen(false)} label="New post" fullscreenOnMobile>
        <Composer variant="sheet" autoFocus onPosted={() => composer.setOpen(false)} onCancel={() => composer.setOpen(false)} />
      </Sheet>
    </div>
  );
}
