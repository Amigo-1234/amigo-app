# Username reservations — launch readiness

Last reviewed 2 Nov 2026 (read-only). Production has not been changed.

## 1. Release readiness

### What ships
Deploying `7061af6` to Production ships everything since the live version `d718521`:

| Commit | What users see | Risk |
|---|---|---|
| `c73180d` launch banner | Nothing. The images live in `marketing/` and aren't part of the site; they only make the repo bigger. | None |
| `c8a7243` navigation redesign | Phones: Home · Explore · Create · Market (shows **Worlds** while the Marketplace is off, as it is now) · Messages. Bell and profile picture move to the Home header. Desktop: a shorter sidebar plus a "More" menu. Explore gets a browse row. | Low to medium: everyone sees a new layout. |
| `7061af6` reservations | `/reserve` on the main domain (and reserve.amigoworld.com.ng once DNS exists); Admin → Reservations; username checks in Edit profile and onboarding use the new rule; a "claim" row in Edit profile. | Medium: changes the username rules for every account. |
| Migrations `20261103090000`, `20261103100000` | Nothing visible until reservations are opened. | Low: additive. Existing usernames are never touched. |

### Evidence
- 671/671 database checks pass locally. On verify-1029 the same 48 reservation checks plus the clean-up checks pass (rolled back), and all 25 functions are identical to the local versions.
- 41/41 end-to-end route checks pass locally. The real route was tested on a Preview against verify-1029 with real email sending. 35/35 Marketplace browser checks pass. Typecheck and build pass.
- Production's current username functions match the repo apart from indentation, and none of its 13 usernames is on the protected list.
- **The live feed is working** after the 2 Nov data-service refresh. The app's own performance log shows `feed_posts` and `posts` errors during the outage and only successful loads afterwards.

### Regressions and gaps found (none block the release on their own)
1. **Phones: your profile is one tap further away.** The profile picture is only in the Home header now. From other screens you go Home first, or use Settings.
2. **Claiming is manual.** A reservation holder who signs up gets a generated username first. They then claim the reserved one in Edit profile, after confirming their email. Sign-up and onboarding don't mention it yet.
3. **No reminder emails.** Holders aren't emailed before a reservation expires, or when an admin revokes or reassigns it. Renewal relies on them coming back in the last 30 days.
4. **Holders can't cancel or look up their reservation themselves.** An admin has to do it.
5. **This branch's Previews use the live database for the app** (pre-existing setup). Unreleased code there acts on real accounts. Only the reservation route was pointed at verify-1029.
6. **The functions run on Node, not Edge.** The route's `runtime: "edge"` setting is ignored on this project. It works the same, but cold starts are slightly slower.

### Security concerns
1. **Squatting.** Without the bot check, one person with many email addresses and IP addresses could reserve many names. The limits are 10 starts per IP per hour and 6 per email per day, and each name still needs a working inbox. **Recommendation: turn on Cloudflare Turnstile for launch** (free; needs keys from your Cloudflare account) and review the Admin list daily for the first week.
2. **Registration is still open.** Any name that isn't reserved or protected can still be taken by signing up normally. This is expected; closing registration is a separate decision.
3. **Legal documents.** The **live** Privacy Policy and Terms still contain owner placeholders, and the Terms say the minimum age is 13. Privacy 0.2 (section 3) fills in the contact and age; your full legal name is still needed. Terms 0.2 must ship with it. **This blocks opening reservations to the public**, though not the technical deploy.
4. **Origin check.** Calls from other websites are refused. Scripts that send no browser origin are allowed, and are held back only by the limits and email verification.

## 2. Decisions you need to make
1. Approve the release contents (navigation and reservations together).
2. Provide your full legal name, then approve Privacy 0.2 (section 3) and the matching Terms 0.2 (minimum age 18). Contact email and minimum age are decided.
2a. ~~Approve the 18+ enforcement plan~~ — approved 2 Nov; built locally (section 3a).
3. Turnstile on or off for launch.
4. Keep the defaults (180-day hold, renewable in the last 30 days, one name per email) or change them in Admin.
5. Whether to add expiry reminder emails before or after launch (gap 3).
6. Separately, later: whether registration stays open or becomes claim-only.

