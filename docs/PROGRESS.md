# Amigo World — progress

Branch `claude/amigo-world-restart-7mrbrf` · Neon project `amigo-world` (Free) · Vercel preview only. `main` and Firebase production untouched.
Launch status: see [LAUNCH_READINESS.md](LAUNCH_READINESS.md).

## Done
- **Neon foundation**: schema built from the Supabase migrations (`scripts/neon/build-schema.mjs`), Neon Auth through a same-origin Edge proxy (`api/neon.ts`), Data API called directly from the preview origin. The Data API refuses every request without a sign-in token.
- **Auth & Settings**: instant session sync, branded loader, email verification and password reset by code, no fake controls.
- **Encrypted messages**: Matrix crypto (vodozemac via matrix-sdk-crypto-wasm); the server holds ciphertext only. Pulse-driven updates and idempotent send. Live latency: send p50 175 ms, delivery p50 623 ms.
- **Messages, round 2**: encrypted reactions (quick + emoji picker, double-tap ❤️), edit within 15 minutes, unsend for everyone (server deletes the ciphertext), swipe to reply, long-press menu, copy, report one message, on-device search, load earlier messages.
- **Moments on Neon**: text-on-background only; expiry enforced by the database, with an expired-row sweep on each new post.
- **Moderation**: account suspension enforced by the database; reports for posts, replies, profiles and Worlds; admin queue with takedown, suspend and restore; audit log.
- **Post tools**: bookmarks (private), edit (marked edited), delete, copy link, report; Bookmarks screen.
- **Safety**: database rate limits that only stop floods (RL001). Blocking removes follows both ways and prevents re-following; you can block from posts and profiles, and see blocked accounts in Settings. Admins can warn people (shown until acknowledged) and see aggregate platform stats. Worlds can be reported.
- **PWA / sharing**: a minimal service worker (offline page only; no data, messages or keys cached), install prompt or iPhone steps in Settings, generic OG tags, robots.txt, security headers.
- **Messages, round 3**: typing indicators on Neon without Realtime, and delivered receipts fixed (they were never sent).
- **Reliability**: crash screens instead of blank pages; privacy-safe error reports (redacted, unlinked) with an admin summary.
- **Messages on mobile**: long-press menu fixed (it closed on finger lift), reply cleared when its message is unsent; iPhone-profile touch test 12/12.
- **Media service (R2)**: Postgres decides every upload and read; signed links (10 min upload for exact type/size, 1 h read); encrypted DM photos stored as ciphertext; client wired for posts, avatars, photo Moments and DM photos behind `VITE_MEDIA_STORAGE=r2`.
- **Media live-verified (2026-10-17, preview `a0a0a52`)** via `.github/workflows/live-media.yml` (runs when `.github/live-media.run` changes; uses the `VERCEL_AUTOMATION_BYPASS_SECRET` repo secret):
  - API, real R2 + Neon (31 checks): signature enforces exact type and size, private bucket, CORS allows only the app, followers-only and Moment visibility, no reuse of others' uploads, avatar, Moment deletion removes the file, encrypted DM photo round trip (ciphertext only), outsiders refused, cleanup verified.
  - iPhone 13 browser (Chromium): legal gate, photo post with "Posting…" on a slow network, offline failure → saved with Retry → posts when back online, profile picture after reload, photo Moment, no horizontal scroll, no page errors, cleanup verified.
  - Fixed on the way: upload links could be refused right after sign-up (retry once in `api/media-upload`); uploads now time out after 3 minutes instead of spinning forever.
  - Test accounts are deleted even when tests fail (re-sign-in before deletion; an 8-minute deadline). Two accounts left by one interrupted run were removed by exact id.
- **Onboarding**: a skippable welcome card on Home with people to follow, first post, profile setup, and links to Worlds and Support Hub.
- **Legal (drafts v0.1)**: 7 documents at `/legal`, versioned; acceptance recorded at registration; re-acceptance gate.
- **Creator monetization**: architecture only, programme closed; users see "Creator monetization is coming soon."
- **Account deletion**: password re-check plus typed confirmation; cascades through all owned data.
- **Quality phase (2026-10-18/19; on production as `dpl_6apEagqiaQVaSALbmubj4crsMCS4`, commit `e629bb6`)** — see [QUALITY.md](QUALITY.md) once written:
  - **Images**: one signing call per screen (`/api/media-sign`, `media_sign_set`), ~1080 px copies for feeds/grids
    (`media_begin_variant`, readable exactly when the original is), ~24 px blurred previews stored with each post,
    links identical within their 30-min window (browser cache hits), R2 host preconnected. Measured on Preview (Pixel 5):
    4G first feed photo 6.0 → 4.0 s, all visible 7.3 → 4.0 s, image bytes −70 %, 3G first photo 36.6 → 22.7 s.
    Migrations 20261019090000, 20261019091000 (live).
  - **Moments**: framing (fill / whole photo over blurred copy, zoom 1–4, focus point) and caption position chosen
    in the composer, stored per Moment and applied on every screen size; viewer waits for the photo, shows
    loading/Retry, preloads the next Moment. Migration 20261019100000 (live).
  - **Web Push**: standard Web Push, encrypted to the device, VAPID-signed, no paid provider. Pushes say only "new
    message" + conversation; notification text is generic. Server-checked targets (secret hash in `push_server`),
    blocking/prefs/rate limit respected, expired devices removed. Settings: enable per device (iPhone needs Home
    Screen), test notification, device list. Vercel env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT,
    PUSH_SERVER_SECRET (sensitive). Migration 20261019110000 (live). Locked-screen delivery on a real phone: **not yet
    verified on a device** (automated: local crypto + delivery tests; live test in Google Chrome via Google's push
    service passed 2026-10-18: registration, test notification, generic message notification while closed, tap opens the conversation).
  - **Worlds**: admins create, edit and cancel Worlds in the app (fairness locks once started: start time, link
    and scoring fixed); state from the server clock (countdowns corrected by `server_now`); members get a "live"
    notice and push when it opens, via `worlds_tick`, which any signed-in app calls every 5 min (no admin tab
    needed); cancelled Worlds refuse joins, posts and chat; Amigo picks; chat moderation; all audit-logged.
    Live journey on Preview (two phones, `.github/workflows/live-worlds.yml`): countdown → join → live without a
    reload → notice → post/entry/like/leaderboard → chat in ~4 s → ended, chat closed, late posts refused.
    Migration 20261019120000 (live). Test World removed afterwards.
  - **Audit (22 findings) — fixed**: legal gate failed open on a network error (now fails closed with retry);
    blocking now hides posts/replies/likes both ways, refuses replies/likes across a block and suppresses
    notifications (migration 20261019130000, live; `test:blocking`); profiles show Unblock; replies have like +
    options; admin message reports enabled on Neon; admin overview loads counts independently and counts reported
    posts; real error states in Admin Worlds and Monetization; specific publish-failure reasons; viewer profile
    retry; corrected privacy text; unknown admin sections. **Open**: legal `[OWNER]` placeholders; World chat
    messages can't be reported yet; no email-verification nudge outside Settings.
  - Next: Preview journeys, production deploy, report (QUALITY.md).
