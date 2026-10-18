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
- Push in Google Chrome through Google's real push service (desktop browser, not a locked phone).

### Live runs (2026-10-18)

| Suite | Commit | Result |
|---|---|---|
| Media API (real R2 + Neon) | e7de076, 080dc0b | passed |
| iPhone 13 browser journeys | e7de076, 080dc0b | all passed, including the encrypted photo message (recipient decrypted it; R2 holds ciphertext only) |
| Worlds, two phones | e7de076 | all passed: live on time without a reload or an admin, notice, post/entry/like/leaderboard, chat in 0.8 s, winner, chat closed, late posts refused |
| Push, Google Chrome | 080dc0b | Settings offers it; subscription refused because Playwright's browser contexts behave like incognito windows, where Chrome doesn't support push ("Registration failed - permission denied"). Re-run with a normal Chrome profile (31cb02b): **all passed** — device registered with Google's push service, test notification delivered, a new message notified the device while Amigo was closed with only "You have a new message on Amigo." (no text or names), tapping opens that conversation, turning off unregisters |

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

---

# iPhone QA findings and image viewer / photo caching (2026-10-18)

Reported from a real iPhone during a live World. Fixed on the branch, validated on Preview (same production
database, temporary accounts deleted afterwards). Scoring formula unchanged; encryption design unchanged.

## A. Messaging: slow or stuck conversations

**Root cause (reproduced on Preview before fixing):** opening a conversation decrypted each message on its
own, so every message triggered its own device-key lookup and key-store sync (50 lookups for 30 messages);
messages whose keys were missing were retried on every refresh. On a device without the old keys this took
15.9 s on 4G and 36.2 s on 3G behind the skeleton. A second, intermittent bug: a message stored between the
first load and the first background check was never shown until something else changed.

**Fixes:** one batch decrypt per load (2 key lookups instead of 50), failed decrypts remembered until new
keys arrive, previously decrypted messages reused from memory (never written to disk in plaintext), photos
shown as a placeholder and decrypted in the background without refetching, the device setup runs in
parallel with the fetch, background bookkeeping deferred 3 s, and a 20 s watchdog that always ends in
content, an empty state or a Retry. The first background check now refreshes once (race fixed; regression
test fails on the old code).

| Conversation open (30 messages, Preview) | Before 4G | After 4G | Before 3G | After 3G |
|---|---|---|---|---|
| Cold (new tab) | 3.84 s | 3.2 s | 6.1 s | 6.5 s |
| From the inbox | 0.64 s | 0.54 s | 1.19 s | 2.17 s* |
| Repeat open | 0.08 s | 0.085 s | 0.08 s | 0.086 s |
| Device without the old keys | 15.9 s | 4.4 s | 36.2 s | 5.6 s (ends on the "approve this device" screen) |

\* single run; 3G timings vary by ±1 s between runs.

**Composer (iPhone):** the conversation is pinned to the visible viewport (`visualViewport`), so the
composer sits directly above the keyboard, the header stays put and the page behind can't scroll. Live
iPhone 13 emulation: no gap or overlap while typing, header fixed while typing and after sending.

## B. Push for activity

Likes, replies, likes on replies, follows and Support Hub support now push (the in-app notifications
already existed). Delivered by the existing Web Push sender: the server picks pending notifications with
`FOR UPDATE SKIP LOCKED`, groups bursts per person, kind and post ("Sam and 4 others liked your post."),
limits to one push per minute per post and kind, never pushes across a block, honours the "Likes, replies
and follows" switch (on by default) and never includes post or message text. Each notification is pushed at
most once (`pushed_at`). Live (Google Chrome, real push service, no Amigo tab open): "Push Test A liked your
post." arrived and opened that post.

## C. Worlds

