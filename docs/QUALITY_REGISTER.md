# Amigo World — issue register (owner iPhone reports + systematic audit)

Branch `claude/amigo-world-restart-7mrbrf`, verified on the branch Preview (shares the production Neon
database; temporary test accounts only, deleted after each run). Production is unchanged (b12c7ec) until
the owner approves. "Live test" = the GitHub Actions suites in `.github/workflows/live-interactions.yml`,
run on iPhone-sized Chromium and WebKit browsers. Automated browsers are not physical devices: items
marked *needs iPhone check* are confirmed by test, not yet on the owner's phone.

## Register

| # | Severity | Area | Problem (how it was reproduced) | Root cause | Fix | Verified |
|---|---|---|---|---|---|---|
| 1 | High | Moments | Black preview after picking a photo (owner's iPhone). Reproduced in WebKit: preview present but invisible and Share stuck disabled | `MomentVisual` reset the photo to "loading" in an effect *after* render; a photo already in memory (just picked) can finish loading first, and the reset left it transparent over the black background forever | Load state kept with the URL it belongs to (no reset effect) | Live test (24 MP, EXIF-rotated), Chromium + WebKit; *needs iPhone check* |
| 2 | High | Photos (all uploads) | iOS can hand back a blank (black) decode for 24–48 MP camera photos (canvas/bitmap memory caps); canvases were never released | One decoder, output never checked; canvases kept until GC | Decoded output is checked; a blank result is retried with the `<img>` decoder (downsamples on iOS); canvases released at once; error shown if both fail | Fallback forced in a local test; live test both engines |
| 3 | Medium | Photos | HEIC refused outright; full-screen photos soft (1600 px) | Old limits | HEIC tried (Safari opens it) with a clear error elsewhere; 2048 px uploads (feeds still load 1080 px) | Live test (2048 px served) |
| 4 | High | Moments composer | A photo whose preview failed still showed black and could be published | No preview state in the composer | "Preparing your photo…", error message, Share disabled until the preview has loaded | Live test |
| 5 | High | Sheets (all) | A post's sheets "closed by themselves"; any tap on the backdrop or the end of a drag opened the post behind | Sheets render inside the post card, so their clicks bubbled to the card's navigate-on-click | Sheets keep their clicks; the card ignores clicks from dialogs; backdrop closes only for a press that starts and ends on it | Live test (drag out of a sheet), both engines |
| 6 | High | Photo viewer | Tapping Zoom in / out could close the viewer; tapping the dark space around a photo closed it; a pinch that ended low could close it | The stage captured the zoom buttons' presses; tap-outside-closes on touch; multi-finger gestures read as taps/swipes | Buttons excluded from capture; dark-space tap closes only with a mouse; multi-finger gestures never close | Live test, both engines |
| 7 | High | Moment viewer | Pinching a Moment closed it or skipped to the next; no zoom | One-finger gesture code read the last finger's lift as a swipe/tap | Pinch-zoom + pan (Moment pauses), Done to zoom out; multi-finger never closes/skips | Live test, both engines |
| 8 | High | Posting | A just-posted photo showed broken and couldn't be opened until the feed caught up | Composer's unmount clean-up freed the previews it had just handed to the post | Previews belong to the publishing queue once handed over | Live test |
| 9 | High | Messages | Several quick messages arrived shuffled (1, 3, 5, 2, 4) | Sends ran side by side; server timestamps followed network arrival | Sends go one at a time per conversation, in order written | Live test: five in a row, in order, both engines |
| 10 | High | Messages | Banners only when a conversation *became* unread (more messages in it: none), up to 15 s late | Banner watched the unread-conversation count | Banners from a live inbox: every new message from someone else, ~2 s (Chromium) / ≤10 s (WebKit) | Live test, both engines |
| 11 | High | Whole app | Notifications, follower counts, new posts needed a refresh (30 s polls; profiles never refreshed) | Neon has no Realtime; each view polled on its own | `app_pulse` change check (4 s active / 20 s idle / never hidden), targeted refreshes, catch-up on return and reconnect; profiles refresh on change | Live test: badge 3–4 s, follower count 2 s, reconnect ≤1 s, return ≤1 s |
| 12 | Medium | Messages | Composer leaked its photo preview memory on each send | URL not released | Released on send | Code review |
| 13 | Medium | Messaging setup | (earlier) first device stuck unapproved after an interrupted setup | see b12c7ec | — | In production |
| 14 | Info | Highlights | No separate Highlights feature exists; the circles row is Moments | — | Fixes apply to Moments | — |
| 15 | Critical | Moments | Tapping right to advance sometimes opened the photo or post underneath (owner's iPhone). Reproduced in WebKit: a Moment opened from the feed over a photo post; tapping right on the last Moment opened the feed photo's viewer | Steps ran on `pointerup`. On the last Moment that closed the viewer at once, and the same tap's `click`, which the browser sends after `pointerup`, landed on the feed now underneath | Steps run on the tap's own `click` (still aimed at the open viewer); any Moment or photo viewer closing swallows clicks still on their way for 450 ms | Live test `live-moment-taps` (fails on the old code in WebKit, passes on the fix in Chromium + WebKit): taps left/right, through the last Moment, rapid taps, hold, close; zero clicks reached the feed; *needs iPhone check* |
| 16 | Medium | Settings | Every interest listed inline in Settings | — | "Interests" row → its own screen (same `user_interests` storage), Save only when changed, saved / error message | Live test `live-onboarding`, both engines |
| 17 | Feature | Home | Bottom bar always took space while reading the feed | — | On Home only: hides scrolling down, returns on scrolling up, near the top, on other screens and on keyboard focus; small movements and bounce ignored; fixed, so nothing moves; reduced motion: no slide | Live test `live-bottom-nav`, four iPhone sizes, both engines; *needs iPhone check* |

## How "live" each part is

Neon (the database) has no Realtime push to browsers; Neon Realtime is not available for this project.
Everything below runs only while the app is on screen; iOS suspends a Home Screen app in the background,
where Web Push (Settings → Notifications) takes over for messages and activity.

| Feature | While open | On returning / reconnecting |
|---|---|---|
| Open conversation | ~1 s change check | immediate |
| Inbox, message badge, message banners | ~3 s change check | immediate |
| Notifications list, badge, activity banners | ≤4 s (app pulse) | immediate |
| Your follower / following counts (profile) | ≤4 s | immediate |
| Like / reply counts on your posts | ≤4 s after the notification; others' posts 30 s | immediate |
| New posts (Home) | "New posts" pill ≤4 s, feed doesn't move | immediate |
| Moments | ≤4 s for public Moments; followers-only 30 s | immediate |
| Worlds (posts, standings / chat) | 10 s / 4 s | immediate |
| Support Hub, Creator Programme status | 30 s | immediate |
| New app version | notice on return to the app (checked at most every 10 min) | — |

## Not changed / limits

- Google sign-in uses Neon Auth's **shared** Google credentials: it works, but Google's consent screen
  shows Neon, not Amigo World. Owner: create a Google OAuth client and add it in Neon Auth.
- **Apple** sign-in: Neon Auth offers Google, GitHub, Microsoft and Vercel only — not offered.
- Verification emails come from Neon's shared sender (auth@mail.myneon.app); delivery to spam is likely.
  Owner: configure a custom SMTP sender in Neon Auth. Email verification is not required to use the app
  (unchanged server rule).
- Interests are stored only; nothing ranks or filters by them yet (the app says so).
- A Google sign-in can't be completed by automated tests (needs a real Google account): *needs iPhone check*.

## Production release (owner-approved, controlled — not a public launch)

- Production: `dpl_FJv9CkuTpmAKfMGLnkGRvLUHx2qd`, commit `b8e76ed` (app code identical to `4a66b4e`;
  later commits are tests and docs). Rollback target: `dpl_4oP1FjsDuH32EFTXJ8kEZ2C4NNsk` (`b12c7ec`).
- Full live suite on production: every step passed in Chromium and WebKit (likes/replies, Moment
  reactions, Follow Back, Creator Programme, direct messages, photo Moments, viewers and sheets, live sync,
  joining Amigo incl. Google refusing gracefully).
- Unchanged by the release (checked before and after): Creator Programme settings (applications open,
  programme open — set by the owner), the owner's encryption identity and 13 device records, account,
  post and message counts; no test accounts left.
- app_pulse: ~1 call per 3–4 s per open app, ~1.1 ms each (max 3.6 ms); none while the app is hidden.
