# Worlds (MVP)

Worlds are scheduled live social events, **created by Amigo admins only**. People join, post,
chat, meet each other and, in competition Worlds, compete for a spot on a temporary leaderboard.

Not in this phase: public or creator-made Worlds, payments or prize payouts, tournament brackets,
and the persistent winner achievement on profiles (designed below, not built).

## What people can do

| | Upcoming | Live | Finished |
| --- | --- | --- | --- |
| See the World, countdown, participants | ✓ | ✓ | ✓ |
| Join / leave | ✓ | ✓ | — (frozen) |
| Post in the World (members) | — | ✓ | — |
| Submit an entry (competition, members) | — | ✓ until entries close, up to the entry limit | — |
| Like / reply to World posts | — | ✓ (anyone) | ✓, but no longer scores |
| Chat (members) | — | ✓ | read-only history |

Status (upcoming → live → finished) is derived from `startsAt` / `endsAt` on the client, so a
World flips state on time without a reload. Countdowns tick every second (screen readers get a
coarser spoken version).

**Pages:** `/worlds` lists Live now, Upcoming and Finished. `/worlds/:slug` shows the event
(cover, status and countdown, description, time, participants, Join), the competition panel
(entries countdown, scoring, prize text), a winner card once a competition ends, and tabs:
**Live** (composer for members, "Meet people here" with follow buttons, the World's posts),
**Entries** and **Leaderboard** (competition only), **Chat**.

World posts are ordinary posts: they appear in Home, profiles and search with a chip linking to
their World ("Entry" badge for entries), and likes/replies on them send the usual notifications.
Names everywhere (posts, leaderboard, chat, people list) link to profiles.

On phones the bottom bar shows Worlds in the slot Messages had; Messages is still in the sidebar.
Backends without Worlds (legacy Firebase) don't show the nav item or routes.

## Scoring

Points exist only inside one World and are **computed, never stored**:

```
per entry = likes from others × reaction
          + replies from others × reply
          + (Amigo picked it ? hostPick : 0)
person    = sum over their entries
```

- Each World sets `reaction`, `reply`, `hostPick` and `entryLimit`. Demo Worlds use 1 / 2 / 10–15
  and one entry per person.
- Your own likes and replies on your own entry don't count. Follower counts play no part.
- Only likes and replies made **before the World ends** count, so the board freezes at the end
  and the winner is final.
- Ranking: points, then whoever entered first. No ties.
- Amigo picks are an admin action (a row in `world_host_picks`).

## Supabase — migration `20261006160000_worlds.sql`

Additive: new tables `worlds`, `world_members`, `world_host_picks`, `world_chat_messages`; two
new columns on `posts` (`world_id` nullable, `is_entry` default false); triggers; two RPCs.

| Table | anon | authenticated |
| --- | --- | --- |
| worlds | read | read; **no writes** (admins use the service role / SQL editor) |
| world_members | — | read; join/leave **as self**, only before the World ends |
| world_host_picks | read | read; no writes |
| world_chat_messages | — | read; insert **as self**, only as a member while live; no edit/delete |
| posts (World columns) | — | set only through `create_world_post`/insert; rules enforced by trigger |

- `posts_world_before_insert` trigger: replies inherit their thread's World and are never
  entries; top-level World posts need a live World and membership; entries need competition mode,
  open entries and a free slot (serialised per person with an advisory lock). World posts are
  forced public. Errors `AW001`–`AW005` map to `WorldError` codes in the app.
- `world_members` counter trigger keeps `worlds.participant_count`.
- `create_world_post(world, body, media, entry)` — like `create_post`, for Worlds.
- `world_leaderboard(world, limit)` — `SECURITY DEFINER` (anon can't read likes), returns only
  per-person totals for public World entries.
- Realtime: `world_chat_messages` and `worlds` added to the publication; leaderboards and World
  feeds refresh from `posts` changes filtered by `world_id`.
- Deleting a World keeps its posts (they lose the World link).

### Creating a World (admins)

```sql
insert into public.worlds (slug, title, tagline, description, cover_url, starts_at, ends_at,
                           competition, entries_close_at, entry_limit,
                           points_reaction, points_reply, points_host_pick, prize)
values ('rage-bait-night', 'Rage Bait Night', 'Post your most outrageous (harmless) hot take.', '…',
        'https://…/cover.jpg', '2026-10-10 19:00+01', '2026-10-10 21:00+01',
        true, '2026-10-10 20:15+01', 1, 1, 2, 15, 'Rage Bait Champion title for a week');

-- Amigo pick bonus:
insert into public.world_host_picks (world_id, post_id) values ('<world id>', '<entry post id>');
```

## Not built yet (designed)

- **Winner achievements:** a `profile_achievements (user_id, world_id, kind, awarded_at)` table
  filled by a scheduled job once a competition ends (top of `world_leaderboard`), shown on profiles.
- **Notifications** for "a World you joined is starting" / "you won": new `notification_kind`
  values written by that same job (system notifications have no actor).
- Admin UI for creating Worlds and picking entries (today: SQL).
- Chat moderation (delete/report), rate limits beyond RLS, and pruning old chat.

## Testing

- Demo (browser): `__amigoDemo.worlds.chat(person, slug, text)`, `.joinWorld(person, slug)`,
  `.shiftWorld(slug, ms)` (move a World in time to watch it go live/close/end) and
  `.quiet()` (stop the demo's background chat trickle). `__amigoDemo.act(...)` likes/replies
  score like real actions.
- Supabase: `supabase/tests/database.test.sql` and `scripts/test/supabase-api.test.mjs` cover the
  rules above against local Postgres + PostgREST. Realtime is untested locally.
