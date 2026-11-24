# Amigo World launch: handover procedure (24 Nov 2026)

You are helping the owner of Amigo World (a social app at **amigoworld.com.ng**) launch it tonight at
**8:00 PM Lagos time (WAT) = 19:00 UTC, Tuesday 24 November 2026**. You can't see their computer or
accounts: tell them exactly what to click or type, one step at a time, and ask them to paste back
what they see. Never ask for passwords, API keys or the team access key.

## Where things stand

| Area | State |
| --- | --- |
| Live site | Closed behind a maintenance gate (`MAINTENANCE_MODE=on` in Vercel). Public sees "under development". Team members get in at `amigoworld.com.ng/_team` with an access key. |
| Code on `main` (GitHub `Amigo-1234/amigo-app`) | Commit `fab853c`. Vercel **branch tracking is on**: any push to `main` deploys to Production automatically (both projects: `amigo-app` and `amigo-reserve`). |
| Countdown + reservation redirect | Built and tested, **not deployed**. Branch `launch/countdown`, commit `a7e7625`, in the folder `/Users/mac/amigo-launch` on the owner's Mac. |
| Email codes (sign-up, password reset) | Were failing: the domain moved to AfeesHost DNS and lost Resend's records. Three records re-added 24 Nov (`resend._domainkey` TXT, `rsend` CNAME, `send` CNAME), confirmed live worldwide. Resend still needs **Verify**, then a real test. |
| Legal documents | Version **0.1 is live and unfinished**: 21 placeholders such as `[OWNER: support contact email]`, and the minimum age reads "drafted as 13" while sign-up requires 18+. Version 0.2 drafts are in `docs/legal-drafts/` and fix most of it but still have `[OWNER]` and `[LEGAL REVIEW]` items. |
| Reservations | About 67 people reserved usernames. The database keeps each name for its owner (they claim it by signing up with the same email). This stays as is. |

What the countdown build does once deployed:
- Until 19:00 UTC the public sees a countdown page ("Amigo World opens at 8 PM"). At 19:00 UTC the
  gate opens **by itself**, no redeploy needed, and open countdown pages reload into the app.
- `reserve.amigoworld.com.ng` redirects to `amigoworld.com.ng` (except its `/privacy` page).
- The opening time can be changed without code: Vercel → amigo-app → Settings → Environment
  Variables → `MAINTENANCE_OPENS_AT` = an ISO time such as `2026-11-24T20:00:00Z`, or `never` to stay
  closed. A new value only takes effect after a redeploy.

## Rules