## 3. Privacy Policy 0.2 — complete draft (for approval — not published)

Final review copies, with the operator name filled in: `docs/legal-drafts/privacy-0.2.md` and `docs/legal-drafts/terms-0.2.md`. The text below is the working draft.

Decisions applied (2 Nov 2026):
- **Operator:** an individual. The full legal name stays a placeholder until you provide and approve it.
- **Privacy contact:** olamidesamson841@gmail.com.
- **Minimum age:** 18.
- **Reservations:** held 180 days, renewable in the final 30 days, deleted 30 days after closing.

Changes from 0.1:
- the operator, contact and age lines filled in;
- §1 gains username reservations;
- §2 adds push notifications and first-party diagnostics;
- §5 gets an accurate provider list (Resend, Cloudflare R2, push services), plus businesses and the Marketplace;
- §7 gains reservation retention;
- §9 sets 18 and says what happens to younger accounts.

Items marked **[LEGAL REVIEW]** are left for a lawyer.

---

### Privacy Policy

This policy explains what information Amigo World collects, why, who processes it, and the choices you have. Amigo is operated by **[OWNER: full legal name]**, an individual ("**we**"). You can contact us about privacy at **olamidesamson841@gmail.com**.

#### 1. Information you give us

- **Account:** email address, password (stored only as a secure hash by our authentication provider), display name, username, and your confirmation that you are 18 or older.
- **Profile:** bio, profile photo and anything else you add.
- **Content and activity:** posts, replies, likes, follows, Moments, World participation and chat, Support Hub requests, support and feedback, reports you make.
- **Business pages and listings** (if you create them): business name, description, logo, contact details you choose to show, opening hours, area, and products or services you list. These are public.
- **Direct messages:** see section 4 — we store them only in encrypted form.
- **Legal acceptance:** which versions of the Terms and Privacy Policy you accepted, and when.
- **Monetization applications** (if you choose to apply when that's available): your application and engagement figures at the time.
- **Username reservations.** Before Amigo World opens to everyone, you can reserve a username at reserve.amigoworld.com.ng without creating an account. We collect the username you choose and your email address. We send a one-time code to that address to confirm it's yours; we store only a scrambled (hashed) copy of the code, and it expires after 15 minutes. We use your email only to confirm and manage your reservation: to tell you it's confirmed, to let you renew it, and to let you claim the username when you create an Amigo account with the same email address and confirm it. A reservation is not an account, and we don't use the email for marketing or show it to other users. A reservation lasts 180 days. You can renew it with the same email address in its final 30 days. If it isn't renewed or claimed, it ends and the username becomes available again. We may withdraw a reservation that breaks our Terms or Community Guidelines — for example impersonation, or a name that belongs to someone else — or to settle a dispute. Some system and brand names can't be reserved.

#### 2. Information created as you use Amigo

- **Session:** a sign-in cookie set by our authentication provider so you stay signed in.
- **Devices for encrypted messaging:** each browser you use gets a messaging device with public keys, a name (e.g. "Safari on iPhone") and a last-active time, so you can see and remove your devices.
- **Push notifications** (if you turn them on): the push address your browser gives us, so we can send notifications through your browser's push service.
- **Diagnostics:** when the app hits an error or loads slowly, it sends us a short report (what failed, the page, timings and app version), linked to your account so we can limit how many reports one person sends. We use these only to find and fix problems.
- **Abuse prevention:** to limit repeated attempts (for example on the reservation page), we keep short-lived, one-way fingerprints of network addresses and email addresses, which can't be turned back into the original, and delete them within two days.
- **Technical logs:** our hosting and database providers keep standard request and error logs (such as IP address, time and request path) for security and reliability.
- **On your device:** we store your theme preference, unsent drafts and your encryption keys in your browser (see the [Cookie and Tracking Notice](/legal/cookies)).

We do **not** use advertising trackers, sell personal information, or use third-party analytics services.

#### 3. How we use information

- to provide Amigo: accounts, profiles, feeds, notifications, Worlds, Support Hub, business pages, the Marketplace, messaging and username reservations;
- to keep Amigo safe: preventing spam and abuse, reviewing reports, enforcing our rules (including the minimum age), keeping audit logs of admin actions;
- to verify your email and help you recover your account;
- to find and fix problems with the app;
- to comply with legal obligations.

**[LEGAL REVIEW: legal bases for processing under the Nigeria Data Protection Act 2023 (and GDPR/UK GDPR if relevant), e.g. contract, legitimate interests, consent.]**

#### 4. Encrypted direct messages

- Messages, photos and other message attachments are **end-to-end encrypted** on your device before they leave it, using the open-source Matrix encryption (Olm/Megolm). We store only ciphertext and cannot read it.
- We can see **metadata**: who is in a conversation, when messages were sent, read and delivered markers, and your devices' public keys.
- **Reports:** if you report a conversation, the messages you choose to include are decrypted on your device and sent to us as evidence. Our moderators see only what you shared.
- **Backup:** if you turn on message backup, your keys are uploaded **encrypted** with a recovery key that only you have. If you lose every device and your recovery key, we cannot recover your message history.
- New devices can only read messages after you approve them from another of your devices or restore with your recovery key.

#### 5. Who can see your information

- **Public by default:** your profile, followers and following lists, public posts, World participation, Support Hub requests, business pages and Marketplace listings.
- **Followers only:** posts and Moments you share with followers.
- **Admins:** a small team of administrators can review reports, moderate content and manage username reservations; their actions are logged. They cannot read encrypted messages.
- **Service providers** that process data for us: **Vercel Inc.** (hosting and server functions), **Neon** (database and authentication, hosted in AWS London, UK), **Resend** (sending emails such as verification codes and reservation emails), **Cloudflare** (storing photos and videos you upload, in Cloudflare R2; and, if enabled, the Turnstile check on the reservation page), and your browser's push service (for example Apple, Google or Mozilla) if you turn on notifications. **[OWNER: confirm data-processing agreements with each provider.]**
- We may disclose information if the law requires it or to protect people from serious harm.

#### 6. International transfers

Our providers may process data outside Nigeria (for example in the UK, EU or US). **[LEGAL REVIEW: transfer basis under the NDPA 2023.]**

#### 7. Retention

- We keep information while your account exists. When you delete your account, we delete or anonymise your personal information as described in the [Account Deletion and Data Retention Policy](/legal/deletion).
- **Username reservations:** we delete a reservation, including its email address, 30 days after it ends — when it's claimed, expires, is withdrawn, or was never confirmed. You can ask us to delete it sooner (see section 8).
- **Abuse-prevention fingerprints** are deleted within two days.

#### 8. Your rights and choices

- You can view and edit your profile, delete posts and Moments, remove messaging devices, and delete your account in the app.
- You may have rights to access, correct, delete, restrict or object to processing of your information, and to data portability. To exercise them — or for questions about a username reservation, including a dispute over a reserved name — contact **olamidesamson841@gmail.com**. You may also complain to the Nigeria Data Protection Commission or your local data-protection authority.

#### 9. Age

Amigo is only for people who are **18 or older**. We ask you to confirm your age when you create an account; we don't ask for identity documents. If we learn that an account belongs to someone under 18, we'll suspend it and delete it, after telling the account holder where we can. If you believe we've made a mistake, contact us at the address above.

#### 10. Changes

We'll tell you about material changes in the app and, where required, ask you to accept the new version.

---

## 3a. How 18+ is enforced (plan approved 2 Nov 2026)

**Today:**
- **Email sign-up:** a self-declared checkbox reading "I'm at least **13**…", from the constant `MIN_AGE = 13` in `src/screens/AuthScreen.tsx`.
- **Google sign-up:** no age statement at all; the consent screen after Google only asks for the Terms and Privacy Policy.
- **Reservation page:** no age statement.
- **Server side:** the database records which policy versions each account accepted, but checks no age, and the consent screen is enforced in the browser only.

**Built locally (uncommitted), 2 Nov:**
- **Email sign-up:** reads "I'm 18 or older and I agree to…", from the shared constant `MIN_AGE = 18` in `src/legal/index.ts`.
- **Google sign-up:** the note says Amigo is for people 18 or older and that you'll confirm your age on the next screen.
- **Consent screen:** whenever the Terms are among the documents to accept, a required "I'm 18 or older" box must be ticked before "I agree" works, with a note for under-18s pointing to sign out or delete.
- **Reservation page:** a required "I'm 18 or older" box. The route refuses any start without it (`error: "age"`), so the box can't be skipped by calling the route directly.
- **Tests:** typecheck and build pass; 42/42 end-to-end route checks, including the new age refusal; Marketplace browser tests pass.
- **Not yet checked on screen:** the consent-screen box and the Google note. The demo has no outstanding documents and no Google sign-in.
- **Still to do:** publish Terms and Privacy 0.2 as a material change (needs your legal name and Production approval), and add a 14-day deletion step to the admin suspension flow.

**Approved approach (minimal, no ID documents, nothing invasive):**
1. **Self-declaration at every way in.**
   - Change the sign-up checkbox to "I'm 18 or older…".
   - Add the same required confirmation to the consent screen, so Google sign-ups and existing accounts confirm too.
   - Add "I'm 18 or older" to the reservation page before a code is sent. A reservation can only be claimed by an account, and the account has to confirm as well.
2. **Record it on the server.** Publish Terms 0.2 (min age 18) and Privacy 0.2 as a **material change requiring acceptance**. Each acceptance is then stored with a timestamp, which is the age confirmation on record. No date of birth is stored.
3. **Handle reports.** A report that a user is under 18 goes to admins, who can suspend the account under the existing suspension tools. ID is never requested by default; if a case can't be settled otherwise, any further check needs your approval first.
4. **Later, optional (Phase 3).** Collect a private date of birth at sign-up, so someone who enters an under-18 birthday can't register. It's still self-declared, it stores more personal data, and it needs your approval.

**Known limit:** the consent screen runs in the browser. Someone deliberately calling the API directly could skip it. That's acceptable for a self-declaration system, but it isn't proof of age.

**Existing accounts** (13 on Production today; none has ever confirmed 18+, because the old wording said 13 and Google sign-ups confirmed nothing):
- When Terms and Privacy 0.2 are published as a material change, every existing user meets the consent screen on their next visit. They must confirm they're 18 or older to keep using Amigo.
- Anyone who can't confirm can sign out or delete their account from that screen; deletion already exists there.
- An account that says it's under 18, or is reported and confirmed as under 18, is suspended straight away. It's then deleted after a short notice period (14 days is suggested), following the Account Deletion Policy. During that period the holder can contact you if it's a mistake.
- Their username is released when the account is deleted. Their encrypted messages are removed with the account as usual.

**Other legal and technical concerns:**
1. **All six legal documents still have owner placeholders** (Terms, Privacy, Guidelines, Copyright, Deletion, Monetization). The Terms also still say "drafted as 13" and lack a support contact, governing law and dispute process. **Terms 0.2 must ship with Privacy 0.2**, or the two contradict each other on age.
2. **Section 3 legal bases and section 6 transfers** need a lawyer, for the NDPA 2023.
3. **Postal address:** the Terms ask for one "if required"; a lawyer should confirm whether it's needed.
4. **Publishing** means adding `privacy-0.2.md` and `terms-0.2.md` to the app, and registering both versions in the Production database. That's a Production change, which needs your approval at the time.

## 4. Real-email test (Preview and verify-1029 only) — PASSED 2 Nov 2026

The owner ran it in their own browser on the Preview of `7061af6` (deployment `dpl_4sXCK2wPQdukrmyqXJ682LpA5GsH`), with the route pointed at verify-1029 through a throwaway test login.

| Step | Result | Evidence |
|---|---|---|
| Request a code | Sent | Log 21:11:39 UTC `code-sent` (not a renewal); no `send-failed` |
| Receive the real email and type the code | Accepted | Log 21:12:05 UTC `verified`; `code_attempts = 0`; code hash cleared |
| Reservation | `@amigoisaboy22` **active**, created 21:11:39, verified 21:12:05, expires **2027-05-01 21:12:05 UTC** (180 days) | verify-1029 `username_reservations` |
| Confirmation email | Sent; the success page and the owner confirmed it | No `send-failed` after verifying |
| Privacy | Email stored lower-case; the attempt log has no plain emails or IPs (19 fingerprints only) | SQL check |

Note: the reservation was made with a Gmail address other than the privacy contact (it's 25 characters long; the address isn't recorded here). Only that exact address can claim `@amigoisaboy22`.

After recording: the test login `reserve_web_test` was dropped, reservations on verify-1029 were closed again, and the two Preview entries were reset to `removed-after-test`. The test reservation row is kept on verify-1029 as evidence.

## 4a. Permanent page — recommended set-up: a separate Vercel project
Putting the page on the existing `amigo-app` project would mean deploying the whole app release with it (new navigation, username-screen changes). To leave the main app untouched, the page and its route go in **their own small project**, `amigo-reserve`. It uses the same repository and builds only a `reserve/` folder:
- `reserve/index.html`, `reserve/fonts/`, `reserve/favicon.svg`: the page, including the 18+ box.
- `reserve/api/reserve.ts` and the email helpers: the route, unchanged apart from its location.
- `reserve/vercel.json`: every path except `/api/reserve`, fonts and the icon serves the page. Strict security headers, including a content policy that allows only this site and, if enabled, Cloudflare Turnstile.
- No main-app code, no sign-in, no `/neon` proxy and no other API on that domain.
- The main app's `/reserve` copy and its reserve-host rules are removed, so there's one source of truth. The main app links to reserve.amigoworld.com.ng when it next ships.

Until the main app's next release, Admin → Reservations isn't live. Opening, closing and reviewing reservations is done for you with the same database functions (each action shown first). The database rule protects reserved names in sign-up and renaming either way. The current app shows a generic error if someone tries a reserved name, instead of "isn't available".

## 5. Vercel clean-up (after the real-email test)
Branch-only Preview entries created for testing (none exist in Production):
- `RESERVE_DATABASE_URL`: placeholder `removed-after-test`
- `RESERVE_PEPPER`: placeholder `removed-after-test`
- `RESERVE_ORIGINS`: the branch Preview address (not secret)

To delete them:
1. Go to vercel.com → team **amigos-projects** → project **amigo-app** → **Settings** → **Environment Variables**.
2. Search for `RESERVE_`.
3. For each of the three entries whose **Environment** reads *Preview* with branch **claude/amigo-world-restart-7mrbrf**, open **⋯** and choose **Remove**.
4. Don't touch any entry marked *Production*, or the other branch entries (`RESEND_API_KEY`, `EMAIL_FROM`, the `VITE_*` ones).
5. Afterwards, searching `RESERVE_` should show nothing until you add the Production pair in step A3 below.

## 6. Production setup for reserve.amigoworld.com.ng (separate `amigo-reserve` project)

Everything below leaves the main app (`amigo-app`, amigoworld.com.ng) untouched: no deploy, no setting changes, registration unchanged. Reservations stay **closed** until you approve opening them.

**The standalone project lives in `reserve/`:**
- `public/` holds the only files served: the page (with the required 18+ box), fonts and icon.
- `api/` holds `reserve.ts`, the only route, which accepts browser calls only from https://reserve.amigoworld.com.ng and refuses a start without `adult: true`. It sits with its email templates.
- `vercel.json`: every unknown path shows the page; strict security headers with a content policy limited to this site and, if enabled, Cloudflare Turnstile.

**Tested locally on 2 Nov:**
- the route compiles in strict mode and passes 42/42 end-to-end checks;
- the page shows "Reservations aren't open right now" while closed, and its fonts load from the new paths;
- the main app still builds, and its `vercel.json` and sign-in emails are identical to the live versions.

## 7. Step-by-step Production sequence (each step shown to you and approved before it runs)

| # | Who | Action | Leaves alone |
|---|---|---|---|
| 1 | me | Commit (18+, standalone project, legal drafts as drafts only, checklist) and push the branch | Production |
| 2 | me | Create Vercel project **amigo-reserve**: same GitHub repo, Root Directory `reserve`, no framework, no build command | amigo-app |
| 3 | me | Production database: restore branch `pre-reservations-YYYYMMDD`, then migrations `20261103090000` and `20261103100000`, then refresh the data service with its settings unchanged. Reservations stay closed. | App code; registration stays open |
| 4 | **you** | Neon SQL Editor (project rough-lab-16727045, branch **main** = `br-shiny-night-za6izma0`, database neondb; confirm with `select current_setting('neon.endpoint_id', true)` → `ep-dry-mode-zano9y8g`): `create role reserve_web login password '<openssl rand -hex 32>'; grant username_reserver to reserve_web;` | — |
| 5 | **you** | In Vercel → **amigo-reserve** → Settings → Environment Variables, add as Sensitive, Production: `RESERVE_DATABASE_URL` (`postgresql://reserve_web:<password>@ep-dry-mode-zano9y8g.c-2.eu-west-2.aws.neon.tech/neondb?sslmode=require`), `RESERVE_PEPPER` (`openssl rand -hex 32`), `RESEND_API_KEY` (same key as amigo-app), `EMAIL_FROM` (`Amigo World <no-reply@amigoworld.com.ng>`) | amigo-app variables |
| 6 | me | Deploy amigo-reserve to Production from the pushed commit; check the page, `GET /api/reserve` → `open:false`, refusal of other origins, and the logs | amigo-app |
| 7 | me | Attach `reserve.amigoworld.com.ng` to **amigo-reserve** and read back the exact CNAME target Vercel gives | — |
| 8 | **you** | At host-ww.net: CNAME, name `reserve`, target = the value from step 7 | Other DNS records |
| 9 | me | Confirm the domain is verified and HTTPS works; final checks on https://reserve.amigoworld.com.ng | — |
| 10 | **you** | Approve opening; then I run `admin_set_reservation_settings(true, 180, 1)` | — |

**Progress (2 Nov 2026):**
- **Steps 1–3 done:** commit `d1fc97e` pushed; project `prj_AnrX2TjttlmpgFkpZEiAuy1PTFK5` created; restore branch `br-divine-haze-zajjqy91` taken, both migrations applied and matching verify-1029, all 13 usernames unchanged, data service refreshed with identical settings.
- **Steps 4–5 done by the owner:** `reserve_web` is on Neon branch `main`. It can log in and has no superuser, create-role, create-database, replication or row-level-security bypass rights. Its only membership is `username_reserver`, and its only functions are `reserve_check`, `reserve_start` and `reserve_verify`. Its only schema access is `public`, where it can read or write no tables. Neon's two built-in, readable-by-everyone statistics views sit in `admin_private`, which it can't reach. The four Sensitive Production variables are on amigo-reserve.
- **Steps 7–8 done by the owner, earlier than planned:** `reserve.amigoworld.com.ng` is attached to amigo-reserve and verified, and the host-ww.net CNAME points to `23634c8ab192550d.vercel-dns-016.com`. Vercel reports it correctly configured. amigo-app's domains are unchanged.
- **Reservations:** still closed, with 0 reservations.
- **Step 6 done (2 Nov, 22:48 UTC):** Production deployment `dpl_G9GfQgri96A9k9Ywp3oNcbTuiJRK` of commit `d1fc97e`, serving https://reserve.amigoworld.com.ng. Checks:
  - `GET /api/reserve` → `{"open":false,"holdDays":180}`, which proves the `reserve_web` password, the pepper and the database link work.
  - The page loads with its 18+ box, fonts and icon.
  - Starting a reservation → 403 "closed"; without the 18+ confirmation → 400 "age"; a protected name → `not_allowed`; another site's origin → 403.
  - Main-app routes (`/api/neon`, `/neon/auth/…`, `/api/media`, `/api/auth-email`) → 404; `/api/reserve.ts` only redirects to the route, so no source code is served.
  - Security headers are present: content policy, frame blocking (DENY), HTTPS-only (HSTS), nosniff, referrer and permissions policies.
  - Database after the checks: still closed, 0 reservations, 4 attempt-log fingerprints with no plain data, and all 13 usernames unchanged.
  - amigoworld.com.ng → 200.
  - Minor, cosmetic: unknown paths show Vercel's plain 404 instead of the page; the rule meant to show the page there isn't taking effect.
- **Prepared, not deployed (3 Nov):** `reserve/public/privacy.html`, the reservation Privacy Notice v1.0. It's built from the Privacy 0.2 draft: operator Muftau Idris, contact olamidesamson841@gmail.com, 18+, 180 days, renewal in the final 30 days, deletion 30 days after a reservation ends, abuse-prevention fingerprints kept for at most 2 days, the processors, and your rights. The page's footer now links to `/privacy` ("Privacy Notice & reservation rules") instead of the main app's 0.1 policy and Terms. The rule for unknown paths now points to `/` so they show the page. Shipping both needs an amigo-reserve deploy, with your approval. **Wording approved by the owner on 3 Nov 2026.**
- **Notice live (3 Nov 2026):** commit `1184e41`, Production deployment `dpl_Gr7TL5orBUzrdUt6QsPEhrdStR5x`.
  - `/privacy` shows the notice (`/privacy.html` redirects there), and the main page's footer links to it.
  - Unknown paths now show the reservation page. Main-app routes either return 404 or just show that page; the app itself is never served.
  - `GET /api/reserve` → `open:false`; another site's origin → 403; a start → 403 "closed".
  - Database: closed, 0 reservations, usernames unchanged. amigoworld.com.ng → 200.
  - Rollback target if needed: `dpl_G9GfQgri96A9k9Ywp3oNcbTuiJRK`.
- **Turnstile on (3 Nov 2026):** the owner created a Managed widget for `reserve.amigoworld.com.ng` and added `TURNSTILE_SECRET` and `TURNSTILE_SITE_KEY` (Production only). Redeploy `dpl_eAVsKSAk7JrT9ZqFvb5CoTAbUMMa`, same commit `1184e41`.
  - **Outage:** a Vercel account-level billing block ("402 DEPLOYMENT_DISABLED") took both projects offline until about 07:20 UTC. The owner fixed it in Vercel; no deploys or code were involved.
  - **Checks afterwards:** the route returns a live Cloudflare site key (`0x…`, not a test key). The content policy allows `challenges.cloudflare.com` for scripts and frames. Code requests with no token or an invalid token → 400 "challenge", stopped before any database or email work. Name checks still work. Another site's origin → 403. Database: closed, 0 reservations, no start attempts logged, usernames unchanged.
  - **Still unproven:** whether the secret matches the site key. An invalid token is refused either way; the first real reservation will prove it (or fail with "challenge" if they don't match).

**Viewing reservations (usernames, emails, expiry):** Admin → Reservations is part of the main app update (`7061af6`). It goes live when you approve deploying the main app; that's a separate decision, not needed for the reservation page. Until then I can show you the same list, read-only, from the database whenever you ask. The emails are visible only to you and never written to the audit log.

**RESERVATIONS OPEN — 3 Nov 2026, 07:22:31 UTC** (owner's approval): Production `reservation_settings` set to open, 180 days, 1 per email, with an audit-log entry. The live route reports `open:true`; a request without a Turnstile token is still refused; 0 reservations at opening; usernames unchanged; amigoworld.com.ng → 200. To close: set `open = false` (instant).

**Admin → Reservations live (3 Nov 2026):** branch `release/admin-reservations`, commit `43a0b3d`. It's the live d718521 plus only the 11 app files from 7061af6: no navigation or 18+ changes, and no database, `vercel.json`, API or package changes. amigo-app Production deployment `dpl_J6MhGxzgxfMnhDrP3u9eeYTP7agt` serves amigoworld.com.ng.
- **Checks:** the site, `/admin/reservations` and the sign-in service → 200; the admin bundle contains the Reservations section; the new navigation is absent; the reserve site is unaffected (`open:true`, Turnstile on); 0 reservations; usernames unchanged.
- **Only admin:** `@amigoisaboy` (the owner account).
- **Rollback:** promote `dpl_5GWRjt6aS7MAQp3fZvQY4wXocNM9` (d718521).

## 8. Rollback
- **Reservation page problem:** close reservations (instant), or redeploy the previous amigo-reserve deployment, or remove the domain from amigo-reserve. The main app is unaffected throughout.
- **Main app:** not deployed in this sequence, so there is nothing to roll back there.
- **Reservations misbehaving:** Admin → Reservations → **Close** takes effect immediately and needs no deploy.
- **Database:** restore from the B1 restore branch, or reverse just these changes. Reversing means dropping the trigger `profiles_username_guard` and the new tables and functions, then restoring `generate_username` and `handle_new_user` from `20261006120000_core_schema.sql`. Any reservations made before the rollback are lost either way.
- **Credentials:** `drop role reserve_web;` and remove the two Vercel variables.
