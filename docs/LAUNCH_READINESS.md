# Launch readiness — Amigo World on Neon (preview)

_Assessed 2026-10-17 on branch `claude/amigo-world-restart-7mrbrf`. Nothing here is on `main` or Firebase production._

**Overall: not ready for public launch. Close to ready for a small invited beta**, once the
four blockers below are cleared.

## Blockers (must clear before any public launch)

1. **Legal text.** All seven documents are drafts (v0.1) with `[OWNER]` / `[LEGAL REVIEW]`
   placeholders: legal entity, address, contact, governing law, minimum age. They need the owner's
   details and a lawyer's review, then publishing as v1.0 from Admin → Legal.
2. **Deployment visibility.** The Vercel connection lost access to the team scope (403). The
   preview is behind Vercel Authentication, so deployments can't be verified from here, and a
   public launch needs the protection setting and the domain changed by the owner.
3. **Admin account.** No admin exists on Neon yet. The owner's account must be confirmed and
   granted admin; otherwise reports and suspensions can't be handled.
4. **Photos and media.** Photo posts, avatars, photo Moments and message attachments are off on
   Neon until a storage service is approved. That's acceptable for a text-first beta, but not for
   a public launch of a social app.

## Status by area

| Area | Status | Notes |
| --- | --- | --- |
| Sign up / sign in / reset | READY | Neon Auth through a same-origin proxy; codes by email; session sync fixed |
| Email verification | READY | By code from Settings |
| Account deletion | READY | Password re-check + typed DELETE; full cascade (tested locally) |
| Legal pages + acceptance | NEEDS ATTENTION | Machinery ready; the text itself is a draft (blocker 1) |
| Encrypted 1:1 messages | READY | Live-tested on Neon (20/20), 70 local E2E checks |
| Reactions, edit, unsend, search, older history | READY (local) | 19 local checks; **not yet live-tested on Neon** |
| Message photos, voice notes, video | DEFERRED | Needs media storage |
| GIFs | BLOCKED | Tenor API shut down (2026-06-30); GIPHY production access reportedly needs an application/payment — owner decision |
| Typing indicator | DEFERRED on Neon | Needs Realtime; skipped to save Free-plan resources |
| Feed, posts, replies, likes | READY | Text posts on Neon |
| Bookmarks, edit/delete post, copy link | READY (local) | Not yet exercised live |
| Profiles, follow, discovery | READY | Avatars need media storage |
| Moments | NEEDS ATTENTION | Text Moments only on Neon; expiry enforced by the database |
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
| Analytics | NEEDS ATTENTION | Admin aggregate stats only; no error-rate tracking yet (no third-party tracker added) |
| Test-account cleanup | BLOCKED (awaiting confirmation) | Script prepared, guarded, not run |

## Security checks (live Neon, after every migration today)

- No function in `public` is executable by `PUBLIC`.
- Every table in `public` has row-level security on.
- The Data API refuses all requests without a sign-in token (checked 2026-10-17 from GitHub
  Actions): signed-out visitors can't read anything, even public posts.
- New write paths (`dm_send_v3`, `dm_unsend`, moderation, post tools) are granted to signed-in
  users only, and each checks the caller in the database.
- Messages: the server sees that a reaction or edit relates to a message, but never its content
  (documented in `docs/architecture/MESSAGES.md`).

## Costs (Free plans only, nothing paid introduced)

- **Neon Free**: compute auto-suspends when idle. Polling is the main cost driver: messages pulse
  every 1 s only while a conversation is open, the inbox every 3 s, the badge every 15 s, other
  lists every 30 s, all paused in hidden tabs. Watch compute hours in a beta.
- **Vercel Hobby**: the auth proxy is an Edge function, and Data API calls go direct to Neon
  (no function invocation). Media delivery through functions would add invocations; check this
  before choosing Blob.

## Untested or only tested locally

- Reactions, edits, unsend and history paging against live Neon (local PostgREST only).
- Bookmarks, post edit/delete, reports and suspension against live Neon.
- Text Moments against live Neon.
- Real devices: iOS Safari long-press and swipe-to-reply gestures were not tried on hardware.
- Load: one benchmark of messaging latency; nothing at beta-scale concurrency.

## Recommended beta limits

- Invite-only, **≤ 50 people**, text-first (no photos), while compute hours are watched daily.
- One admin (the owner) on duty for reports; suspensions as needed.
- Existing server limits stay on: 30 Moments a day, 20 reports an hour per person, message size
  64 KB of ciphertext.
- Re-run the live Neon messaging test with two dedicated accounts before inviting people, then
  remove those accounts with the guarded cleanup script.
