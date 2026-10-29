# Launch readiness — Amigo World

_Updated 2026-10-19 (Phase 2). Development: `claude/amigo-world-restart-7mrbrf`, Preview
https://amigo-app-git-claude-amigo-worl-d67e9b-amigos-projects-73fa05d5.vercel.app. Production:
https://amigo-app-one.vercel.app = `dpl_FbiTotxmWnmRP1hhXN6mDkfGdZCo` (commit `2ee1b02`: `efa7658` + Follow Back fix).
Rollbacks kept: `dpl_9W3zzhEK2AmdvTS5jeisyM1MfNE9` (efa7658), legacy `dpl_BLQeNsTyyeeSUgpZSyvnAR62AuaS` (main).
Nothing merged into `main`. **Production deployment of the work below is not done and needs the owner's approval.**_

**Recommendation:** ready for a **small, invited beta (≤ 50 people)** once the legal placeholders are filled and the
release below is promoted; **not ready for an open public launch** (legal text, single admin, free-tier limits).

## A. Completed on Preview (not yet on production)

| Feature | How it was verified |
| --- | --- |
| Creator Programme: Settings → Creator Monetization; apply (category, description, reason, links, notes), statuses Not applied / Pending / More information requested / Approved / Rejected / Suspended / Revoked; withdraw; resubmit | Local DB, 50 checks (`npm run test:creator-programme`); local browser run of the whole flow (apply → info requested → resubmit → approve → dashboard → feedback → admin reply, no overflow, light/dark); live on Preview while applications are closed (`live-creator.test.mjs`, Chromium + WebKit) |
| Creator dashboard (approved only): posts, likes and replies received, followers, verified followers, 8-week trend, recent posts — real counts only, no views/reach/earnings | Local DB checks against known activity; screenshots |
| Creator feedback (private, optional rating, category, admin responses) + admin Creator Feedback inbox | Local DB: non-members refused, other members see nothing, no table access; local browser run |
| Admin: Creator Programme queue (filter, search, details, profile link, approve / request info / reject with note, suspend / revoke / restore, previous decisions), Creator Feedback, Audit log section | Local browser run; every action refused to members on the live DB (42501) |
| In-app notification banners (likes, replies, mentions, follows, Support Hub, messages) + per-device Banners / Sounds settings; original synthesised sounds | Local browser run: banner 28 s after a like (existing 30 s refresh), right text, tap opens the post, no repeat, no overflow. **Message banners not exercised end-to-end** (encrypted DMs need two devices) |
| Save photo from the full-screen viewer (original quality via permission-checked link; decrypted copy for message photos; share sheet on phones) | Demo-mode browser run on desktop Chromium (download, correct format/name). **Not run on iPhone** |
| Profile: "Follows you", "Add a bio", bio typography, counter; captions: safer shortening (no broken emoji/links, ≤ 6 lines), Show less | Unit check of shortening; screenshots |
| Messages: "Break the ice" suggestions in an empty conversation (inserted for editing, never sent) | Demo-mode browser run |
| Moments reactions instant (from the earlier release candidate) | Live: production WebKit 1195–1720 ms → Preview 1–2 ms per tap; 5 quick taps 5 → 1 request; passed again in the 272d2dc run |
| Mobile: no horizontal overflow on 15 screens at 320 and 390 px; no double-tap zoom on controls (pinch-zoom kept); deep links keep their URL through sign-in | Browser checks |
| Earlier on Preview: admin metrics/accounts/notes, update notice, AMIGODEV credit with the original mark, hidden-then-restored monetization entry | Earlier reports |

**Live test run on Preview `272d2dc` (run 39331672386):** fresh-token probe, likes & replies, Moment reactions,
Follow/Follow Back, Creator Programme — all passed in Chromium and WebKit, except one WebKit console message from a
cancelled background request (browser behaviour, not app code; the test now ignores that message, `ed0e72f`).

## B. Outstanding issues

**P0 — launch blockers**
- **Legal text**: 25 placeholders, privacy policy doesn't name Cloudflare R2 (live). Needs owner facts (section E) and
  legal review. Publishing incomplete policies as final is not done.
- **Production release**: everything in A is on Preview only; production lacks it (including the Moments fix the
  owner noticed is missing there).

