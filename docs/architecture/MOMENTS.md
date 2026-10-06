# Moments

Casual posts that disappear **24 hours** after posting:
- a photo
- text on a background (Coral, Sunset, Ocean, Forest, Night, Plain)
- text over a photo

Each person can have several at once. Optional capability `moments` (demo + Supabase). Not on
the Firebase source.

## Where

- **Home:** a row near the top. *Your Moment* (or *Add yours* with a +) comes first, then people
  with Moments you haven't seen (coral ring), then everyone else (grey ring).
- **Profiles:** the avatar gets the same ring and opens that person's Moments.
- **Composer:** add a photo (same processing as posts: resized, metadata stripped), text (200
  max), a background, and an audience: *Everyone* or *Followers*. Close friends is left for later.

## Viewer

Full screen on phones; a 9:16 frame with arrows on desktop.

- **Navigation:** tap right/left (or ← →) for next/previous. Swipe sideways to skip a person.
  Moments auto-advance after 6 s, then move on to the next person.
- **Pause:** hold (or Space). Playback also pauses while you type a reply or a sheet is open.
- **Close:** swipe down, Esc, or Back.
- **Progress:** one bar per Moment.
- **Header:** the author's name links to their profile, plus a timestamp and a followers-only mark.
- **Reactions:** ❤️ 😂 😮 😢 🔥 👏, one per person.
- **Replies are sent through Messages** as a direct message ("Replied to your Moment …"). They
  get Messages' privacy, and on Supabase that means end-to-end encryption. Nothing about replies
  is stored with the Moment, and admins can't see them.
- **Your own Moments:** *Seen by N* opens the viewer list with reactions; ⋯ → *Delete* removes it
  before it expires.
- **Others' Moments:** ⋯ → *Report* uses the same reasons as message reports.

## Rules (both backends)

**Who sees a Moment:**
- Not expired and not removed.
- You're the author, or it's for Everyone, or you follow the author.
- Neither of you has blocked the other (blocks from Messages apply).

**Views:**
- A view is counted once per person.
- Only the author sees the count and the list.

**Admin → Reports → Reported Moments:**
- Shows the Moment, author, reporter, reason and note.
- *Remove Moment* takes it down for everyone, closes its reports, and is written to the admin
  audit log with an optional reason.
- *Dismiss* / *Reopen* are logged too.
- The Overview counts open reports.

## Supabase: migration `20261006220000_moments.sql`

Additive. Local only; nothing has been deployed.

- **Tables:** `moments`, `moment_views`, `moment_reactions`, `moment_reports`.
  - Clients can read `moments` through RLS (`moment_visible()`).
  - Everything else goes through `SECURITY DEFINER` functions: `create_moment`,
    `delete_moment`, `mark_moment_seen`, `react_to_moment`, `report_moment`, `moments_feed`,
    `moment_viewers`, `admin_moment_reports`, `admin_remove_moment`,
    `admin_moment_report_set_status`.
  - Error codes are `MO001`–`MO004`.
- **Photos:** stored in the **private** `moment-media` bucket, in the author's folder, and shown
  through signed URLs. Storage only signs a URL for people who can see the Moment (and for admins
  on reported ones), so a followers-only photo can't leak by URL.
- **Expiry:** expired rows are hidden at once. `purge_expired_moments()` is service-role only and
  is meant for a scheduled job that also removes the photo files. That job is **not set up yet**.
- **Realtime:** `moments` is in the publication so the Home row refreshes.

## Tests

- `supabase/tests/database.test.sql`: 35 Moments checks (298 total).
- `npm run test:moments`: 18 checks through PostgREST, as real users.
- Demo browser suite: 53 checks (scratch).

Storage upload and signed URLs can't run locally (there's no local Storage server), so photo
Moments on Supabase still need a check on a real project.
