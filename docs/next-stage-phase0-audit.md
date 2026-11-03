# Amigo World — next stage: Phase 0 audit and plan

Date: 2 Nov 2026 · Branch `claude/amigo-world-restart-7mrbrf` · Builds on `docs/amigo-2.0-assessment.md` (Business, AI, Marketplace).

## Facts that change the brief

1. **The Marketplace is not uncommitted work.** It is commit `d718521` (pushed). It has been live on amigoworld.com.ng since 2 Nov, with its database migration on Production and the `marketplace` switch **off** (only admins can see it). The working tree is clean, apart from the local banner commit `c73180d`.
2. **Public registration is open today.** The live site has a "Create account" tab with no invitation or waitlist gate. Username reservation only protects names if registration is closed or gated. Otherwise anyone can register the name directly. Closing it is a Production change and needs your decision (see D2).
3. **"Support" already exists, and it means something different.** The Support Hub (`20261006170000_support_hub.sql`, `/support`) lets people post requests ("listen to / watch / try / visit / read my thing"), and others help out. Helping earns points from `support_ledger`, an append-only ledger whose balances are sums of rows. There's no money involved. The brief describes Support as financial appreciation that earns Credits worth Naira. The two systems can't share the name "Support" and the same ledger without confusing people (see D1).
4. **A Creator Programme already exists** (`20261021090000_creator_programme.sql`, `/settings/monetization`). It covers applications, admin review, revocation, a dashboard of likes and replies (no views) and private feedback. It is explicitly non-financial and closed until an admin opens it.
5. **Views are not tracked anywhere.** The creator dashboard notes this ("No impressions, reach or views").
6. **No birthday is stored.** The Terms draft says the minimum age is "13 (drafted)".

## 1. What already exists (working)

| Area | What's there |
|---|---|
| Shell | `AppShell` + `nav.ts`. Desktop sidebar: Home, Explore, Worlds, Support Hub, Notifications, Messages, Profile, and a Post button. Phone bottom bar: Home, Explore, ＋, Worlds (or Messages), Profile. Notifications, Messages and Support Hub sit in the Home header. |
| Posts | Posts, replies, reposts, likes, bookmarks, media (4 per post, variants and previews), moderation, reports, idempotent posting |
| Profile `/u/:handle` | Avatar, name, handle, bio, follower and following counts, Support Hub line, Posts / Replies / Media tabs, edit sheet with live username availability |
| Auth | Sign in, sign up (name, email, password, legal consent), Google, password reset by link or code, email verification (as an onboarding step) |
| Onboarding | Verify email → interests → profile (photo and bio) → welcome. Every step except verify can be skipped and survives a refresh. |
| Settings `/settings` | One long page with Account, Privacy, Security, Notifications, Appearance and About sections, and sub-pages for interests, notifications, blocked accounts, devices, backup, business and monetization |
| Messages | End-to-end encrypted direct messages: devices, backup, reactions, edits, unsending |
| Worlds | Scheduled rooms with admin tools |
| Business `/b/:handle` | Profile, follows, business posts, admin suspension; manage page at `/settings/business` with Menu, hours and area |
| Marketplace | `/market`, `/market/saved`, `/market/sell`, `/l/:id`, `/l/:id/edit`. Listings, 21 categories, search, filters, saved listings, sharing a listing in a post, reports, admin removal. Behind the `app_features.marketplace` switch. |
| Admin | Accounts, moderation, businesses, marketplace, creators, insights, platform, support |
| Usernames | `profiles.username`: lowercase, `^[a-z0-9_]{3,24}$`, unique index. New accounts get one generated from the display name (never from the email). Users change it from the edit sheet, which writes directly to the profile row. Business handles are a **separate** namespace with a small reserved list (`business_reserved_handle`). |

## 2. Partially implemented

