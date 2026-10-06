# Database design

Source of truth: [`supabase/migrations`](../../supabase/migrations). Generated
types: [`src/data/supabase/database.types.ts`](../../src/data/supabase/database.types.ts).

```
auth.users ──1:1── profiles ──< posts >── post_media
                      │  │        │ ╲
                      │  │        │  ╰─ parent_id / root_id → posts   (replies)
                      │  │        ╰──── repost_of_id → posts         (reposts, quotes)
                      │  ╰──< post_likes >── posts
                      ╰──< follows >── profiles
legacy.*  (private: Firebase id maps + archives, not exposed by the API)
```

## Tables

| Table | Key | Notes |
| --- | --- | --- |
| `profiles` | `id` = `auth.users.id` | `username` (unique, `[a-z0-9_]{3,24}`), `display_name`, `bio`, `avatar_url`, counters. **No email.** Created by trigger on sign-up. |
| `posts` | uuid | `body` ≤ 2000 (the app enforces 500), `parent_id`/`root_id` for replies, `repost_of_id`, `visibility` (`public` \| `followers`), counters, soft delete via `deleted_at`. |
| `post_media` | uuid | up to 4 per post (`position` 0–3), `kind` image/video, Storage `bucket` + `storage_path`, `width`/`height`/`duration_ms`/`byte_size`/`alt`. The path must sit in the owner's folder. |
| `post_likes` | (`user_id`, `post_id`) | the primary key makes a like unique per person; toggled through `set_post_like()`. |
| `follows` | (`follower_id`, `followee_id`) | unique pair, no self-follows. |

Counters (`like_count`, `reply_count`, `repost_count`, `post_count`,
`follower_count`, `following_count`) are kept in step by triggers and are
**not writable by clients** (column grants). Validation re-derives them from rows.

## Replies are posts (`parent_id`), not a separate table

Chosen because, on a social network, a reply *is* a post:

- It needs everything a post has: likes, reposts, quotes, media, deletion, moderation and
  notifications. A separate `comments` table would duplicate all of that, plus every
  policy and every UI path.
- Threads can go deeper than one level: `root_id` lets a whole conversation load with one
  indexed query, and `parent_id` gives the direct tree.
- Home-feed queries stay cheap with a partial index (`where parent_id is null`).
- Later "posts & replies" profile tabs, search and notifications query one table.

The cost is that feed queries must filter `parent_id is null`. The partial
indexes make that free.

## API surface

Reads go straight to tables (RLS) or to `SECURITY INVOKER` functions:

| Function | Purpose |
| --- | --- |
| `feed_posts(scope, limit, before)` | Home timeline; `scope` = `latest` \| `following`. Returns `posts` rows, so PostgREST can embed author/media. |
| `create_post(body, parent_id, media, visibility)` | Post or reply plus media in one transaction; validates length and media. |
| `set_post_like(post_id, liked)` | Idempotent like toggle. |
| `delete_post(post_id)` | Author-only soft delete. |
| `suggested_profiles(limit)` | People you don't follow yet (signed-in only). |
| `unread_notification_count()` | Your unread notifications (a number). |
| `mark_notifications_read(ids)` | Mark some (or, with null, all) of your notifications read. |

Search and Explore are plain RLS-protected table reads, documented in [SEARCH.md](SEARCH.md).
Notifications are written by triggers and read from the `notifications` table; see
[NOTIFICATIONS.md](NOTIFICATIONS.md).

## Row Level Security review

Every table in `public` has RLS on (asserted by the test suite). Grants are
revoked first and added back per column.

