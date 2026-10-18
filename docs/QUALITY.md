# Amigo World — functionality, media UX and reliability phase

Branch `claude/amigo-world-restart-7mrbrf`. Measured and tested on the branch Preview, which shares the
production Neon database (temporary accounts only, deleted after each run). `main` was not merged.
Migrations are additive and were applied live with the security checks (no function executable by PUBLIC,
row-level security on every table) and a Data API schema refresh after each one.

## 1. What was broken

| Area | Problem | Severity |
|---|---|---|
| Legal | The acceptance gate let people in when its check failed (network error) | Critical |
| Legal | Drafts contain `[OWNER: …]` placeholders (entity, address, governing law, minimum age) | Critical — needs the owner |
| Images | 5 signing calls per screen; full-size photos (1.6–4.2× display size) in feeds; signed links changed every second, so reloads re-downloaded every image; no placeholder while loading | High |
| Moments | Photos always cropped to fill; no zoom, framing or caption position; viewer showed a blank frame until the photo loaded, no retry, next Moment not preloaded | High |
| Notifications | No push notifications at all | High |
| Worlds | Admins couldn't create, edit or cancel a World in the app; status relied on each device's clock; nobody was told when a World opened | High |
| Blocking | Stopped messages and follows only: blocked people's posts, replies and likes still showed, they could still reply/like/mention, and those still notified | High |
| Admin | Message reports had no review screen on Neon; the overview hung if any one count failed and didn't count reported posts | High / Medium |
| Profiles | No sign that you'd blocked someone, no Unblock on their profile | High |
| Replies | No like button or options (edit, delete, report, block) on replies | High |
| Settings | Privacy text claimed a per-post audience choice that doesn't exist | High |
| Errors | Admin Worlds showed "No Worlds yet" and Monetization "coming soon" when loading failed; publishing failures never said why (rate limit, suspension); a failed profile read left the app showing a placeholder handle | Medium |
| Low | "Preview · Neon" label in production; unknown admin sections were blank | Low |

## 2. What was fixed

- **Image pipeline**: one batch signing call per screen (`/api/media-sign`); a ~1080 px copy of each new
  photo for feeds and grids (readable exactly when the original is); a ~24 px blurred preview stored with
  each post and Moment and shown instantly; signed links stable for 30 minutes so the browser cache works;
  the R2 host is preconnected at startup. Private objects stay private (every read is still decided by
  Postgres and signed for one object); encrypted DM photos are unchanged (ciphertext only, decrypted on the
  device, no copies or previews).
- **Moments**: full-screen viewer that handles portrait and landscape photos (fill, or the whole photo over a
  blurred copy), zoom 1–4× and focus point chosen in the composer, caption position, gradients and safe areas,
  progress bars, tap navigation, press-and-hold pause, next-Moment preloading, loading and Retry states,
  accessible labels. 24-hour expiry and audience rules unchanged; CSS-only transitions.
- **Web Push**: standard Web Push (RFC 8291 encryption, RFC 8292 VAPID) from a Vercel Edge function; no paid
  provider. Permission only asked when the person taps the button in Settings. Each device subscribes
  separately and can be removed; expired subscriptions are deleted when the push service says so; retries
  on temporary failures; per-person preferences; respects blocking. Pushes carry only "new message" and the
  conversation id — the notification says "You have a new message on Amigo." and never includes message text,
  names or keys. Tapping opens that conversation. iPhone guidance: add Amigo to the Home Screen first (iOS
  16.4+).
- **Worlds**: admin create / edit / cancel with fairness locks once a World has started (start time, link and
  scoring fixed); status from the server clock; a "live" notice and push to members when a World opens,
  triggered by any signed-in app (no admin tab needed); cancellation notices; join/leave, posts, entries,
  likes, leaderboard with temporary points, winner card, chat, Amigo picks, chat moderation; audit log. No
  prizes are paid — prize text is display only; no money or gambling mechanics.
