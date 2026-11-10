# Integration into `main` (November 2026)

`main` moves from `d344bac` (the old Firebase-era app) to `bac33c5`, the build the launch commercial
was recorded on, plus one documents-only commit. It is a fast-forward: no history is rewritten.

## What `main` now contains that Production (`59ffe24`) did not

| Change | Commit | Database |
| --- | --- | --- |
| Navigation redesign (phone bar, header bell and avatar, desktop "More", Explore tabs) | `c8a7243` | — |
| UI refresh: Settings groups, profile header redesign, clearer sign-in and sign-up | `c0780c4` | — |
| 18+ self-declaration at sign-up and on the consent screen | `c52338f` | — (see legal) |
| Help Hub, Kudos and Helpers wording | `2f4b2a8` | — |
| Creator restore fix | `2f4b2a8` | `20261106` (held) |
| Creator Programme eligibility | `1b18e44` | `20261105` (held) |
| Post view counts (admin switch, off) | `ff2ea19`, `0b1dd36` | `20261104` |
| Business creation form, Businesses and Marketplace linked | `1f7dd20` | — |
| Session check: sign-in after 10 s instead of an endless splash | `bac33c5` | — |

Already in Production and unchanged: reservations (`7061af6`), the reservation site (`reserve/`),
the access gate (`middleware.ts`), Marketplace (switched off).

## Not in `main`

- About 940 MB of commercial media from `095c820` (stock video, narration, animatic). They stay on the
  `claude/amigo-world-restart-7mrbrf` branch, untouched. `.gitignore` now keeps large video and audio
  files out of the repository.

## Database (Neon `main`)

| Migration | Status | Why |
| --- | --- | --- |
| `20261104090000_post_views` | Applied with this release | Additive; the `post_views` switch stays off |
| `20261105090000_creator_eligibility` | **Held** | Until the owner approves the final eligibility policy. Without it the app keeps today's rules: anyone may apply, approval isn't blocked. Admin → "Check a creator" shows an error until then. |
| `20261106090000_creator_restore` | **Held** | Depends on `20261105` |
| `20261029090000_football_predictions` | **Never apply** | Experimental; no app code |

Order for every migration: Neon restore branch → migration → Data API schema refresh with identical
settings → check the settings → deploy the app. Apply migrations one by one, never "all".

**Convert before applying to Neon.** Repo migrations are written for Supabase. Apply the rules in
`scripts/neon/build-schema.mjs` first (`auth.uid()` → `app_auth.uid()`, `auth.users` →
`app_auth.users`, no Realtime publication), then compare `md5(pg_get_functiondef(...))` with
verify-1029.

**Applied on Production (Neon `main`), 10 Nov 2026:** restore branch `pre-integration-20261110`
(`br-odd-dawn-zas7mm49`) at 11:42 UTC; `20261104` at 11:43 UTC, both functions identical to
verify-1029; Data API refreshed with identical settings at 11:44 UTC; `post_views` switch off.

## Settings

No new environment variables. `MAINTENANCE_MODE` stays `on`. Feature switches unchanged: Marketplace
off, Business Pages on, reservations open, Creator applications open, post views off.

## Rollback

| What | How |
| --- | --- |
| App | Vercel instant rollback to `dpl_A5bthRM9iq4drmrRwAZVZkwzPNZT` (`59ffe24`) |
| `20261104` | Not needed for an app rollback (the old app ignores it). To undo: drop `record_post_views`, `post_view_totals`, tables `post_views` and `post_view_counts`, and delete the `post_views` row in `app_features` |
| Whole database | Restore from the Neon branch `pre-integration-20261110` (loses changes made after it) |
| Git | Nothing to undo: Production rolls back independently of `main` |

## Legal

No legal document is published by this release. See `docs/legal-drafts/REVIEW-0.2.md`. The gate stays
on until Terms and Privacy 0.2 are published together.
