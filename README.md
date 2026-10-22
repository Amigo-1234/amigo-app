# Amigo World

A social network for posts, moments and conversations with your people.

- **Phase 1:** the design system, app shell and Home feed.
- **Phase 2 (this branch):** the Supabase backend (Postgres, Auth, Storage, Realtime, RLS) and
  a verified, repeatable migration from the legacy Firebase project.

Production stays on Firebase until the [cutover runbook](docs/migration/RUNBOOK.md) is
complete. Firebase data is never modified by any of this.

## Running it

```bash
npm install
cp .env.example .env.local   # fill in your Supabase project
npm run dev                  # backend chosen by VITE_DATA_SOURCE
npm run dev:demo             # in-memory demo data, no backend at all
npm run build                # typecheck (app + scripts) + production build
```

| `VITE_DATA_SOURCE` | Backend |
| --- | --- |
| `supabase` | the new backend |
| `firebase` *(default when unset)* | legacy, kept as the rollback path. No new features. |
| `demo` | in-memory sample data (`?demo=loading\|empty\|error\|slow\|signedout`) |

## Product so far

- **Home**: Latest and Following feeds, likes, replies, share, live updates.
- **Composer** (inline on Home and the global Create sheet; one component):
  - text, and up to 4 photos per post, with a live preview;
  - reorder (buttons or drag) and remove photos;
  - client-side resize and metadata stripping;
  - optimistic publishing with Retry;
  - discard confirmation and local text drafts.

  See [docs/architecture/MEDIA.md](docs/architecture/MEDIA.md).
- **Post**: conversation view with replies.
- **Profiles** (`/u/:handle`):
  - a header with bio, join date and counts;
  - Posts, Replies and Media tabs;
  - follower and following lists;
  - edit profile: photo, name, username (with an availability check) and bio.

  Profiles are an optional `DataSource` capability (`profiles`). The Supabase and demo sources
  provide it. The legacy Firebase source doesn't, so the UI falls back to plain names and a
  Settings page.
- **Settings** (`/settings`): appearance and sign out.
- **Explore and Search** (`/explore`, `/explore?q=…&tab=top|people|posts|media`):
  - recent searches, stored in this browser only;
  - "Suggested for you", "Popular this week", recent photos and recent conversations;
  - searches people (username or name) and post text, with Top, People, Posts and Media tabs.

  Search is an optional `DataSource` capability (`discovery`). See
  [docs/architecture/SEARCH.md](docs/architecture/SEARCH.md).
- **Notifications** (`/notifications`): follows, likes, replies (to your post or your reply) and
  @mentions, with grouped likes/follows, read/unread state, "Mark all read" and a live unread
  badge in the sidebar (and on the Home bell on phones). Created only by the backend; optional
  `DataSource` capability (`notifications`). See
  [docs/architecture/NOTIFICATIONS.md](docs/architecture/NOTIFICATIONS.md).
- **Worlds** (`/worlds`, `/worlds/:slug`): admin-created live events — upcoming, live and
  finished, countdowns, join, posts inside the World, live chat, "Meet people here", and optional
  competition mode with entries, a computed leaderboard and a final winner. Prizes are display
  text only. Optional `DataSource` capability (`worlds`). See
  [docs/architecture/WORLDS.md](docs/architecture/WORLDS.md).
- **Support Hub** (`/support`): ask for genuine feedback on a song, video, app or project and help
  others in return — Support Credits (spendable) and Support Reputation (permanent), fair
  discovery without follower counts. **Admin** (`/admin`, admins only, enforced by the backend):
  moderation, reports, suspicious activity, credit adjustments, audit log, and admin-only
  **verification** badges (Admin → Users). See
  [docs/architecture/SUPPORT_HUB.md](docs/architecture/SUPPORT_HUB.md).
- **Messages** (`/messages`): one-to-one conversations with unread counts, receipts, typing,
  replies, photos, block and report. On Supabase they're **end-to-end encrypted** (Olm/Megolm via
  vodozemac), with device approval, emoji verification, Your devices, new-sign-in notices and
  encrypted key backup with a recovery key; admins review only what reporters submit. The demo
  keeps messages in the browser, says it isn't encrypted, and simulates the security screens. Optional
  `DataSource` capability (`messages`). See [docs/architecture/MESSAGES.md](docs/architecture/MESSAGES.md).
- **Demo data persists** in the browser (IndexedDB) across refreshes. Reset it in Settings → Reset
  demo data, or with `?demo=reset`.
- **Moments**: photo / text / text-over-photo posts that disappear after 24 hours — Home row,
  full-screen viewer (tap, hold, swipe), reactions, viewer list, replies through Messages,
  Everyone/Followers, delete, report, admin removal. See [docs/architecture/MOMENTS.md](docs/architecture/MOMENTS.md).

