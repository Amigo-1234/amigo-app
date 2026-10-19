# Launch readiness — Amigo World on Neon

_Re-assessed 2026-10-19. Production: `efa7658` (`dpl_9W3zzhEK2AmdvTS5jeisyM1MfNE9`). Release candidate on Preview:
`97fd955`. Legacy rollback `dpl_BLQeNsTyyeeSUgpZSyvnAR62AuaS` untouched. Nothing merged into `main`._

## Release candidate 97fd955 (Preview only — production needs the owner's approval)

| Change | Verified |
| --- | --- |
| Moment reactions show instantly; repeated taps send only the last choice; failed saves roll back | **Live, Preview vs production** (`live-moment-react.test.mjs`, run 39290011371): tap → selected, WebKit **1195–1720 ms → 1–2 ms**; Chromium 4G-like (150 ms, CPU ×4) **1001 ms → 3–4 ms**; 5 quick taps **5 requests → 1**, saved result correct, author sees the reaction |
| Admin control centre: metrics (accounts, new today/7 d, DAU/WAU/MAU with definition, content, Worlds, Support Hub, reports, admin actions), 14-day charts with table view, newest accounts | functions checked on a local copy (non-admin refused, internal counter not callable); applied to Neon with the right grants; live test written (`live-admin.test.mjs`) — **pending** |
| Admin → Users → Accounts: search, detail (activity counts, standing, reports, warnings), suspend / restore / warn with confirmation, notes and history | **Local UI run** (app against a local copy of the schema, local-only admin): suspend → database refuses the account's post (400) → restore → posts again (200); note and history shown; no page errors. Live: non-admin, signed-out and anon calls refused (42501). Not run live on Preview: needs a temporary admin grant (owner approval) |
| Update notice (`/version.json`, checked on return to foreground, ≤ every 10 min, never auto-reloads) | build emits the file; served `no-cache` |
| "Created by AMIGODEV" (Settings → About, sign-in screen, desktop rail) → https://amigo-dev.vercel.app | text only: the portfolio couldn't be reached from the build environment to obtain the logo |

Migration `20261020090000_admin_insights.sql` (live): adds six admin-only functions, no tables or data changed.
Undo is in the file header.

## Owner decisions needed before a public launch

1. **Legal text (blocker).** Nothing is invented; these are the facts needed from the owner (and a lawyer
   where marked) to replace the 25 placeholders in `src/legal/docs/*-0.1.md`:
   - **Operator:** legal name of the person or company running Amigo World; postal address if your jurisdiction
     requires one (terms §1 and contact, privacy §1).
   - **Contact emails:** one support address and one privacy/legal address (or confirm one address for both).
     Used in terms, privacy, guidelines, deletion, copyright, monetization.
   - **Minimum age:** confirm 13 or give another age (terms, privacy).
   - **Governing law and disputes:** which country's law, which courts, any dispute process (terms). *Lawyer.*
   - **Retention:** how long backups and deleted-account remnants are kept; confirm deletion windows
     (deletion policy). *Lawyer for legal-hold rules.*
   - **Service providers to list:** confirm Neon (database, auth), Vercel (hosting), Cloudflare R2 (photos —
     already live, so the privacy policy must name it) and the email-code sender; whether data-processing
     agreements are in place (privacy).
   - *Lawyer:* legal bases for processing, international transfer mechanism, limitation-of-liability wording,
     copyright counter-notice / DMCA agent.
   - Monetization terms stay unpublished while the programme is closed.
2. **Admin account — resolved, nothing to grant.** The owner account @amigoisaboy has been admin since
   2026-10-12 (email verified; audit log shows its World admin actions on 2026-10-18). The earlier "no admin"
   line was stale text from before the grant. No other admin exists; there is deliberately no admin sign-up.