**P1 — before wider release**
- One admin (@amigoisaboy). Reports and creator reviews depend on one person.
- Message banners and push for message volume: banner shows when a conversation *becomes* unread; a second message in
  an already-unread conversation doesn't trigger another (no extra polling added).
- Notification banners arrive with the 30 s refresh, not instantly (no Realtime on Neon; documented, not faked).
- Free-tier capacity (section H). Watch compute and storage weekly.
- Physical iPhone checks (section G) — automated WebKit is not a device test.
- World chat messages can't be reported yet; no email-verification nudge outside Settings (from the earlier audit).

**P2 — after beta**
- Creator Programme: notifications to applicants on decisions (status is visible in the app); follower trend chart.
- GIFs, voice notes, video posts; per-page share previews.
- Native app store packaging (not started, by decision).

## C. Performance (measured)

- Moment reaction feedback: WebKit 1195–1720 ms → 1–2 ms; Chromium (4G-like) 1001 ms → 3–4 ms.
- Follow Back tap → "Following": 30–48 ms (production and Preview).
- Earlier measurements (PERFORMANCE.md): first paint on 3G 9.5 → 4.0 s, warm feed on 4G 3.0 → 1.3 s, message delivery
  p50 ~0.85 s; load test 100 simulated users p95 85 ms.
- New code adds no polling; the Creator dashboard queries are bounded (own posts; 8 weeks); bundle +~1 KB gzip on the
  entry chunk (new screens load on demand).

## D. Security

Tested: every new admin function refuses members, signed-out callers and `anon` (live DB); helper functions not
callable; no direct reads/writes of creator tables; members can't self-approve; feedback private to author + admins
(local DB and live refusals); all functions `security definer` with empty `search_path`, no dynamic SQL; decisions
audit-logged without feedback text; creator links https-only, rendered `noopener noreferrer nofollow`; downloads use
the existing permission-checked media path and never upload or log decrypted content.
Not re-tested in this phase: file upload validation, signed-URL expiry, rate limits, blocking and suspension beyond
the earlier suites (which passed locally again today: blocking, Moments).

## E. Legal — information needed from the owner

Nothing is invented; these are the facts needed from the owner (and a lawyer
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

## F. Deployment readiness (what promotion needs)

1. Owner approval to promote the dev branch (it contains the Follow Back fix as `3feab45`, so production's hotfix is
   not lost). Deploy from git with the production target (same method as the current production), then run the live
   suites on production, keeping `dpl_FbiTotxmWnmRP1hhXN6mDkfGdZCo` as the rollback.
2. Database: migrations `20261020090000` and `20261021090000` are already applied to the shared database (additive;
   the current production app doesn't use them). Nothing else to run.
3. After promotion, the owner opens creator applications in Admin → Creator Programme ("Accept applications").
   Keep them closed until then: the current production screen would show its old Apply button.

## G. Manual iPhone checklist (installed Home Screen app, after promotion)

1. Settings → About shows "Built by Idris · AMIGODEV" with the logo; the link opens the portfolio.
2. Settings → Creator Monetization opens; status and early-access notice read correctly.
3. Have a friend like your post while the app is open: a banner appears within ~30 s; tapping opens the post.
   Turn Sounds on, tap anywhere once, and check the next banner plays a short sound (and that Silent mode mutes it).
4. Open a photo, tap the download icon: the share sheet appears; "Save Image" puts it in Photos.
5. Open a Moment from someone else and tap reactions quickly: the highlight follows each tap instantly.
6. Visit the profile of someone who follows you: "Follows you" and "Follow Back".
7. Start a new conversation: "Break the ice" chips; tapping one fills the box without sending.
8. Double-tap a button quickly: the page doesn't zoom; pinch still zooms.

## H. Infrastructure (Neon Free, Vercel Hobby, Cloudflare R2)

- Neon: 0.25 CU fixed compute, 1 GB per-branch storage limit (database is 14 MB today), 6-hour point-in-time restore
  window (the only backup), 112 connections (10 in use). Data API polling is the main compute cost; watch compute
  hours monthly. A longer restore window or larger compute needs a paid plan (owner decision).
- Vercel Hobby: edge functions for auth proxy and media; no other server cost added.
- R2: photo storage and egress (egress free); watch storage.
- No capacity guarantee is claimed; the 100-user load test was a short synthetic run.

## Earlier assessments

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