1. Do the steps in order. Don't skip the checks.
2. Nothing under "Reset DNS Zone" or "Delete DNS Zone" in AfeesHost, ever. Don't touch the `A` record
   `216.150.1.1` (that's Vercel; the site goes down without it) or the existing SPF TXT record.
3. Don't run database migrations or change Neon settings. None are needed for launch.
4. If anything fails and you're not sure why, stop and roll back (last section) rather than improvise.

## Step 1 — Email codes (do first, takes ~10 min)

1. Owner opens **resend.com → Domains → amigoworld.com.ng** and clicks **Verify DNS Records**.
2. All three records (`resend._domainkey`, `rsend`, `send`) must show **Verified**. If one says
   Failed, wait 5 minutes and click Verify again. Don't change DNS while waiting.
3. Real test: owner opens `amigoworld.com.ng/_team` (enters the team key if asked), then the app,
   and uses **Forgot password** with their own email, or signs up with a second real email.
4. A code must arrive within a minute from **Amigo World <no-reply@amigoworld.com.ng>**. Check spam.
   The code works when entered in the app.
5. If no email arrives after Resend shows all Verified: in Resend → **Emails** (or **Logs**), look
   at the latest entry and its error. Report the error text. Fallback if it can't be fixed by
   19:00 UTC: Neon Console → project → branch `main` → Auth → Webhooks → turn the webhook **off**;
   Neon then sends codes itself from "Neon Auth <auth@mail.myneon.app>". Turn it back on once Resend works.

## Step 2 — Legal documents (must be live before 19:00 UTC)

Goal: publish **Terms 0.2 and Privacy 0.2 together** (the others can follow later). Publishing one
without the other contradicts the age rule.

Facts already decided by the owner (from `docs/legal-drafts/REVIEW-0.2.md`):
- Operator: **Muftau Idris**, an individual. Minimum age **18**, self-declared, no ID.
- Under-18 accounts: suspended, then deleted after about 14 days' notice.
- Reservations: held 180 days, renewable in the last 30 days, deleted 30 days after ending.

Ask the owner for anything still marked `[OWNER…]`: support email, privacy email, postal address
(if they want one), backup/log retention windows, audit-log retention. For each `[LEGAL REVIEW…]`
item, the owner decides whether to publish the draft wording now and have a lawyer check it after
launch. Write that decision down; don't hide the item silently.

Procedure (on the owner's Mac, in Terminal):

```sh
cd /Users/mac/amigo-launch
open docs/legal-drafts/terms-0.2.md docs/legal-drafts/privacy-0.2.md   # edit: fill every [OWNER…] / [LEGAL REVIEW…]
grep -n "\[OWNER\|\[LEGAL" docs/legal-drafts/terms-0.2.md docs/legal-drafts/privacy-0.2.md   # must print nothing
cp docs/legal-drafts/terms-0.2.md   src/legal/docs/terms-0.2.md
cp docs/legal-drafts/privacy-0.2.md src/legal/docs/privacy-0.2.md
```

Then in `src/legal/index.ts`, in `BUNDLED_VERSION`, change `terms: "0.1"` and `privacy: "0.1"` to
`"0.2"`. Build and commit:

```sh
npm run build                     # must end with "built in …" and no errors
git add src/legal docs/legal-drafts
git commit -m "Legal: publish Terms and Privacy 0.2 (operator, 18+, contacts)"
```

After deploying (Step 3), the owner signs in as admin → **Admin → Legal** → registers **Terms 0.2**
and **Privacy 0.2** as the current versions (material change, so every account is asked to accept).
Check `amigoworld.com.ng/legal/terms` and `/legal/privacy` (with team access) show 0.2 and no brackets.

## Step 3 — Deploy (countdown + legal together, before ~18:30 UTC)

```sh
cd /Users/mac/amigo-launch
git log --oneline -3                  # expect the legal commit, then a7e7625, then fab853c
npm run build && node scripts/test/maintenance.test.mjs   # must print ALL ACCESS GATE TESTS PASSED
git push origin launch/countdown      # backup copy of the branch
git push origin launch/countdown:main # this deploys Production (branch tracking)
```

Wait ~1 minute, then check (in a private browser window, no team access):
- `amigoworld.com.ng` shows the **countdown**, with the right hours left.
- `reserve.amigoworld.com.ng` redirects to `amigoworld.com.ng`.
- `amigoworld.com.ng/api/auth-email?check` shows `"ready":true`.
- In Vercel → amigo-app → Deployments, the newest Production deployment is **Ready** and its commit
  matches the one just pushed. Note the previous deployment's ID (rollback target, usually
  `dpl_9DG6YgLKMzHDzMaxjhV1rcor8puH`).

If `git push` to `main` is refused ("non-fast-forward"), stop: someone changed `main`. Don't force-push.

## Step 4 — Just before 8 PM

1. Neon Console → project `rough-lab-16727045` → branch `main` → **Create branch** named
   `pre-launch-20261124` (restore point; free, takes seconds).
2. Owner keeps the Vercel and Resend dashboards open.

## Step 5 — At and after 8 PM (19:00 UTC)

1. Private window: `amigoworld.com.ng` opens the app (no countdown).
2. Sign up with a **fresh real email** on a phone: code arrives, account works, 18+ consent shows,
   Terms/Privacy 0.2 appear, a text post and a photo post publish.
3. Someone who reserved a username signs up with the same email: they get that name.
4. Watch Vercel → amigo-app → Logs for errors for the first 30 minutes.

## Rollback

| Problem | Do this |
| --- | --- |
| Site broken after deploy | Vercel → amigo-app → Deployments → previous Production deployment → **Instant Rollback**. Seconds; no data lost. |
| Need to close the site again | Vercel → amigo-app → Environment Variables → `MAINTENANCE_OPENS_AT` = `never` → redeploy. (Or Instant Rollback to the pre-countdown deployment, which shows the plain "under development" page.) |
| Move the launch time | Same variable, new ISO UTC time, redeploy. |
| Codes stop sending | Step 1 fallback (turn the Neon Auth webhook off). |
| Reservation redirect unwanted | Vercel → amigo-reserve → Deployments → Instant Rollback to the previous one. |

## Known, accepted for launch

- Photo clean-up job not configured (deleted photos stay in storage; harmless).
- Admin → "Check a creator" shows an error (creator eligibility migration held on purpose).
- Acceptance of terms at sign-up is sometimes missed; the consent screen asks again on next open.
- Production Neon Auth still allows `localhost` and the old Preview URL as origins; tidy up after launch.
- GitHub repo is public: make it private (GitHub → Settings → Danger Zone) when convenient.
- Marketplace is switched on (owner's choice on 10 Nov).