3. **Logo.** Provide the AMIGODEV logo file if it should appear beside the credit.
4. **Creator monetization:** Settings entry hidden (owner's decision, 2026-10-19); screen, data layer and admin
   tools kept for later (`SHOW_MONETIZATION` in `SettingsScreen.tsx`). Nothing financial is enabled.
5. **App stores:** not listed and nothing submitted. A store release needs a developer account (paid), native
   wrapper, privacy labels and the legal text above — postpone until after the web beta.

## Earlier assessment (2026-10-17)

### Blockers then

1. **Legal text.** All seven documents are drafts (v0.1) with `[OWNER]` / `[LEGAL REVIEW]`
   placeholders: legal entity, address, contact, governing law, minimum age. They need the owner's
   details and a lawyer's review, then publishing as v1.0 from Admin → Legal.
2. **Deployment visibility.** The Vercel connection lost access to the team scope (403). The
   preview is behind Vercel Authentication, so deployments can't be verified from here, and a
   public launch needs the protection setting and the domain changed by the owner.
3. **Admin account.** No admin exists on Neon yet. The owner's account must be confirmed and
   granted admin; otherwise reports and suspensions can't be handled.
4. **Photos and media.** Live on the preview with a private Cloudflare R2 bucket (2026-10-17):
   photo posts, avatars, photo Moments and encrypted message photos pass live tests (31 API checks
   against real R2 + Neon, and an iPhone-profile browser run). Video posts and voice notes have no UI
   yet. Production needs its own domain added to the bucket's CORS rule.

### Status by area

| Area | Status | Notes |
| --- | --- | --- |
| Sign up / sign in / reset | READY | Neon Auth through a same-origin proxy; codes by email; session sync fixed |
| Email verification | READY | By code from Settings |
| Account deletion | READY | Password re-check + typed DELETE; full cascade (tested locally) |
| Legal pages + acceptance | NEEDS ATTENTION | Machinery ready; the text itself is a draft (blocker 1) |
| Encrypted 1:1 messages | READY | Live-tested on Neon (20/20), 70 local E2E checks |
| Reactions, edit, unsend, search, older history | READY (local) | 25 local checks; **not yet live-tested on Neon** |
| Delivered receipts | READY (local) | Were never sent before (lazy query builder bug); fixed and tested |
| Message photos | READY (live API) | Encrypted on the device; live test: recipient decrypts, bucket holds ciphertext only, outsiders refused. Not yet driven through the browser UI |
| Voice notes, video | DEFERRED | Storage ready (video limits in place); no UI yet |
| GIFs | BLOCKED | Tenor API shut down (2026-06-30); GIPHY production access reportedly needs an application/payment — owner decision |
| Typing indicator | READY (local) | No Realtime needed: short-lived unlogged rows, 3 s heartbeat, read via the existing pulse; hidden across blocks |
| Feed, posts, replies, likes | READY | Text posts on Neon |
| Bookmarks, edit/delete post, copy link | READY (local) | Not yet exercised live |
| Profiles, follow, discovery | READY | Avatars live-tested on a phone browser (R2) |
| Moments | READY | Photo Moments live-tested (create, view, delete removes the file from R2); expiry enforced by the database |
| Worlds, Support Hub | READY | Server-authoritative (existing migrations) |
| Notifications (in-app) | READY | Polling on Neon (30 s), paused when the tab is hidden |
| Reporting (messages, Moments, posts, replies, profiles, Worlds, Support) | READY | Admin queues for each |
| Suspension | READY (local) | Enforced by database triggers on 11 tables |
| Warnings, rate limits, block side-effects | READY (local) | Limits: posts 30/10 min and 300/day, likes 300/h, follows 100/h, messages 60/min |
| Admin platform stats | READY (local) | Aggregate counts only |
| Blocked accounts list | READY (local) | Settings → Privacy |
| Admin access to messages | READY (by design) | No backdoor: admins see only what reporters choose to share |
| Creator monetization | DEFERRED | Architecture only; programme closed |
| PWA (install, offline page) | READY (local browser test) | Nothing sensitive cached; per-page OG previews need a server and are deferred |
| Onboarding | READY | Welcome card; avatar step waits for media storage |
| Analytics & errors | READY (local) | Admin aggregate stats; redacted app-error reports not linked to accounts; no third-party tracker |
| Crash handling | READY | Error boundary + router error screens; stale-deployment reload prompt |
| Test-account cleanup | BLOCKED (awaiting confirmation) | Script prepared, guarded, not run |

### Security checks (live Neon, after every migration today)

- No function in `public` is executable by `PUBLIC`.
- Every table in `public` has row-level security on.
- The Data API refuses all requests without a sign-in token (checked 2026-10-17 from GitHub
  Actions): signed-out visitors can't read anything, even public posts.
- New write paths (`dm_send_v3`, `dm_unsend`, moderation, post tools) are granted to signed-in
  users only, and each checks the caller in the database.
- Messages: the server sees that a reaction or edit relates to a message, but never its content
  (documented in `docs/architecture/MESSAGES.md`).

### Costs (Free plans only, nothing paid introduced)

- **Neon Free**: compute auto-suspends when idle. Polling is the main cost driver: messages pulse
  every 1 s only while a conversation is open, the inbox every 3 s, the badge every 15 s, other
  lists every 30 s, all paused in hidden tabs. Watch compute hours in a beta.
- **Vercel Hobby**: the auth proxy is an Edge function, and Data API calls go direct to Neon
  (no function invocation). Each media upload and each image view is one Edge invocation (the
  view redirects to R2, so bytes don't pass through Vercel); R2 egress is free.

### Untested or only tested locally

- Reactions, edits, unsend and history paging against live Neon (local PostgREST only).
- Bookmarks, post edit/delete, reports and suspension against live Neon.
- Text Moments against live Neon (photo Moments are live-tested).
- Encrypted message photos through the browser UI (live-tested through the app's messaging module, not the screen).
- Real devices: iOS Safari long-press and swipe-to-reply gestures were not tried on hardware.
- Load: 10/25/50/100 simulated users against the live Data API (2026-10-18): p95 ≤ 87 ms, 0 errors
  at every level ([PERFORMANCE.md](PERFORMANCE.md)). Not load-tested: sign-in bursts, media
  functions, R2 at scale, many concurrent encrypted conversations.

### Recommended beta limits

- Invite-only, **≤ 50 people**, while compute hours and R2 usage are watched daily. Upload limits stay on: 60 uploads/hour and 1 GB/day per person; images 10 MB (avatars 5 MB).
- One admin (the owner) on duty for reports; suspensions as needed.
- Existing server limits stay on: 30 Moments a day, 20 reports an hour per person, message size
  64 KB of ciphertext.
- Re-run the live Neon messaging test with two dedicated accounts before inviting people, then
  remove those accounts with the guarded cleanup script.
