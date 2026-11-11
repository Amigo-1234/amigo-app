# Commercial screen recordings: runbook and raw footage

Record **only** on the recording Preview: https://amigo-app-git-recording-commercial-amigos-projects-73fa05d5.vercel.app (database `recording-1103`: 13 cast accounts plus the `@amigoworld_team` admin, no real users). On each phone, open the Preview once through the share link first (it sets the Vercel access cookie for 23 h; ask for a fresh one when it expires). Sign-in details: `secrets/commercial-demo-accounts.json` (never in footage, never on screen).

## Phone set-up (every phone, before every session)

- Dark mode; Do Not Disturb on; full battery; Wi-Fi strong; text size default; English.
- Status bar 9:41 if possible; otherwise it is replaced in the edit.
- Screen recording at native resolution; no touch indicators.
- First visit after the database has been idle can take a few seconds to wake; if the sign-in screen appears, sign in again.
- Never open the live site amigoworld.com.ng or the verify-1029 Preview on a recording phone.

## Naming

`S<scene>_<account>_<what>_take<NN>_<device>.<ext>`, e.g. `S08_femi_explore-follow_take02_iphone15pro.mov`. Put each file in its scene folder. Keep every take; mark the chosen one in the table below.

## Scenes

| Scene | Folder | Account(s) | Status | What to capture |
| --- | --- | --- | --- | --- |
| S6 App open | `S06-app-open` | Femi | **Ready (one phone)** | Add the Preview to the Home Screen once (Share → Add to Home Screen), then: tap the icon → branded loader → Home feed. 3 takes. |
| S7 Post and Moment | `S07-post-and-moment` | Kemi | **Partly blocked** | Text-only post and a text Moment: ready. **Photo post and photo Moment: blocked**, because the recording Preview has no photo storage (uploads will fail). Options: film text-only versions, or decide on test-only storage later. |
| S8 Explore and follow | `S08-explore-follow` | Femi | **Ready (one phone)** | Explore → search "photo" → open `@seyi_shoots` → Follow → open `@zainab_lens` → Follow → Femi's own profile shows "Follows you" from Seyi. **Between takes: unfollow Seyi and Zainab** so the next take starts clean. |
| S9 Encrypted chat | `S09-encrypted-chat` | Kemi + Bisi | **Needs two phones** | Both phones signed in (Kemi on one, Bisi on the other) and messaging set up on each before rolling. Text message, heart reaction, swipe to reply. **Photo message: blocked** (no photo storage). Record both screens at the same time. |
| S10 Ada's business page | `S10-ada-business` | (frames) | **Done: approved composite** | Use `composite-frame-1…4.png` (approved 3 Nov). Not a live recording; see `../ada-atelier/README.md`. |
| S11 Help Hub | `S11-help-hub` | Tobi; Femi, Ada as helpers | **Ready, with one decision** | Request page for "Listen to my new song — does the chorus land?" (0 of 10 helpers, real SoundCloud link) → Femi and Ada each "Help out" → confirm → leave feedback; Tobi sees the reply notification. **Tobi has 0 Kudos**, so filming him *submitting* a new request needs +5 Kudos first (admin adjustment) — or film the form only up to Review. Keep the Kudos balance and "+kudos" toast out of frame. |
| S12 World live | `S12-world-live` | Femi + others, admin for Amigo pick | **Needs a live World and several phones** | Golden Hour Lagos is scheduled 10 Nov 17:30–19:30 Lagos. **Move it only when you are ready to record** (Admin → Worlds, as `@amigoworld_team`). Capture: countdown at 00:00:10 → live notice → Femi's entry → reactions/replies → live chat → leaderboard with "Amigo pick +10". **Entry photo is blocked** (no photo storage); a text entry works. |
| S13 Rooftop message | `S13-rooftop-message` | Kemi | **Needs S9 first** | Kemi's chat showing Bisi's message, on her phone at the rooftop. |
| Clean plates | `clean-plates` | any | Ready | Each screen above captured idle for the motion-graphics team. |