- **Performance & stability (2026-10-18, on production as `dpl_9xexuvhTA3HASvJ5wd5QRE6cg9Hs`, commit `0efd9e8`)**: first paint on 3G 9.5 → 4.0 s, warm feed on 4G 3.0 → 1.3 s, screen revisits ~0.1 s, idle traffic −60 %, message delivery p50 ~0.85 s; resilient posting/messaging offline; privacy-safe perf monitoring. Load test: 100 simulated users, p95 85 ms, 0 errors. Details: [PERFORMANCE.md](PERFORMANCE.md).
- **iPhone QA findings + image viewer / photo caching (2026-10-18)**: conversations open from one batch
  decrypt (key lookups 50 → 2; a device without old keys 15.9 s → 4.4 s on 4G), never stay on the skeleton
  (content, empty state or Retry within 20 s), and a missed-new-message race is fixed; iPhone composer pinned
  above the keyboard; push for likes, replies, reply likes, follows and Support Hub support (grouped, rate
  limited, block- and preference-aware, no post text); Worlds "How to enter" card and empty states (scoring
  unchanged); full-screen photo viewer with locked background, pinch/pan/swipe and exact position restore;
  bounded service-worker cache for feed photos (never message attachments), cleared on sign-out and account
  switch. Migrations 20261019130000 and 20261019140000 (live). Details and measurements: [QUALITY.md](QUALITY.md).

## Blockers / owner decisions
- **Production (2026-10-17, owner-authorized)**: `https://amigo-app-one.vercel.app` serves the redesigned app on Neon + R2 (deployment `dpl_2be8nDqcHjFxZYt3qujfNkYorUYo`, commit `e223f1a`, deployed from this branch; `main` not merged). Legacy rollback: Vercel instant rollback to `dpl_BLQeNsTyyeeSUgpZSyvnAR62AuaS` (`main` @ `d344bac`); Firebase untouched. A push to `main` would redeploy the legacy app to production. The owner added the production domain to the R2 CORS rule; the production smoke test (`.github/workflows/prod-smoke.yml`) passes in full, including photo uploads and encrypted chat photos. Current production: `dpl_9W3zzhEK2AmdvTS5jeisyM1MfNE9` (commit `efa7658`, 2026-10-18, iPhone QA + viewer/photo cache); previous `dpl_6apEagqiaQVaSALbmubj4crsMCS4` (commit `e629bb6`); the legacy rollback above is unchanged.
- **Vercel**: deployments are readable again (calls must omit the team id); the latest commit is READY on the branch preview. **Opening the protected preview from here still fails (403 on the protection bypass)** — the owner must re-authorize the Vercel connector for the "amigo's projects" team (claude.ai → Settings → Connectors → Vercel → reconnect, select the team), or add a Protection Bypass for Automation secret.
- ~~Media storage → Cloudflare R2~~ **Live-verified 2026-10-17** (see Done). For production: add the production domain to the bucket CORS rule and set the R2 variables for Production.
- **Legal drafts**: `[OWNER: …]` placeholders cover entity, address, contact, governing law and minimum age (drafted as 13). Needs legal review.
- ~~Test-account cleanup~~ **Done 2026-10-17** (owner-approved): 14 test accounts removed after re-verification; 3 real accounts and their data untouched.
- **Admin**: the owner account @amigoisaboy holds admin (granted 2026-10-12, email verified; audit log shows its World actions on 2026-10-18). No other admins; there is no admin sign-up.

## Next
1. Drive an encrypted message photo through the browser UI in the live test; then video posts and voice notes.
2. Voice notes after media. **GIFs are blocked:** Tenor's API shut down on 2026-06-30. GIPHY's free key is reportedly a beta key (about 100 calls/hour); production needs an application and possibly payment, and searches may have to come from the user's browser, which exposes their IP to GIPHY. An owner decision and key are needed, and GIF URLs in encrypted chats would be external, unencrypted media.
3. Per-page sharing previews (needs a small server function).
4. Live re-test on Neon for the new DM actions, with two dedicated accounts, then remove them.

## Notes
- After a migration, refresh the Data API schema once by re-saving its config. This causes about a minute of failed requests.
- Don't use SQLSTATE codes starting with `PT`: PostgREST treats them as HTTP statuses.
- Live tests run from temporary GitHub Actions workflows, removed after use.

_Last updated 2026-10-19._
