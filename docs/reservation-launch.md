# Username reservations — launch checklist

Prepared 2 Nov 2026 from a read-only review. Nothing here has been applied to Production.

## Review findings

| Area | Status | Evidence |
|---|---|---|
| Database migration | Ready | 666/666 local database checks; on verify-1029, 48/48 reservation checks (rolled back) and all 23 functions identical to local. Production has no reservation objects yet. Its `handle_new_user` / `generate_username` match the repo apart from indentation, so replacing them drops nothing. No Production username is on the protected list (13 profiles, all valid). |
| Existing accounts | Protected | The check fires only when a username is created or changed. Existing usernames are never touched. |
| Sign-up and renaming | Reject reserved and protected names | Database trigger plus `username_available`. Tested locally, on verify-1029 and end to end (41 checks). |
| Admin controls | Ready | Open/close, hold length, names per email, revoke, extend, protect/unprotect and assign a name. Tested in the database and in the demo admin screen. |
| Email | Ready | Live `/api/auth-email?check`: sender matches, provider key present. Resend's signing record (DKIM) is published for amigoworld.com.ng. Sign-up emails already use this setup. |
| Reservation route | Ready, not yet run against real Neon | Tested locally through a stand-in for Neon's database connection. A test on a Preview deployment with verify-1029 credentials comes first (step B3). |
| Page | Ready | Works at phone width (no sideways scrolling at 320px). Loads no app code. Links to the Privacy Policy and Terms. |

### Pre-launch fixes
1. **Email retention: fixed** (`20261103100000_reservation_housekeeping.sql`). 30 days after a reservation closes, its row is deleted, email and all. The clean-up runs automatically now and then, and admins can run it on demand.
2. **Privacy Policy: draft below, waiting for your approval.** The reservation page itself now says the email is used only for the reservation and deleted 30 days after it ends.
3. **Bot check resend: fixed.** The check sits under both the email and code steps, every code request uses a fresh token, and it's reset after each use.
4. **Hold length copy: fixed.** The page shows the hold length set in Admin.
5. **Admin status: fixed.** A hold whose time has run out shows as expired straight away.

### Privacy Policy addition (draft, for approval)
Suggested as a new paragraph in section 1, "Information you give us", plus a line in section 7, "Retention". Changing the policy means publishing a new version (0.2), per the app's legal-documents process.

> **Username reservations.** If you reserve a username before Amigo World opens to the public, we collect the username and your email address. We use the email only to confirm the reservation is yours, to tell you about it, and to let you claim the username when you create an account with the same address. A reservation isn't an account and we don't use the email for marketing. To prevent abuse we keep short-lived, one-way fingerprints of the network address and email used, for up to two days.

> **Retention (reservations):** We delete a reservation, including its email address, 30 days after it ends — when it's claimed, expires, is withdrawn by Amigo, or was never confirmed.

## A. What you must do yourself

1. **Approve the release contents.** Deploying ships every change since the live version (d718521): the new navigation (c8a7243) plus all of Phase 2. They can't be shipped separately without extra work.
2. **Create a database login for the route (Production, Neon SQL editor).** Use a strong random password. Do *not* create it in the Neon Console's Roles page: roles made there get broad admin rights.
   ```sql
   create role reserve_web login password '<random 32+ characters>';
   grant username_reserver to reserve_web;
   ```
   (Only after the migration has created `username_reserver`.)
3. **Set Vercel Production environment variables** (all "Sensitive"):
   | Name | Value |
   |---|---|
   | `RESERVE_DATABASE_URL` | `postgresql://reserve_web:<password>@ep-dry-mode-zano9y8g.c-2.eu-west-2.aws.neon.tech/neondb?sslmode=require` (the direct host, not `-pooler`) |
   | `RESERVE_PEPPER` | 64 random hex characters (`openssl rand -hex 32`). Never change it while reservations are open, or rate limits reset. |
   | `RESEND_API_KEY`, `EMAIL_FROM` | Already set. Nothing to do. |
   | `EMAIL_REPLY_TO` | Optional. |
   | `TURNSTILE_SECRET`, `TURNSTILE_SITE_KEY` | Only if you choose the bot check (fix finding 3 first). |
4. **DNS at your DNS host (host-ww.net).** Add `reserve` as a **CNAME** to `160f47bcd5fe080c.vercel-dns-017.com.` (Vercel's first choice; `cname.vercel-dns.com.` also works). This only works after step B5 has added the domain to the project.
5. **Resend plan.** Each reservation sends 2 emails (code and confirmation), and resends add more. Check that your plan's daily and monthly limits cover launch traffic: the free plan is 100 a day.
6. **Approve the Privacy Policy wording** (finding 2).

## B. What I can run after your approval, in order

1. Fix findings 1, 3 and 4 locally, with tests. Commit.
2. Push the branch.
3. **Preview test on verify-1029:** set `RESERVE_DATABASE_URL` / `RESERVE_PEPPER` for Preview only (a login on verify-1029, made the same way as A2), deploy a Preview, and run the full journey through the real route at `/reserve`. Then remove the test rows.
4. **Production database:** a restore branch, then the migration, then refresh the data service (same settings), then confirm the settings are unchanged and fingerprint the functions. Reservations stay **closed**.
5. Add `reserve.amigoworld.com.ng` to the Vercel project (then A4 can be checked).
6. Deploy the approved commit to Production. Check that the feed and profile still load, that `/reserve` and `/api/reserve` answer, and that the reserve address serves only the page.
7. Smoke test with reservations still closed: the page says "not open". Then, with your OK, open them briefly, reserve a test name with your own email, revoke it, and leave them open or closed as you choose.

## Rollback
- **Page and route:** redeploy d718521 (the current live version). The database update can stay, since the old app doesn't use it.
- **Database:** close reservations in Admin (instant). To remove the update completely: drop the `profiles_username_guard` trigger and the new objects, and restore the two functions (steps at the top of the migration), or restore from the branch made in B4.
