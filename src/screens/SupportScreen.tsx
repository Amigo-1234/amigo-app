import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { CircleAlert, HandHeart, Plus, Search, X } from "lucide-react";
import type { SupportCategory, SupportSection } from "../data";
import { SUPPORT_CATEGORIES } from "../data/supportRules";
import { describeError } from "../features/feed/errors";
import { FeedFooter } from "../features/feed/FeedFooter";
import { SupportCard } from "../features/support/SupportCard";
import { useSupportConfig, useSupportRequests, useWallet } from "../features/support/useSupport";
import { ScreenHeader } from "../shell/ScreenHeader";
import { Button } from "../ui/Button";
import { Skeleton } from "../ui/Skeleton";
import { StateMessage } from "../ui/StateMessage";
import "../features/support/Support.css";

const SECTIONS: { id: SupportSection; label: string }[] = [
  { id: "for_you", label: "For you" },
  { id: "needs", label: "Needs support" },
  { id: "new", label: "New" },
  { id: "completed", label: "Completed" },
  { id: "mine", label: "Yours" },
];

const EMPTY: Record<SupportSection, { title: string; body: string }> = {
  for_you: { title: "You're all caught up", body: "You've supported everything open right now. Check New or come back later." },
  needs: { title: "Nothing needs support right now", body: "Every open request is covered. Nice." },
  new: { title: "No new requests", body: "Be the first to ask for support." },
  completed: { title: "Nothing completed yet", body: "Requests show up here once they reach their supporter goal." },
  mine: { title: "You haven't asked for support yet", body: "Share a song, video, app or project and get real feedback." },
};

export default function SupportScreen() {
  const [params, setParams] = useSearchParams();
  const section = (SECTIONS.find((s) => s.id === params.get("section"))?.id ?? "for_you") as SupportSection;
  const category = (SUPPORT_CATEGORIES.find((c) => c.id === params.get("category"))?.id ?? null) as SupportCategory | null;
  const q = params.get("q") ?? "";
  const [text, setText] = useState(q);
  const list = useSupportRequests(section, category, q);
  const wallet = useWallet(list.state.status === "ready" ? list.state.data : null);
  const config = useSupportConfig();

  // Debounced search, kept in the URL.
  useEffect(() => {
    const t = setTimeout(() => {
      if (text.trim() !== q) update({ q: text.trim() || null });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  // Start from the live URL (not this render's params): navigations commit in a transition, and a
  // debounced search must not undo a filter change made a moment earlier.
  function update(patch: Record<string, string | null>) {
    const next = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    setParams(next, { replace: true });
  }

  return (
    <>
      <ScreenHeader
        title="Support Hub"
        actions={
          <Link to="/support/new" className="btn btn--primary btn--sm">
            <Plus size={16} aria-hidden="true" /> Ask for support
          </Link>
        }
      >
        <div className="tabs support-tabs" role="tablist" aria-label="Support Hub sections">
          {SECTIONS.map((s) => (
            <button key={s.id} role="tab" aria-selected={section === s.id} className="tab" onClick={() => update({ section: s.id === "for_you" ? null : s.id })}>
              {s.label}
            </button>
          ))}
        </div>
      </ScreenHeader>

      <section className="support-intro" aria-label="Your Support">
        <p className="support-intro__text">
          Help people with their songs, videos, apps and projects — and get real feedback on yours. No follow-for-follow, no fake streams.
        </p>
        <dl className="support-wallet">
          <div>
            <dt>Credits</dt>
            <dd>{wallet ? wallet.credits : <Skeleton width={20} height={16} />}</dd>
          </div>
          <div>
            <dt>Reputation</dt>
            <dd>{wallet ? wallet.reputation : <Skeleton width={20} height={16} />}</dd>
          </div>
          <div>
            <dt>People helped</dt>
            <dd>{wallet ? wallet.helpedCount : <Skeleton width={20} height={16} />}</dd>
          </div>
        </dl>
        {config && (
          <p className="support-intro__rules">
            Supporting someone earns {config.supportCredits} credit and {config.supportReputation} reputation (+{config.feedbackCredits} credit for written feedback). Asking for support costs {config.requestCost} credits.
          </p>
        )}
      </section>

      <div className="support-filters">
        <label className="support-search">
          <Search size={17} aria-hidden="true" />
          <span className="visually-hidden">Search requests</span>
          <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search requests" enterKeyHint="search" />
          {text && (
            <button type="button" className="support-search__clear" aria-label="Clear search" onClick={() => setText("")}>
              <X size={16} />
            </button>
          )}
        </label>
        <div className="support-chips" role="group" aria-label="Category">
          <button type="button" className="chip" aria-pressed={!category} onClick={() => update({ category: null })}>
            All
          </button>
          {SUPPORT_CATEGORIES.map((c) => (
            <button key={c.id} type="button" className="chip" aria-pressed={category === c.id} onClick={() => update({ category: category === c.id ? null : c.id })}>
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {list.state.status === "loading" && (
        <ul className="support-list" aria-label="Loading requests" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <li key={i} className="support-card" aria-hidden="true">
              <span className="support-card__link">
                <Skeleton width={160} height={14} />
                <Skeleton width="80%" height={18} />
                <Skeleton width="95%" height={12} />
                <Skeleton width="60%" height={8} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {list.state.status === "error" && (
        <StateMessage tone="error" icon={<CircleAlert size={24} />} {...describeError(list.state.error, "requests")}
          action={<Button variant="secondary" onClick={list.retry}>Try again</Button>} />
      )}
      {list.state.status === "ready" && list.state.data.requests.length === 0 && (
        <StateMessage
          icon={<HandHeart size={24} />}
          {...(q || category ? { title: "No matching requests", body: "Try another category or search." } : EMPTY[section])}
          action={section === "mine" && !q && !category ? <Link to="/support/new" className="btn btn--secondary btn--md">Ask for support</Link> : undefined}
        />
      )}
      {list.state.status === "ready" && list.state.data.requests.length > 0 && (
        <>
          <ul className="support-list" aria-label={SECTIONS.find((s) => s.id === section)!.label}>
            {list.state.data.requests.map((r) => (
              <SupportCard key={r.id} r={r} />
            ))}
          </ul>
          <FeedFooter hasMore={list.state.data.hasMore} loading={false} onMore={list.loadMore} endLabel="" loadingLabel="Loading more requests" />
        </>
      )}
    </>
  );
}
