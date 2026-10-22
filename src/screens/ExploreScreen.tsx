import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { CircleAlert, Clock, Compass, SearchX, X } from "lucide-react";
import type { Post, SearchTab } from "../data";
import { describeError } from "../features/feed/errors";
import { FeedFooter } from "../features/feed/FeedFooter";
import { addRecentSearch, clearRecentSearches, removeRecentSearch, useRecentSearches } from "../features/explore/recentSearches";
import { SearchField } from "../features/explore/SearchField";
import { useExploreFeed, useSearch } from "../features/explore/useSearch";
import { PostCard } from "../features/posts/PostCard";
import { FeedSkeleton } from "../features/posts/PostSkeleton";
import { MediaGrid } from "../features/profile/MediaGrid";
import { PersonRow } from "../features/profile/PersonRow";
import { Button } from "../ui/Button";
import { Skeleton } from "../ui/Skeleton";
import { StateMessage } from "../ui/StateMessage";
import "../shell/ScreenHeader.css";
import "./ExploreScreen.css";

const TABS: { id: SearchTab; label: string }[] = [
  { id: "top", label: "Top" },
  { id: "people", label: "People" },
  { id: "posts", label: "Posts" },
  { id: "media", label: "Media" },
];

const DEBOUNCE_MS = 300;

