import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";
import { dataSource } from "../../data";
import { useComposer } from "../../state/composer";
import { useViewer } from "../../state/session";
import { Button } from "../../ui/Button";
import "./Tour.css";

/**
 * First-visit tour: a few bubbles that point at the main parts of the app, one at a time.
 * Shown once per account on each device, on Home, after the joining steps. Steps whose
 * target isn't on screen (a layout without it, a feature switched off) are skipped, so
 * the same tour fits phones and desktops. Esc or Skip ends it; it never comes back.
 */
const KEY = (id: string) => `amigo:tour:${id}`;

export function tourDone(viewerId: string): boolean {
  // The demo (UI work, offline tests) only shows it when asked: ?demo&tour
  if (dataSource.kind === "demo" && !/[?&]tour\b/.test(location.search)) return true;
  try {
    return localStorage.getItem(KEY(viewerId)) === "done";
  } catch {
    return true; // no storage: don't risk showing it on every visit
  }
}
function markDone(viewerId: string) {
  try {
    localStorage.setItem(KEY(viewerId), "done");
  } catch {
    /* ignore */
  }
}
/** Lets Settings offer "Show the tour again". */
export function resetTour(viewerId: string) {
  try {
    localStorage.removeItem(KEY(viewerId));
  } catch {
    /* ignore */
  }
}

interface Step {
  /** CSS selectors; the first visible match is highlighted. None: a centred card. */
  target?: string;
  title: string;
  body: string;
}

const nav = (href: string) => `.sidebar a[href="${href}"], .bottom-nav a[href="${href}"]`;

function steps(name: string): Step[] {
  const first = name.split(" ")[0] || "there";
  return [
    { title: `Welcome to Amigo World, ${first}!`, body: "Here's a quick look around. It takes about 30 seconds." },
    { target: nav("/"), title: "Home", body: "Your feed: posts from people you follow, plus what's happening across Amigo. Switch between Latest and Following at the top." },
    { target: nav("/explore"), title: "Explore", body: "Find people to follow, discover Worlds and businesses, and search for anything." },
    { target: ".bottom-create, .sidebar__post", title: "Create a post", body: "Tap here to share what's on your mind: text, or up to 4 photos." },
    { target: nav("/worlds"), title: "Worlds", body: "Live, themed events. Join one, post into it and take part in its competitions." },
    { target: nav("/market"), title: "Market", body: "Browse products and services from businesses on Amigo." },
    { target: nav("/messages"), title: "Messages", body: "Private chats with your friends. They're end-to-end encrypted, so only you and them can read them." },
    { target: `${nav("/notifications")}, .screen-header a[href="/notifications"]`, title: "Notifications", body: "Likes, replies, new followers and mentions show up here." },
    { target: ".sidebar__me, .home-me", title: "Your profile", body: "Your posts and photos, edit your profile, and find Settings and the Help Hub." },
    { title: "You're all set!", body: "Start by following a few people and saying hello with your first post." },
  ];
}

function visibleTarget(selector?: string): HTMLElement | null {
  if (!selector) return null;
  for (const el of document.querySelectorAll<HTMLElement>(selector)) {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (r.width > 0 && r.height > 0 && style.visibility !== "hidden" && r.bottom > 0 && r.top < innerHeight) return el;
  }
  return null;
}