## Footage log

App-only clips recorded 4 Nov 2026 by automated capture: the recording Preview's build (commit `bac33c5`) running locally against `recording-1103`, Chromium at iPhone 15 Pro size (393×852 pt, 3×), dark mode, Lagos time. Frames from Chromium's screencast, encoded H.264 1180×2556 at 60 fps (1 px dark column added on the right for H.264's even width; it disappears in the phone mockup). No status bar or home indicator: add them in the mockup. Every interaction is a real one in the app; other accounts' likes, replies, chat lines and the Amigo pick were made through the app's own API as those accounts.

| File | Scene | Take | Length | Chosen | Notes |
| --- | --- | --- | --- | --- | --- |
| `S06-app-open/S06_femi_app-open_take01_…mp4` | S6 | 01 | 9.9 s | yes | Splash → Home feed. Starts from the browser, not a Home Screen icon tap |
| `S07-post-and-moment/S07_kemi_text-post_take01_…mp4` | S7 | 01 | 13.4 s | no | iPhone notifications card pops up after posting |
| `S07-post-and-moment/S07_kemi_text-post_take02_…mp4` | S7 | 02 | 13.5 s | yes | + → New post → Post → appears with "Posted" |
| `S07-post-and-moment/S07_kemi_text-moment_take01_…mp4` | S7 | 01 | 14.4 s | no | Same card behind the sheet |
| `S07-post-and-moment/S07_kemi_text-moment_take02_…mp4` | S7 | 02 | 14.4 s | yes | Text Moment on Sunset → shared → viewed |
| `S08-explore-follow/S08_femi_explore-follow_take01_…mp4` | S8 | 01 | 19.6 s | yes | Search "golden hour" → Seyi ("Follows you") → Follow Back → "lens" → Zainab → Follow. Follows reset after the take |
| `S09-encrypted-chat/S09_bisi_chat_take01_…mp4` | S9 | 01 | 33.2 s | yes | Bisi's phone. Recorded at the same time as Kemi's |
| `S09-encrypted-chat/S09_kemi_chat_take01_…mp4` | S9 | 01 | 23.3 s | yes | "typing…" → message arrives → double-tap ❤️ → swipe → quoted reply. Timestamps read 0:45 (shot after midnight) |
| `S11-help-hub/S11_femi_help-tobi_take01_…mp4` | S11 | 01 | 23.7 s | yes | Help out → confirm → Loved it + feedback. **Trim the "+1 kudos" toasts** |
| `S11-help-hub/S11_ada_help-tobi_take01_…mp4` | S11 | 01 | 24.0 s | yes | Same, Nice work. **Trim the "+1 kudos" toasts** |
| `S11-help-hub/S11_tobi_notification_take01_…mp4` | S11 | 01 | 12.8 s | yes | "Ada Nwosu and Femi Danjuma helped with your request" → request with 2 helpers and feedback |
| `S12-world-live/S12_femi_countdown-to-live_take01_…mp4` | S12 | 01 | 47.7 s | yes | "Starts in 37s" → LIVE without reload. Header shows "Wed, 4 Nov, 0:56 – 1:56" (real schedule) |
| `S12-world-live/S12_femi_entry_take01_…mp4` | S12 | 01 | 12.2 s | yes | Text entry submitted (photo entries need storage) |
| `S12-world-live/S12_femi_reactions-leaderboard_take01_…mp4` | S12 | 01 | 24.2 s | yes | Live like/reply banners; leaderboard 10 → 20 pts with the Amigo pick |
| `S12-world-live/S12_femi_chat_take01_…mp4` | S12 | 01 | 25.1 s | yes | Cast chatting live; Femi replies |
| `S10-ada-business/composite-frame-1.png` … `-4.png` | S10 | composite | stills | yes | Approved 3 Nov |

Golden Hour Lagos has now run (moved to 4 Nov 00:56–01:56 Lagos for S12; it can't be rescheduled once started). A retake of S12 needs a new World created in Admin → Worlds.
