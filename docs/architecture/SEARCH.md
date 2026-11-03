# Search and discovery

## What ships now (no schema changes)

Interface: `DiscoveryApi` in [`src/data/types.ts`](../../src/data/types.ts), an optional
`DataSource` capability. Demo and Supabase implement it; the legacy Firebase source doesn't,
so Explore stays a placeholder there.

| Feature | Supabase query ([`queries.ts`](../../src/data/supabase/queries.ts)) |
| --- | --- |
| People | `profiles` where `username ILIKE %q%` or `display_name ILIKE %q%`, ordered by followers; usernames starting with the query ranked first |
| Posts | `posts.body ILIKE %q%` (replies included, with "Replying to"); **Top** = most liked, **Posts** = newest |
| Media | the same, inner-joined to `post_media` |
| Explore | `suggested_profiles()`, the most-liked top-level posts of the last 7 days (falls back to all-time and says so), the newest posts with replies, and the newest posts with media |

- **Safety and correctness:** RLS applies to every query: deleted and followers-only posts never
  leak into results. User input is escaped (`%`, `_`, `\`), and the `or()` filter values are
  quoted, so queries like `%` or `a,b(c)` are literal.
- **Client:** input is debounced by 300 ms, and the URL (`/explore?q=…&tab=…`) is the source of
  truth. Responses from superseded queries are dropped, and recent searches live in
  `localStorage` only.

This is fine for thousands of rows. `ILIKE '%q%'` can't use a btree index, so every
search is a sequential scan, and it gets slow somewhere in the tens to hundreds of
thousands of posts.

## Recommended before search gets big (not applied — needs approval)

Each step is additive and independent. Measure first with `explain analyze` on real data.

### 1. Trigram indexes: keep substring search, make it indexed

```sql
create extension if not exists pg_trgm with schema extensions;

create index profiles_username_trgm on public.profiles using gin (username extensions.gin_trgm_ops);
create index profiles_display_name_trgm on public.profiles using gin (display_name extensions.gin_trgm_ops);
create index posts_body_trgm on public.posts using gin (body extensions.gin_trgm_ops) where deleted_at is null;
```

The existing `ILIKE '%q%'` queries use these automatically, with no code change. Queries of 3+
characters benefit; 1–2 character queries still scan, so the UI could require 2+ characters.

### 2. Full-text search for posts: word matching and relevance

```sql
alter table public.posts
  add column search tsvector generated always as (to_tsvector('simple', body)) stored;
create index posts_search_idx on public.posts using gin (search) where deleted_at is null;

create function public.search_posts(p_query text, p_order text default 'top', p_limit int default 20)
returns setof public.posts language sql stable security invoker set search_path = '' as $$
  select p.* from public.posts p
  where p.search @@ websearch_to_tsquery('simple', p_query) and p.deleted_at is null
  order by case when p_order = 'top' then ts_rank(p.search, websearch_to_tsquery('simple', p_query)) * ln(2 + p.like_count) end desc nulls last,
           p.created_at desc
  limit least(p_limit, 100);
$$;
revoke execute on function public.search_posts(text, text, int) from public;
grant execute on function public.search_posts(text, text, int) to authenticated;
```

- The `simple` config (no stemming) suits a multilingual community. Switch per language later if needed.
- `websearch_to_tsquery` supports `"quoted phrases"`, `-exclude` and `or`.
- The client would call `rpc('search_posts').select(POST_SELECT)` (same embedding as the feed),
  so only `searchPosts` in `queries.ts` changes.

### 3. Explore ranking

"Popular this week" sorts the last 7 days by `like_count` using `posts_timeline_idx` plus a
filter. When Explore traffic grows, precompute it: a materialized view refreshed by `pg_cron`
every few minutes. Any score must come from real counts.

### Not needed yet

A separate search engine (Typesense, Meilisearch, Elastic), hashtags/mentions tables, and
personalised ranking. Revisit when trigram/FTS stops being enough or when those features are
designed.