export default function ExploreScreen() {
  const [params, setParams] = useSearchParams();
  const query = params.get("q")?.trim() ?? "";
  const rawTab = params.get("tab");
  const tab: SearchTab = rawTab === "people" || rawTab === "posts" || rawTab === "media" ? rawTab : "top";
  const [text, setText] = useState(query);
  const inputRef = useRef<HTMLInputElement>(null);

  // Back/forward or a shared link changes the URL: keep the box in sync.
  useEffect(() => setText((t) => (t.trim() === query ? t : query)), [query]);

  // Debounce typing → URL. The URL is the source of truth for what's searched.
  useEffect(() => {
    const next = text.trim();
    if (next === query) return;
    const t = setTimeout(() => setSearch(next, tab, true), DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  function setSearch(q: string, t: SearchTab, replace: boolean) {
    const next: Record<string, string> = {};
    if (q) next.q = q;
    if (q && t !== "top") next.tab = t;
    setParams(next, { replace });
  }

  function submit() {
    const q = text.trim();
    if (!q) return;
    addRecentSearch(q);
    setSearch(q, tab, query !== "");
    inputRef.current?.blur();
  }

  return (
    <>
      <header className="screen-header explore-header">
        <h1 className="visually-hidden">Explore</h1>
        <div className="screen-header__row explore-header__row">
          <SearchField
            ref={inputRef}
            value={text}
            onChange={setText}
            onSubmit={submit}
            onClear={() => {
              setText("");
              setSearch("", "top", false);
              inputRef.current?.focus();
            }}
          />
        </div>
        {query && (
          <div className="tabs" role="tablist" aria-label="Search results">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                id={`stab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls="search-panel"
                className="tab"
                onClick={() => setSearch(query, t.id, true)}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
      </header>

      {query ? (
        // Opening any result counts as a search worth remembering.
        <div onClickCapture={(e) => (e.target as HTMLElement).closest("a, button") && addRecentSearch(query)}>
          <SearchResultsPanel query={query} tab={tab} onSeeAllPeople={() => setSearch(query, "people", true)} />
        </div>
      ) : (
        <ExploreHome
          onPickRecent={(q) => {
            setText(q);
            addRecentSearch(q);
            setSearch(q, "top", false);
          }}
        />
      )}
    </>
  );
}

// --------------------------------------------------------------- landing

function ExploreHome({ onPickRecent }: { onPickRecent: (q: string) => void }) {
  const recent = useRecentSearches();
  const { state, retry } = useExploreFeed();

  return (
    <>
      {recent.length > 0 && (
        <Section
          title="Recent searches"
          action={
            <button className="explore-section__action" onClick={clearRecentSearches}>
              Clear all
            </button>
          }
        >
          <ul className="recent-list">
            {recent.map((q) => (
              <li key={q} className="recent-item">
                <button className="recent-item__main" onClick={() => onPickRecent(q)}>
                  <Clock size={18} aria-hidden="true" />
                  <span>{q}</span>
                </button>
                <button className="recent-item__remove" onClick={() => removeRecentSearch(q)} aria-label={`Remove “${q}” from recent searches`}>
                  <X size={16} />
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {state.status === "loading" && (
        <div role="status" aria-label="Loading Explore">
          <PeopleSkeleton rows={3} />
          <FeedSkeleton />
        </div>
      )}

      {state.status === "error" && (
        <StateMessage tone="error" icon={<CircleAlert size={24} />} {...describeError(state.error, "Explore")}
          action={<Button variant="secondary" onClick={retry}>Try again</Button>} />
      )}

      {state.status === "ready" && <ExploreSections feed={state.feed} />}
    </>
  );
}

function ExploreSections({ feed }: { feed: import("../data").ExploreFeed }) {
  const nothing = !feed.suggestedPeople.length && !feed.popular.posts.length && !feed.media.length && !feed.conversations.length;
  if (nothing) {
    return (
      <StateMessage
        icon={<Compass size={24} />}
        title="Nothing to explore yet"
        body="As people join and post, you'll find them here. You can still search above."
      />
    );
  }
  return (
    <>
      {feed.suggestedPeople.length > 0 && (
        <Section title="Suggested for you">
          <ul className="explore-people">{feed.suggestedPeople.map((p) => <PersonRow key={p.id} person={p} />)}</ul>
        </Section>
      )}
      {feed.popular.posts.length > 0 && (
        <Section title={feed.popular.windowDays ? "Popular this week" : "Popular posts"} subtitle={feed.popular.windowDays ? "Most liked in the last 7 days" : "Most liked of all time"}>
          <PostList posts={feed.popular.posts} />
        </Section>
      )}
      {feed.media.length > 0 && (
        <Section title="Recent photos">
          <MediaGrid posts={feed.media} />
        </Section>
      )}
      {feed.conversations.length > 0 && (
        <Section title="Recent conversations" subtitle="New posts people are replying to">
          <PostList posts={feed.conversations} />
        </Section>
      )}
    </>
  );
}

// --------------------------------------------------------------- results

function SearchResultsPanel({ query, tab, onSeeAllPeople }: { query: string; tab: SearchTab; onSeeAllPeople: () => void }) {
  const { status, results, error, loadMore, loadingMore, retry } = useSearch(query, tab);
  const empty = status === "ready" && results.people.length === 0 && results.posts.length === 0;

  return (
    <section id="search-panel" role="tabpanel" aria-labelledby={`stab-${tab}`} aria-busy={status === "loading"}>
      <p className="visually-hidden" role="status" aria-live="polite">
        {status === "ready" ? (empty ? `No results for ${query}` : `Results for ${query}`) : ""}
      </p>

      {status === "loading" &&
        (tab === "people" ? <PeopleSkeleton rows={6} /> : tab === "media" ? <GridSkeleton /> : tab === "top" ? (<><PeopleSkeleton rows={2} /><FeedSkeleton /></>) : <FeedSkeleton />)}

      {status === "error" && (
        <StateMessage tone="error" icon={<CircleAlert size={24} />} {...describeError(error, "results")}
          action={<Button variant="secondary" onClick={retry}>Try again</Button>} />
      )}

      {empty && (
        <StateMessage
          icon={<SearchX size={24} />}
          title={`No results for “${query}”`}
          body={
            tab === "people"
              ? "Try a different name or @username."
              : tab === "media"
                ? "No photos or videos mention that. Try another word, or check Posts."
                : "Check the spelling or try another word. You can search names, @usernames and what people post."
          }
        />
      )}

      {status === "ready" && !empty && (
        <>
          {tab === "top" && results.people.length > 0 && (
            <Section title="People" action={<button className="explore-section__action" onClick={onSeeAllPeople}>See all</button>}>
              <ul className="explore-people">{results.people.map((p) => <PersonRow key={p.id} person={p} />)}</ul>
            </Section>
          )}
          {tab === "people" && <ul className="explore-people">{results.people.map((p) => <PersonRow key={p.id} person={p} />)}</ul>}
          {tab === "top" && results.posts.length > 0 && (
            <Section title="Posts">
              <PostList posts={results.posts} />
            </Section>
          )}
          {tab === "posts" && <PostList posts={results.posts} />}
          {tab === "media" && <MediaGrid posts={results.posts} />}
          {tab !== "people" && <FeedFooter hasMore={results.hasMore} loading={loadingMore} onMore={loadMore} endLabel="" />}
        </>
      )}
    </section>
  );
}

// --------------------------------------------------------------- pieces

function Section({ title, subtitle, action, children }: { title: string; subtitle?: string; action?: ReactNode; children: ReactNode }) {
  const id = `sec-${title.toLowerCase().replace(/\W+/g, "-")}`;
  return (
    <section className="explore-section" aria-labelledby={id}>
      <div className="explore-section__head">
        <div>
          <h2 id={id} className="explore-section__title">{title}</h2>
          {subtitle && <p className="explore-section__subtitle">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function PostList({ posts }: { posts: Post[] }) {
  return <div className="explore-posts">{posts.map((p) => <PostCard key={p.id} post={p} />)}</div>;
}

function PeopleSkeleton({ rows }: { rows: number }) {
  return (
    <ul className="explore-people" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="person-row">
          <Skeleton width={42} height={42} radius="50%" />
          <span style={{ display: "grid", gap: 6, flex: 1 }}>
            <Skeleton width={140} height={12} />
            <Skeleton width={90} height={10} />
          </span>
          <Skeleton width={96} height={32} radius={10} />
        </li>
      ))}
    </ul>
  );
}

function GridSkeleton() {
  return (
    <div className="media-grid" aria-hidden="true">
      {Array.from({ length: 9 }, (_, i) => <Skeleton key={i} style={{ aspectRatio: "1", width: "100%" }} radius={0} />)}
    </div>
  );
}