- **Audit fixes**: everything in the table above except the legal placeholders (needs the owner). Blocking
  now works both ways across posts, replies, likes and notifications (and undoes cleanly on unblock).

## 3. What was measured (Preview, Pixel 5 profile)

| Measure | Before | After |
|---|---|---|
| 4G cold load, first feed photo | 6.0 s | 4.0 s |
| 4G cold load, all visible photos | 7.3 s | 4.0 s |
| 4G cold load, image bytes | 1354 KB (5 images) | 409 KB (7 images) |
| Signing requests per screen | 5 | 1 |
| 3G cold load, first photo | 36.6 s | 22.6 s |
| Image size vs display size | 1.6–4.2× | 1.09× |
| 4G reload | images re-downloaded | all from cache (0 KB), first photo 1.55 s |
| 3G reload, first photo | 11.4 s | 2.5 s |
| World chat delivery to another member | — | ~4 s (polling every 4 s; no Realtime on Neon) |

Photos posted before this phase have no small copy or blurred preview; they still load (full size), just
more slowly.

## 4. What passed automated tests

Local (Postgres + PostgREST + S3 stand-in, both schemas):
`test:api`, `test:e2e`, `test:moments`, `test:media`, `test:dm-actions`, `test:push` (push encryption,
VAPID, targets, privacy of payloads, expired-device cleanup), `test:worlds` (43 checks: admin rules,
server-timed transitions, notices, pushes, picks, moderation), `test:blocking` (22 checks, new).

Live on Preview (GitHub Actions, real Neon + R2, temporary accounts deleted afterwards):
- Media API test (real R2): signatures, private bucket, CORS, visibility rules, small copies, encrypted DM
  photo round trip.
- iPhone 13 browser: legal gate, photo post, offline → saved → resent when back online, profile picture,
  photo Moment, encrypted photo message (sender and recipient), no horizontal scroll.
- Worlds journey on two phones: countdown, join, goes live on time without a reload, "live" notice,
  post, competition entry, like, leaderboard, chat, ended state, closed chat, late posts refused.
- Push in Google Chrome through Google's real push service: see "Live runs" below.

### Live runs (2026-10-18)

| Suite | Commit | Result |
|---|---|---|
| Media API (real R2 + Neon) | e7de076, 080dc0b | passed |
| iPhone 13 browser journeys | e7de076, 080dc0b | all passed, including the encrypted photo message (recipient decrypted it; R2 holds ciphertext only) |
| Worlds, two phones | e7de076 | all passed: live on time without a reload or an admin, notice, post/entry/like/leaderboard, chat in 0.8 s, winner, chat closed, late posts refused |
| Push, Google Chrome | 080dc0b | Settings offers it; subscription refused because Playwright's browser contexts behave like incognito windows, where Chrome doesn't support push ("Registration failed - permission denied"). Re-run with a normal Chrome profile: PUSH_RESULT |

Found by the live push test: a push service that never answers left the switch spinning (now times out
after 30 s), and people in a private/incognito window got a generic error (now told why).

## 5. Still needs real-device testing

- **Locked-screen notifications** on a real Android phone and on an iPhone with Amigo added to the Home
  Screen. Automated tests prove delivery to a desktop browser's service worker, not what a locked phone shows.
- Moments gestures (press-and-hold, swipe) on real touch screens; framing on very tall and very wide photos.
- 3G behaviour on a real device and carrier (measurements above use network throttling).

## 6. What remains unfinished

- Legal drafts: `[OWNER: …]` placeholders and legal review.
- World chat messages can't be reported yet (posts and Worlds can).
- No email-verification reminder outside Settings.
- The encrypted photo message occasionally fails to show for a brand-new recipient in the live test
  (passed on most runs; diagnostics added to pin it down).
- Older photos have no small copies (a one-off backfill could create them).
- No admin account until the owner's identity is confirmed.