export function Tour() {
  const viewer = useViewer();
  const composer = useComposer();
  const { pathname } = useLocation();
  const [active, setActive] = useState(false);
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [bubblePos, setBubblePos] = useState<{ top: number; left: number } | null>(null);
  const list = useMemo(() => steps(viewer.name), [viewer.name]);

  // Start once, on Home, a moment after it has rendered.
  useEffect(() => {
    if (active || pathname !== "/" || composer.open || tourDone(viewer.id)) return;
    const t = setTimeout(() => setActive(true), 1200);
    return () => clearTimeout(t);
  }, [pathname, composer.open, viewer.id, active]);

  const finish = useCallback(() => {
    markDone(viewer.id);
    setActive(false);
  }, [viewer.id]);

  /** Moves to the next (or previous) step that can be shown on this screen. */
  const go = useCallback(
    (from: number, dir: 1 | -1) => {
      let i = from + dir;
      while (i > 0 && i < list.length - 1 && !visibleTarget(list[i].target)) i += dir;
      if (i < 0) i = 0;
      if (i >= list.length) return finish();
      setIndex(i);
    },
    [list, finish],
  );

  const step = list[index];

  // Track the highlighted element (scrolling, resizing, the phone bar sliding).
  useLayoutEffect(() => {
    if (!active) return;
    const measure = () => {
      const el = visibleTarget(step.target);
      const r = el ? el.getBoundingClientRect() : null;
      // Only re-render when the highlight actually moved.
      setRect((prev) =>
        prev && r && prev.top === r.top && prev.left === r.left && prev.width === r.width && prev.height === r.height ? prev : !prev && !r ? prev : r,
      );
    };
    measure();
    const id = setInterval(measure, 250);
    addEventListener("resize", measure);
    addEventListener("scroll", measure, true);
    return () => {
      clearInterval(id);
      removeEventListener("resize", measure);
      removeEventListener("scroll", measure, true);
    };
  }, [active, step]);

  // Place the bubble beside the highlight, inside the screen.
  useLayoutEffect(() => {
    const b = bubbleRef.current;
    if (!active || !b) return;
    const bw = b.offsetWidth;
    const bh = b.offsetHeight;
    const pad = 12;
    if (!rect) {
      setBubblePos({ top: Math.max(pad, (innerHeight - bh) / 2), left: Math.max(pad, (innerWidth - bw) / 2) });
      return;
    }
    let top: number;
    let left: number;
    const inSidebar = rect.right < innerWidth * 0.35 && rect.height < 120 && innerWidth >= 768;
    if (inSidebar) {
      // Desktop sidebar: to the right of the item.
      left = rect.right + 16;
      top = rect.top + rect.height / 2 - bh / 2;
    } else if (rect.top > innerHeight / 2) {
      // Phone bottom bar: above it.
      top = rect.top - bh - 14;
      left = rect.left + rect.width / 2 - bw / 2;
    } else {
      // Header: below it.
      top = rect.bottom + 14;
      left = rect.left + rect.width / 2 - bw / 2;
    }
    left = Math.min(Math.max(pad, left), innerWidth - bw - pad);
    top = Math.min(Math.max(pad, top), innerHeight - bh - pad);
    setBubblePos({ top, left });
  }, [active, rect, index]);

  // Keyboard: Esc ends, arrows move. Focus stays in the bubble.
  useEffect(() => {
    if (!active) return;
    bubbleRef.current?.querySelector<HTMLElement>("[data-primary]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
      else if (e.key === "ArrowRight") go(index, 1);
      else if (e.key === "ArrowLeft" && index > 0) go(index, -1);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [active, index, go, finish]);

  if (!active) return null;

  const last = index === list.length - 1;
  const shown = list.filter((s, i) => i === 0 || i === list.length - 1 || !!visibleTarget(s.target));
  const position = shown.indexOf(step) + 1;
  const hole = rect ? { top: rect.top - 6, left: rect.left - 6, width: rect.width + 12, height: rect.height + 12 } : null;

  return (
    <div className="tour" role="presentation">
      {hole ? <div className="tour__hole" style={hole} aria-hidden="true" /> : <div className="tour__dim" aria-hidden="true" />}
      <div
        ref={bubbleRef}
        className={`tour__bubble${bubblePos ? "" : " is-measuring"}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        style={bubblePos ?? undefined}
      >
        <p className="tour__count">
          {position} of {shown.length}
        </p>
        <h2 id="tour-title" className="tour__title">
          {step.title}
        </h2>
        <p id="tour-body" className="tour__body">
          {step.body}
        </p>
        <div className="tour__actions">
          {index === 0 ? (
            <Button type="button" variant="ghost" size="sm" onClick={finish}>
              Skip tour
            </Button>
          ) : !last ? (
            <Button type="button" variant="ghost" size="sm" onClick={finish}>
              Skip
            </Button>
          ) : (
            <span />
          )}
          <span className="tour__nav">
            {index > 0 && !last && (
              <Button type="button" variant="secondary" size="sm" onClick={() => go(index, -1)}>
                Back
              </Button>
            )}
            {last ? (
              <Button
                type="button"
                size="sm"
                data-primary=""
                onClick={() => {
                  finish();
                  composer.setOpen(true);
                }}
              >
                Write my first post
              </Button>
            ) : (
              <Button type="button" size="sm" data-primary="" onClick={() => go(index, 1)}>
                {index === 0 ? "Show me around" : "Next"}
              </Button>
            )}
          </span>
        </div>
        {last && (
          <button type="button" className="tour__later" onClick={finish}>
            Maybe later
          </button>
        )}
      </div>
    </div>
  );
}
