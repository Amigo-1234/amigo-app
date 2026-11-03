# Notifications

What the product has today: **follows, likes, replies (to your post or to your reply) and
@mentions**. Reposts, messages, Moments and system notices get notifications when those features
exist; nothing is shown for features that don't.

## Where notifications come from

Only the backend creates them, from real actions:

| Event | Recipient | `post_id` (what the row opens) |
| --- | --- | --- |
| A follows B | B | — (opens A's profile) |
| A likes B's post | B | the liked post |
| A replies to B's post or reply | B (the direct parent's author only, not the whole thread) | A's reply |
| A mentions `@b` in a post or reply | B, if B can see the post | the post |

Rules, identical in the demo and Supabase backends:

- **No self-notifications** (liking your own post, replying to yourself, mentioning yourself).
- **No duplicates.** One row per (recipient, actor, kind, post): like → unlike → like, or
  follow → unfollow → follow, never notifies twice.
- **Only while it's true.** An undone like or follow, or a deleted post, drops out of the list
  and the unread count. Re-doing it brings back the same row (same time, same read state), so
  toggling can't be used to spam someone.
- A reply that also mentions the person it replies to is one notification (the reply).
- A followers-only post only notifies mentioned people who follow the author.
- Mentions: `@` + 3–24 of `a-z 0-9 _`, case-insensitive, not preceded by a letter, digit, `_`,
  `@` or `.` (so `me@site.com` isn't a mention); at most 10 people per post. The same rule renders
  mentions as profile links ([`src/lib/mentions.ts`](../../src/lib/mentions.ts) ↔
  `public.mentioned_usernames()`).
- Imported history (the Firebase migration) creates no notifications.

## Supabase schema — migration `20261006150000_notifications.sql`

Additive only; nothing existing changes.

- `notification_kind` enum: `follow`, `like`, `reply`, `mention`.
- `notifications` table: `id uuid`, `recipient_id`, `actor_id`, `kind`, `post_id` (null only for
  follows), `created_at`, `read_at`. Check constraints forbid self-notifications and a follow
  with a post / a post kind without one. Unique `(recipient_id, actor_id, kind, post_id) nulls not distinct`.
  Indexes: inbox `(recipient_id, created_at desc, id desc)`, partial unread `(recipient_id) where read_at is null`,
  plus `actor_id`/`post_id` for cascades. UUID ids, so nothing leaks how many notifications exist.
- `AFTER INSERT` triggers on `follows`, `post_likes` and `posts` (`SECURITY DEFINER`,
  `search_path = ''`). Each only acts when `auth.uid()` **is** the actor, so a notification can
  only ever describe something the signed-in person did; service-role writes (legacy import)
  are skipped.
- Helpers `notify()`, `profile_can_view_post()`, `mentioned_usernames()`: not callable by any client.
- RPCs (`SECURITY INVOKER`, `authenticated` only): `mark_notifications_read(ids uuid[] = null)`
  (null = all) and `unread_notification_count()`.
- Added to the `supabase_realtime` publication.

### Security

| | anon | authenticated |
| --- | --- | --- |
| select | — | **own rows only**, and only live ones (policy checks the like/follow still exists and `can_view_post`) |
| insert / delete | — | — (no grant, no policy: only triggers write) |
| update | — | `read_at` column only, own rows only |

Another person's notifications can't be read, counted, marked or deleted; the tests check each
of these. Nothing in a notification row is private beyond "who did what to which post", and it
holds no email or device data.

## App side

- `DataSource.notifications?: NotificationsApi` — optional capability, like `profiles` and
  `discovery`. Demo and Supabase implement it; the legacy Firebase source doesn't, and
  `/notifications` stays a placeholder there.
- Backends return **individual events**. Grouping ("Mira Iyer and 5 others liked your post") is
  done in the UI ([`group.ts`](../../src/features/notifications/group.ts)): likes on the same post,
  and follows, within 24 hours of the newest one. Replies and mentions are never grouped.
- `NotificationsProvider` holds one live unread count for the whole app (sidebar badge, Home bell
  on phones). Opening a row marks all its events read; "Mark all read" marks everything. The
  badge drops immediately and the backend's next value replaces it. Badges show the number of
  unread events, never an estimate, and hide when the count can't load.
- Destinations: follow → the follower's profile (a group of follows → your followers list);
  like → the post; reply → the exact reply (with a link up to what it answers); mention → the post.

## Realtime

The Supabase source opens a Realtime channel on `notifications` filtered by
`recipient_id = <viewer>` (Realtime applies the select policy, so nobody receives anyone else's
rows) and refetches on insert/update. Your own writes (marking read) refresh immediately through
the local invalidation bus. There is no polling.

Known gap: when someone *undoes* a like or follow, no notification row changes, so an open tab
keeps showing it until the next refetch (any new notification, marking read, or reopening the
screen). Acceptable today; if it matters, the like/follow delete triggers can touch the row.

**Not testable locally:** the local stack (Postgres + PostgREST) has no Realtime server. Live
updates are tested end to end in the demo backend; on Supabase they need the real project.

## Push notifications (later)

Not built. When added: a `push_subscriptions` table (owner-only RLS, endpoint + keys), and a
Database Webhook / Edge Function on `notifications` insert that sends a minimal payload — the
notification id and kind only. The device fetches details through the API, so lock screens and
push providers never see post text or names.

## Future kinds

Add with `alter type public.notification_kind add value '…'` plus a nullable reference column
where a post doesn't fit (e.g. `conversation_id` for messages, `moment_id` for Moments), and
extend the select policy's liveness check. Messages will likely use per-conversation unread
state rather than one row per message. System notices would be written by service-role code
with a dedicated `system` kind and no actor.

## Retention (later)

Nothing is pruned yet. A scheduled job deleting read notifications older than ~90 days keeps the
table small.