| Table | anon | authenticated |
| --- | --- | --- |
| profiles | read | read; update **own** row, only `username`/`display_name`/`bio`/`avatar_url` |
| posts | read public, non-deleted | read public + own + followers-only of people they follow; insert as **self** only, only into visible threads; no update/delete (soft delete through `delete_post`) |
| post_media | read if the post is visible | insert only on **own** posts, path in **own** folder |
| post_likes | — | read likes on visible posts; insert/delete **own** only |
| follows | — | read graph; insert/delete as **self** only |
| notifications | — | read **own**, still-true rows; update `read_at` on own rows; no insert/delete (triggers only) |
| legacy.* | — | — (no schema usage; not exposed by the API) |
| storage.objects | public bucket URLs only, no listing | write/replace/delete in **own** `<uid>/` folder; list own folder only |

`using (true)` appears exactly once: reading `profiles`, which by design holds
only public information.

`SECURITY DEFINER` functions (`can_view_post`, `viewer_follows`, triggers,
`delete_post`, and the service-role-only `legacy_*` migration and sign-in helpers) all pin `search_path = ''`. Each answers one narrow
question or performs one owner-checked action. Execute is revoked from
everyone and granted back function by function.

Function execute rights are explicit: PostgreSQL's built-in `PUBLIC` execute default is revoked
(migration `20261006140000`), and the test suite fails if any `public` function is executable by
`PUBLIC`. **Every migration that adds a function must `revoke … from public` and grant explicitly.**

Tested by `supabase/tests/database.test.sql` (94 checks) and
`scripts/test/supabase-api.test.mjs` (95 checks through PostgREST).

## Realtime

`posts` and `notifications` are in the `supabase_realtime` publication. Likes, replies and
reposts surface as counter updates on the post row, so clients never stream
the likes table; each person subscribes only to their own notifications. Realtime respects
the same RLS select policies.

## Storage

| Bucket | Access | Limits | Path |
| --- | --- | --- | --- |
| `post-media` | public read by URL, no listing | 50 MB; jpeg/png/webp/gif/mp4/webm/mov | `<uid>/<uuid>.<ext>`, migrated: `<uid>/legacy/<firebaseId>-<n>.<ext>` |
| `avatars` | public read by URL, no listing | 5 MB; jpeg/png/webp | `<uid>/<uuid>.<ext>` |

Followers-only posts currently store media in the public bucket. Before
followers-only posting ships in the UI, move that media to a private bucket
served through signed URLs.

## Future tables (designed, not built)

Each slots in without touching existing tables:

```sql
-- Reposts: already supported — posts.repost_of_id (+ unique pure repost per user).

create table public.bookmarks (
  user_id uuid references public.profiles on delete cascade,
  post_id uuid references public.posts on delete cascade,
  created_at timestamptz default now(),
  primary key (user_id, post_id));
-- RLS: owner-only select/insert/delete. Backfill from legacy.saved_post_archive.

create table public.conversations (id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(), last_message_at timestamptz);
create table public.conversation_members (
  conversation_id uuid references public.conversations on delete cascade,
  user_id uuid references public.profiles on delete cascade,
  joined_at timestamptz default now(), last_read_at timestamptz,
  primary key (conversation_id, user_id));
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.conversations on delete cascade,
  sender_id uuid references public.profiles on delete cascade,
  body text, media_path text, created_at timestamptz default now(), deleted_at timestamptz);
-- RLS: everything gated on is_member(conversation_id) (SECURITY DEFINER helper).
-- Private bucket "message-media" with signed URLs. Never public. Realtime: messages filtered by conversation.

create table public.moments (
  id uuid primary key default gen_random_uuid(),
  author_id uuid references public.profiles on delete cascade,
  media_path text not null, caption text,
  created_at timestamptz default now(),
  expires_at timestamptz not null default now() + interval '24 hours');
create table public.moment_views (
  moment_id uuid references public.moments on delete cascade,
  viewer_id uuid references public.profiles on delete cascade,
  viewed_at timestamptz default now(),
  primary key (moment_id, viewer_id));
-- RLS: moments visible while expires_at > now() to followers; views readable by the moment's author only.
-- Expiry cleanup via pg_cron; media in a private bucket with short-lived signed URLs.
```