## Backend (Supabase)

| | |
| --- | --- |
| Schema, RLS, functions, Storage | [`supabase/migrations`](supabase/migrations) · design notes in [docs/architecture/DATABASE.md](docs/architecture/DATABASE.md) |
| Generated types | [`src/data/supabase/database.types.ts`](src/data/supabase/database.types.ts) (`npm run db:types`) |
| Data layer | [`src/data/supabase/queries.ts`](src/data/supabase/queries.ts) → [`src/data/supabaseSource.ts`](src/data/supabaseSource.ts). Screens only see the `DataSource` interface. |
| Edge Function | [`supabase/functions/legacy-sign-in`](supabase/functions/legacy-sign-in): keeps Firebase passwords working ([AUTH.md](docs/migration/AUTH.md)) |
| Tests | `npm run db:test`: 298 database/RLS checks, rolled back after running · `npm run test:api`: 147 checks through PostgREST · `npm run test:e2e`: 70 end-to-end encryption checks with real crypto devices · `npm run test:moments`: 18 Moments checks |

To run the tests without Docker or a Supabase project, use plain Postgres 15+ with
[`supabase/tests/local_supabase_shim.sql`](supabase/tests/local_supabase_shim.sql) applied
before the migrations (test-only stand-ins for `auth`/`storage`).

## Migration (Firebase → Supabase)

```bash
npm run migrate:extract     # read-only snapshot of Firebase → migration-data/ (git-ignored, contains emails)
npm run migrate:diff        # what changed since the previous snapshot (paths and field names only)
npm run migrate:audit       # field shapes and data quality, no personal data printed
npm run migrate:plan        # normalise every legacy format; list what would be skipped and why
npm run migrate:run         # load into Supabase over HTTPS (idempotent) + validation report
npm run migrate:validate    # re-check counts, counters, image checksums and a random sample
```

- [Firebase audit](docs/migration/AUDIT.md)
- [Auth migration](docs/migration/AUTH.md)
- [Cutover runbook](docs/migration/RUNBOOK.md)
- [Local dry-run report](docs/migration/dry-run-report-local.md)
- [Hardened Firestore rules](firebase/firestore.rules) (`npm run firebase:rules show|test|deploy|rollback`)

## Stack

- Vite + React 19 + TypeScript, React Router
- Supabase (`@supabase/supabase-js`). Firebase SDK only in the legacy source.
- Plain CSS with design tokens. No CSS framework.
- Self-hosted variable fonts: Geist (UI text), Bricolage Grotesque (display)
- Icons: lucide-react

## Structure

```
src/
  data/          backend boundary — screens never touch Firestore directly
    types.ts         normalized models + DataSource interface
    supabase/        client, generated types, queries
    supabaseSource.ts
    firebaseSource.ts + legacy.ts   legacy backend (rollback path)
    demoSource.ts    used only when VITE_DATA_SOURCE=demo
  state/         session, theme, toasts, composer
  ui/            primitives: Button, Avatar, Sheet, Skeleton, StateMessage, Brand
  features/      posts (card, media, viewer), composer, feed
  shell/         AppShell (sidebar / bottom nav / rail), ScreenHeader
  screens/       Home, Post, Profile, Auth, placeholders
  styles/        tokens.css, base.css
legacy/          the prototype's index.html, kept for reference (not built)
supabase/        config, migrations, Edge Functions, database tests
scripts/         migration (extract/audit/migrate) and API tests
docs/            architecture and migration docs
```

## Design system

- **Accent:** Amigo Coral `#FF5A3C`, with dark ink `#1D0A05` on top of it. It is the
  only brand colour. Use it for primary actions, active likes and the focus ring.
- **Neutrals:** warm off-white (`#F8F7F4`) in light mode, near-black (`#0C0C0E`) in
  dark mode. Follows the OS setting, with a manual override in Profile.
- **Type:** Geist at 15px for UI and body text. Bricolage Grotesque for the wordmark,
  screen titles, empty states and "statement" posts (short text-only posts set large).
- **Shape:** rounded rectangles (12–16px). Pills only for transient floating chips.
- **Layout:** under 768px, a single full-width column with a bottom tab bar. From
  768px, a compact icon sidebar. From 1200px, a labelled sidebar, a 620px column
  and a suggestions rail.
- **Rules:** no decorative emoji, glows, gradients or floating ornaments in the UI
  chrome. Content carries the colour.

## Legacy Firestore model

See [docs/migration/AUDIT.md](docs/migration/AUDIT.md) for every collection and
historical document shape, and how each maps to the new schema.