- **Settings:** the groups exist but are uneven. Privacy is mostly information rows with no controls. There are no muted words, private account, message-request controls or sessions page (devices only cover message keys). Business and monetization links sit under Account.
- **Profile:** no cover image, location or website. The Support line shows Support Hub points, which isn't creator support in the brief's sense.
- **Business storefront:** `/b/:handle` already has Menu and listing tabs. There's no `/shop/:handle`, no listing variants (sizes and colours), and no Open Graph preview for sharing on WhatsApp, Instagram or X (the app is a client-rendered single-page app).
- **Creator Studio:** the Creator Programme screen is about half of an Overview tab. It has no views, eligibility progress or Support earnings.
- **Sign-up:** no username or birthday fields. Verification happens after the account is created, not as part of creating it.

## 3. What needs to be built

- Navigation redesign (Phase 1).
- Settings restructure with new controls: muted words, message permissions, private account, sessions (Phase 1, with backend for the new controls).
- Profile cover, location and website (Phase 1).
- Username reservation: a public page, email verification, admin tools, claim flow and registration gating (Phase 2).
- Sign-up with username, birthday and age gate (Phase 3).
- `/shop/:handle` storefront, listing variants and share previews (Phase 4).
- Per-post views and a creator analytics backend (Phase 6).
- A Credits ledger kept separate from Support Hub points, plus Creator Studio (Phase 7).
- Eligibility calculation and progress display (Phase 8). No payouts.

## 4. Likely database changes (all additive, tested locally and on verify-1029 first)

| Phase | Change |
|---|---|
| 1 | `profiles`: `cover_url`, `location`, `website_url` (public, with checks). New `user_settings` table (private: `is_private`, `dm_permission`, notification preferences). New `muted_words` table. Private accounts touch `can_view_post` and follow logic, so they need their own sub-phase and a full re-run of the blocking and privacy tests. |
| 2 | `username_reservations` (username citext/lowercase, email hash plus encrypted email, status pending/verified/claimed/expired/revoked, expiry, verification token hash). `protected_usernames` (system and brand names, admin-managed). **One shared check, `username_claimable(name, for_user)`**, used by registration, rename, `generate_username` and reservation. Triggers on `profiles` insert and update of `username` enforce it, so nothing can bypass it. Claiming is a single transaction: lock the reservation row, insert or update the profile, mark it claimed. Plus `registration_settings` (open / closed / claim-only). |
| 3 | `profile_private` (birth date; only the owner and server functions can read it). An age check inside `handle_new_user` / the signup function. |
| 4 | `listing_options` (sizes and colours) or a `jsonb` column on `listings`, plus a `business_storefront` view. No new listing records. |
| 6 | `post_view_marks (post_id, viewer_id, day)` with a primary key that removes duplicates. A batched `record_post_views(uuid[])` function, rate-limited and excluding the author's own views, suspended accounts and anyone else's views beyond a set number per post per day. A `posts.view_count` counter updated in batches, so reading a post never runs an aggregate query. A daily `post_view_daily` rollup for analytics. Signed-out views aren't counted (no anonymous pages exist yet). |
| 7 | `credit_ledger` (append-only: recipient, amount, type, reference unique per type, status, reversal_of, created_at). Balances come from a view or a summing function. No client grants on the table; unique references prevent double-crediting. **Separate from `support_ledger`.** |
| 8 | `creator_eligibility(user_id)`: a server function computing the 90-day figures from the rollups. Thresholds stored in `monetization_settings`, not hard-coded. |

## 5. Existing features that could be affected

- **Feed and profile post queries** (views and private accounts change `POST_SELECT` and `can_view_post`). Every migration needs the **Neon Data API schema refresh** before code that uses it is deployed: on 2 Nov the feed broke for this exact reason.
- **Username changes and `generate_username`** (reservation must hook in without blocking existing accounts).
- **Sign-up, Google sign-in and `handle_new_user`** (birthday, age gate, reservation claim).
- **Support Hub screens, profile Support line and admin Support** (renaming if D1 goes that way).
- **Navigation:** moving Worlds and the Support Hub changes where existing users find them.
- **Encrypted messages:** must not be touched. Message-request controls must work from metadata only (who may start a conversation), never from message content.