A "How to enter" card on live Worlds: what counts as an entry (posts shared to the World's competition),
how points are scored (shown from the World's own settings, formula unchanged), when it ends, and a button
to the Entries tab — or "Tap Join above" for non-members. States plainly that Live posts and chat messages
aren't entries. Empty leaderboard and entries tabs explain how to enter and link to it. Small screens: the
duplicate hero text was removed, chat uses page scroll with the composer above the keyboard, the bottom bar
hides while typing, and switching tabs no longer jumps the page. Live journey on two phones passed twice
(entry, like, leaderboard, chat 0.8 s, winner shown).

## D. Image viewer

Full-screen overlay; the page behind is locked (`position: fixed` at the current offset, which also works
in iOS Safari and the Home-Screen app) and restored exactly on close. Pinch to zoom (1–4×), pan when zoomed,
double-tap to zoom, swipe sideways between photos, swipe down or tap outside to close; all gestures are
handled by the viewer (`touch-action: none`), never by the page. Keyboard: arrows, Escape, + / − / 0; focus
returns to the photo that opened it. The feed-sized copy shows at once, the full photo replaces it when
loaded, and the next photo's full copy is preloaded.

Live iPhone 13 emulation: viewer shows the full photo, the feed behind can't scroll, closing returns to
the same place. Emulated iPhone SE (demo): all 11 checks passed.

## E. Photo caching

**Audit first:** photos are private R2 objects read through short-lived signed links (stable for 30 min),
so the browser's HTTP cache only helps within that window and is dropped by iOS under storage pressure.
Feeds already used ~1080 px copies (1.09× display size); full photos were loaded only in the viewer.

**Added:** a bounded service-worker cache (`amigo-media-v1`) for public-feed photos only (post photos,
avatars, Moment photos). It's keyed by the photo's location without the signature, so a newly signed link
for the same photo is answered from it, but only while that link is itself valid — the server still decides
every read. Limits: 300 photos, 4 MB each, oldest out first; Moment photos kept 1 day, others 14 days.
**Never cached:** message attachments (`/dm/`, encrypted) or anything decrypted. Cleared on sign-out,
account deletion and when a different account signs in on the device. Upcoming feed photos (one screen
ahead) load early, except with Data Saver or on 2G.

| Feed photos (Preview, phone profile) | 4G | 3G |
|---|---|---|
| Cold, first photo | 3.4 s | 13.7 s |
| Reload, first photo | 1.4 s | 2.7 s |
| Cold: photos the service worker downloaded | 5 of 5 | 8 of 8 |
| Reload: photos answered by the app's photo cache | 5 of 5 (0 downloads) | 8 of 8 (0 downloads) |
| Later visit (new tab, browser cache cleared): photo downloads | **0** | **0** |
| Later visit, first photo shown | 3.1 s | 11.9 s* |
| Viewer: feed copy shown | 0.09–0.14 s | 0.08–0.11 s |
| Viewer: full photo shown | 0.12–0.44 s | 0.09–0.42 s |
| Sign-out | 8–10 cached photos → 0 | |

\* On a later visit with the browser cache cleared, the time is the app itself downloading again over 3G
(the same as a cold load); none of it is photos. Ranges are from two runs (16:32 and 16:50 UTC).

Unit tests (`test:sw-cache`, 14 checks): re-signed links come from the cache without a download, expired
links never do, message attachments and other hosts are never touched, non-images, refusals and large files
aren't stored, at most 300 kept with oldest first out, old Moment photos refetched.

## F. Found by the live tests and fixed

- The recipient sometimes didn't see a new message (the first-check race above).
- The live media test read the conversation before the background photo decrypt finished, and the push
  test counted the device list before it reloaded (test timing, fixed in the tests).
- The photo-cache measurement compared against a request type that never occurs and always reported 0;
  it now also counts the service worker's own downloads and measures the later visit in a fresh tab.
- Test runs overlapped a new Preview build taking over the URL mid-run (a push to the branch rebuilds it);
  re-runs now go on an unchanged commit.

## G. Remaining limits

- **Needs a real iPhone:** keyboard behaviour across iOS versions, pinch feel, and locked-screen pushes
  (automated: iPhone 13 emulation and desktop Chrome via Google's push service).
- A device that was never approved for messages still has to be approved before old messages decrypt
  (by design of the encryption; it now reaches that screen in ~5 s instead of spinning).
- Older photos have no small copies; World chat messages can't be reported yet; legal placeholders.