## 6. Preserving the Marketplace work

- It is committed (`d718521`) and live behind a switch, so nothing can overwrite it silently. All new work builds on it: `/shop/:handle` reads the same `listings` rows through `search_listings` / `business_by_handle`, with no copies.
- Its tests run as a gate on every phase: `supabase/tests/database.test.sql` (618 checks), `scripts/test/marketplace.test.mjs` (35), and the verify-1029 integration run.
- The navigation redesign gives `/market` a permanent slot, but it stays behind `feature_enabled('marketplace')`. Users only see it once you turn the switch on.

## 7. Recommended order

The brief's order, with three adjustments:

1. **Phase 1a, navigation and design patterns.** Front-end only, no database changes.
2. **Phase 2, username reservation, before the rest of Phase 1.** People are asking now, and it only protects names once registration is gated (D2). It's mostly new and isolated, so the risk is low.
3. **Phase 1b, Settings and profile.** Includes the new private settings tables. Private accounts come last, as their own step.
4. Phase 3 auth and onboarding. Builds the claim flow on top of Phase 2.
5. Phase 4 storefront → Phase 5 Marketplace refinements.
6. **Phase 6 views must come before 7 and 8**, since eligibility depends on genuine views.
7. Phase 7 Credits ledger and Creator Studio → Phase 8 eligibility. No withdrawals until D5 is settled.

## Phase 1a proposal: navigation

**Phone bottom bar (5 slots):** Home · Explore · **＋ Create** · Market · Messages.
**Phone top bar:** notifications bell + your avatar (opens profile, with Settings one tap away).
**Worlds** becomes a tab inside Explore (Explore: For you · People · Worlds · Businesses).
**Business discovery:** a "Businesses" row in Explore, and storefront links on Market.
**Support Hub** moves into Creator Studio / profile once D1 is decided. Until then it stays in the sidebar.
**Desktop sidebar:** Home, Explore, Market, Messages, Notifications, Profile, then a quiet "More" (Worlds, Bookmarks, Business, Creator Studio, Settings, Admin), with the Post button below. Seven primary items, down from eight, without anything getting lost.
While the Marketplace switch is off for a viewer, the Market slot shows Worlds instead, so the bar never has a dead tab.

## Decisions needed

- **D1, Support naming.** Recommended: rename the existing points system to **"Boosts"** (or keep "Support Hub" for requests only). Reserve **"Support"** for financial creator support, which earns Credits in its own ledger.
- **D2, registration.** Recommended: switch Production to **claim-only** (existing users sign in normally; new sign-ups only through a verified reservation or an invite). It's a one-row setting you can reverse. Alternative: keep sign-up open and accept that reservations only cover names nobody has taken yet.
- **D3, reservation hosting.** Recommended: `reserve.amigoworld.com.ng` on the **same Vercel project**, served based on the host name. It gets its own tiny page that loads none of the app's code, plus three serverless endpoints (`/api/reserve/check`, `/api/reserve/start`, `/api/reserve/verify`) using a database role that can only run the reservation functions. It shares the database, so uniqueness is enforced in one place. Needs a DNS record (you add it) and bot protection: Cloudflare Turnstile (free, one script) or rate limits plus email verification only.
- **D4, minimum age.** 13 as currently drafted, or 18? Nigeria's Data Protection Act treats under-18s as children and requires parental consent, so a lawyer should confirm. Birthday stays private either way.
- **D5, Credits money.** The proposed rate (100 Credits = ₦5,000, so ₦50 per Credit) needs a funding source: supporters paying in (via a payment provider: Paystack or Flutterwave, with KYC requirements) or a platform budget. Until that's decided I'll build the ledger and display only: **no top-up, no conversion, no withdrawal**.

## Testing per phase

Typecheck, build, unit tests and browser checks of the changed screens on phone and desktop widths. Database: full local suite plus new checks, then verify-1029 (rolled back), then an integration run. Every migration rollout follows the memory rule: restore branch → migration → **Data API schema refresh** → deploy.
