# Football predictions ("Daily Drop") — feasibility and validation plan

*27 Oct 2026. Analysis only: nothing here is built. Follows [product-strategy.md](product-strategy.md).
Based on the code on `claude/amigo-world-restart-7mrbrf` and read-only counts from the live database.
Legend: **[exists]** in the code today · **[proposed]** not built · **[open]** unresolved question.*

## Summary

The prediction experience fits the existing architecture with no new services. What carries over:
- **[exists]** Worlds already provides scheduled events with server-clock timing, admin-only creation
  with an audit log, membership, live chat, notices and Web Push.
- **[exists]** The leaderboard is computed by Postgres rather than stored, which is the right pattern
  for scores that must not be forgeable.

What is genuinely new:
- **[proposed]** Two tables (questions and picks), about six database functions, one admin screen
  section, a Home card and a panel on the World page.

The hard parts are not technical:
- **Fixtures and results data:** no free API covers the Nigerian league under terms clearly fit for
  a commercial app.
- **One person running everything:** a single admin exists today.
- **No scheduler:** reminders before lock time can't be guaranteed on the current free hosting.

For a small beta, **enter fixtures and results by hand, from public official sources.**

## 1. Architecture

### What can be reused

| Need | Existing piece | Where |
| --- | --- | --- |
| Signed-in identity in every database call | `auth.uid()` (Neon: `app_auth.uid()` via pg_session_jwt); RLS + `security definer` functions | `neon/prelude.sql`, every migration |
| Admin-only actions + audit | `app_admins`, `is_admin()`, `support_require_admin()`, `admin_log()` → `admin_audit_log` | `20261006170000_support_hub.sql` |
| Event with a start/end on the server clock | `worlds` (`starts_at`, `ends_at`, `cancelled_at`), `server_now()`; client clock correction `serverNow()` / `useNow()` / countdowns | `20261019120000_worlds_admin.sql`, `src/features/worlds/time.ts` |
| Joining, live room, chat | `world_members`, `world_chat_messages` (members only, only while live), `WorldChat`, `JoinButton`, `PeopleHere` | `WorldParts.tsx`, `WorldBits.tsx` |
| Admin create/edit/cancel of events with fairness rules | `admin_create_world` / `admin_update_world` / `admin_cancel_world`, `WorldEditor` | worlds_admin migration, `WorldEditor.tsx` |
| Leaderboard computed, not stored, frozen at the end, ties broken by time | `world_leaderboard()` pattern; `Leaderboard`, `WinnerCard` UI | `20261006160000_worlds.sql`, `WorldParts.tsx` |
| In-app notices + badge + push to opted-in members | `world_notices` (kinds `live`, `cancelled`), `unread_notification_count()`, `world_push_targets()`, `api/worlds-tick.ts`, `sendPush` | worlds_admin migration, `api/` |
| Flood protection | `rate_limit_check()` trigger pattern (RL001) | `20261017140000_safety_limits_and_stats.sql` |
| Offline UI development and tests | demo data source with Worlds; Playwright demo-mode test pattern | `src/data/demoWorlds.ts`, `scripts/test/moment-viewer.test.mjs` |

### What's missing

- **[proposed]** A *question* with fixed options, a lock time, an outcome and a status.
- **[proposed]** A *pick*: one per person per question.
- **[proposed]** A points table computed from settled questions.
- **[proposed]** Daily Drop notion: which question is "today's", using the Lagos date (WAT, UTC+1).
- **[proposed]** Two new notice kinds: "results are in", and optionally "locks soon".
- **[open]** **No dependable scheduler.**
  - Today, time-based work (`worlds_tick`) only runs when some signed-in app calls `/api/worlds-tick`.
  - Vercel Hobby cron runs **at most once a day**, at ±59 min precision.
  - Locking itself needs no scheduler: the server compares against `now()` on every write.
  - Only *reminders* before the lock would be unreliable. See Stage 4.

### How it fits (proposed)

```
worlds (existing) 1 ──── 0..n  prediction_questions (new; world_id optional)
                                   │ 1
                                   └── 0..n  predictions (new; one per user per question)
prediction_leaderboard(...)   computed from settled questions (no stored points)
world_notices.kind            + 'settled'  (+ 'locks_soon' later)
admin_audit_log               every create / edit / settle / void / correction
```

A match is a **World** (the live room) with **one question** attached ("Who wins?"). A Daily Drop
question can also stand alone, with no World, on days without matches. There is no separate app,
service, auth system or push system.

## 2. Prediction lifecycle (minimum)

| Step | Who | Rule (all enforced in Postgres) |
| --- | --- | --- |
| **Create** question | Admin | Title, 2–3 options (e.g. Home / Draw / Away), `locks_at` (= kick-off), optional `world_id`, `drop_date`, points (default 1, e.g. 3 for an upset bonus later). Audit-logged. |
| **Edit** | Admin | Wording and lock time only, and only before anyone has picked, or before the lock if only the lock time changes (postponement). Options are fixed once the first pick exists. |
| **Pick** | Signed-in user | `submit_pick(question, option)`: question `open` and `now() < locks_at`; one row per (question, user); changing your pick allowed until the lock. Suspended users refused (existing suspension check). |
| **Lock** | Nobody (time) | No action needed: after `locks_at` every insert/update is refused by the function *and* a trigger. Status reads as `locked` from the clock. |
| **Reveal** | Nobody (time) | Others' picks are hidden until the lock (avoids copying), then visible as counts and, for people you follow, names. |
| **Settle** | Admin | `admin_settle(question, correct_option, source_url)`: only after `locks_at`; source required (link to the official result). Audit-logged with who, when and source. |
| **Score / leaderboard** | Nobody | Computed: points = sum over *settled* questions where your pick = correct option. Weekly and season views. Ties: more correct picks, then earlier average pick time. Nothing stored, so nothing to tamper with. |
| **Correct a mistake** | Admin | `admin_resettle(question, option, reason)` within 48 h of settlement; audit-logged; scores recompute automatically. Shown publicly as "corrected". |
| **Postponed before kick-off** | Admin | Move `locks_at` (and the World's times) to the new kick-off; existing picks stand (nothing new is known). If the new date is unknown: **void**. |
| **Abandoned / postponed after kick-off** | Admin | **Void** (`admin_void(question, reason)`): no points for anyone; picks kept for the record. Rule shown in the app before people play. |
| **Match result later changed** (awarded, replayed) | Admin | The result *at full time on the day* counts; later decisions don't re-score. Stated up front. |

**[open]** Exact-score questions, first-scorer questions and multi-question drops are deferred. One
question type (pick one of 2–3 options) is enough to learn whether the loop works.

## 3. Fixtures and results

| Option | Covers | Cost / access | Terms (as far as verifiable) | Reliability | Fit for the beta |
| --- | --- | --- | --- | --- | --- |
| **Manual entry by an admin** from official/public sources (league and club sites, the NPFL's site, BBC Sport, Soccerway) | Anything | Admin time (~10–20 min/day) | Facts (who plays whom, when, final score) entered in our own words; no logos or copied pages. In the EU, fixture lists aren't protected by copyright or database right (CJEU C-604/10 *Football Dataco v Yahoo*, 2012); **Nigerian position not checked** | As good as the admin; needs a source link per result | **Recommended** |
| **football-data.org** free tier | ~12 top competitions (PL, CL, top European leagues, World Cup). **No Nigerian league** | Free: delayed data, about 10 calls/min | The provider's own blog says free use is **non-commercial**; a visible credit is required; commercial use by arrangement | Good for listed competitions | Not without the provider's written OK |
| **API-Football** (api-sports.io) | Very broad (~1,200 leagues); **NPFL coverage not confirmed** | Free plan reported at 100 requests/day; paid from about $15–19/month | Terms allow building apps; reselling data is barred; free-plan details and attribution to confirm with the vendor | Commercial vendor | Reasonable *later* option; verify NPFL via its `/leagues` endpoint first |
| Paid enterprise feeds (Sportmonks, Opta/Stats Perform, official league feeds) | Broad, official | Expensive, contracts | Licensed | High | Not before product-market fit |

**Recommendation:**
- Beta: manual entry.
  - Limit it to a short list of competitions: Premier League, Champions League and, if the beta group
    cares, a few NPFL matches.
  - That is roughly 2–5 questions a day, plus one Daily Drop question on days without matches.
  - Require a source link at settlement.
- Revisit APIs only after the go/no-go, and only with written confirmation of the terms.

**[open]** Get confirmation, not assumption, of: Nigerian rules on free-to-play prediction games; any
league/club data or trademark terms; and the use of team names (fine as facts; crests and logos are not).

## 4. Fairness and abuse prevention

- **One pick per person:** primary key `(question_id, user_id)`; picks only through
  `submit_pick()` (no client insert/update grants), as with every other write in the app.
- **No changes after the lock:** the function checks `now() < locks_at` with the **database clock**
  (the phone's clock is never trusted). A `before insert or update` trigger repeats the check, so
  even a future bug in another function can't write a late pick.
- **No score manipulation:**
  - points are never stored or sent by clients;
  - the leaderboard is computed from settled questions only;
  - a pick on a void question scores nothing;
  - only admins settle, and only after the lock.
- **Auditability:**
  - every admin action (create, edit, settle, resettle, void) goes to `admin_audit_log` with the
    source link and reason;
  - each pick keeps `created_at` / `updated_at`;
  - at the lock, picks become read-only and visible, so everyone can see the field;
  - settled questions show "settled by Amigo, source: …".
- **Single-admin risk:** with one admin, a wrong or biased result has no second check. Mitigations:
  - the source link is mandatory and shown to everyone;
  - the 48-hour correction window;
  - the admin plays in a separate non-admin account or not at all;
  - **[open]** add a second admin before the beta.
- **Multiple accounts:** someone could create several accounts and spread their picks.
  - At a friend-group scale this is low-value: there are no prizes and the table is among people who
    know each other.
  - Keep it that way: **no prizes of value**.
  - The existing sign-up rate limits and suspensions apply.
  - **[open]** If a public table ever matters, require a verified email/phone.
- **Floods:** the existing `rate_limit_check` pattern, extended to picks (e.g. 60/minute; picks are
  bounded by the number of questions anyway).
- **Herding / copying:** picks are hidden until the lock.

## 5. Smallest useful experiment

Test the *daily call that resolves*, before leagues, sports-data integrations or referral systems.

- **Who:** 20–40 people from 2–3 existing friend groups of football fans, invited through their
  WhatsApp group with the ordinary app link.
- **How long:** 3 weeks, in the club season.
- **What they get:**
  1. **Today's Drop** card on Home: 1 question every day, picked in seconds, with a countdown to the lock.
  2. On matchdays, the question sits inside that match's **World**, with the existing live chat. The
     room opens about an hour before kick-off and closes about 30 minutes after full time.
  3. **Results**: the card flips to "you called it / you didn't", with how the group picked. A
     "results are in" notice and push is triggered by the admin's settlement.
  4. **One beta table** (weekly + overall), visible to all beta users. It stands in for private
     leagues until we know people care.
- **Admin:** 1–2 people create the questions the night before and settle within about 2 hours of full
  time, from an official source.
- **Not in it:**
  - private leagues and share cards;
  - automated fixtures;
  - lock-soon reminders (people open the app because of the group, or not);
  - any prize;
  - any new onboarding beyond "join the beta Worlds".
- **Prerequisites:**
  - the Stage 1/1b security migrations are on Production (verification is in progress on an
    isolated Neon branch);
  - legal drafts are reviewed;
  - Support Hub and Creator Programme are hidden for beta users;
  - a second admin.

## 6. Implementation sequence

Each stage is small, testable on its own, and shippable behind the existing feature switches
(`dataSource.worlds` pattern). Nothing reaches Production without the usual approval.

| Stage | Database (migration) | API routes | UI | Tests | External config |
| --- | --- | --- | --- | --- | --- |
| **0. Prerequisites** | Stage 1/1b rollout (separate approval) | — | Hide Support Hub / Creator Programme for the beta (flag) | Existing suites | Second admin added (SQL, owner) |
| **1. Questions and picks in the database** | `prediction_questions`, `predictions`; `submit_pick`, `my_picks`, `question_results` (counts after lock), `prediction_leaderboard`; `admin_create_question`, `admin_update_question`, `admin_settle`, `admin_resettle`, `admin_void`; lock trigger; grants; rate limit | None (all through the Data API, like Worlds) | None | `database.test.sql`: one pick each; late pick refused (function *and* direct trigger); change before lock OK; only admins settle and only after the lock; void scores nothing; resettle recomputes; hidden picks before lock; audit rows written | Apply on the isolated Neon test branch first |
| **2. Admin tools** | — | — | Admin section "Calls": create from a World (prefilled kick-off), settle with source link, void, correct; list of unsettled questions past their lock | Demo-mode browser test of the admin flow; DB tests from stage 1 | — |
| **3. Player experience** | — | — | Home "Today's Drop" card; pick panel + countdown + reveal on the World page (reuse `time.ts`, `JoinButton`, `Leaderboard` patterns); results view; beta table page | Demo data source support; Playwright demo test (pick, lock, reveal, result, table) on a phone viewport | — |
| **4. Results notices** | `world_notices.kind` += `settled` (or a small `prediction_notices`), created by `admin_settle` | `/api/worlds-tick` pushes the new kind (existing path); `public/sw.js` wording | Notices list entry, opening the result | DB test (one notice per player, no duplicates); push payload test | — |
| **5. (After go) Lock-soon reminders** | `locks_soon` notices created when due | A secured scheduler route; **[open]** needs a scheduler: GitHub Actions on a schedule or an external cron calling a server-secret route (no user token), or Vercel Pro | — | Route and DB tests | Scheduler secret (new env var) |
| **6. (After go) Private leagues, share cards** | `leagues`, `league_members`, league tables | OG image route for result cards | League pages, invite links | DB + browser tests | — |

Stages 1–4 make up the experiment. Stages 5–6 wait for the go/no-go decision.

## 7. Go/no-go criteria (after the 3-week beta)

**Go:**
- **Habit:** ≥ 50% of invited people make at least one pick, and ≥ 40% of those pick on **≥ 4 of 7
  days** in week 3.
- **Return for the result:** ≥ 60% of pickers open the result within 24 h of settlement. Measured
  from a lightweight "seen result" timestamp; **[open]** add it in stage 3.
- **Live rooms:** on matchdays, ≥ 30% of beta users join the match World, with median ≥ 3 chat
  messages from those who join.
- **Pull for the next step:** at least 2 of 3 groups ask, unprompted, for "our own table" or bring
  people in themselves. That is the evidence that private leagues are worth building.
- **Operations:**
  - admin work ≤ 20 min/day;
  - every question settled within 3 h of full time;
  - **zero** late picks accepted;
  - no unresolved result disputes.

**No-go / rethink:**
- week-3 daily pickers < 25% of invited;
- *or* results rarely opened;
- *or* the admin load isn't sustainable by hand.

In that case, keep Worlds as occasional events and test a different reason to return, before
building anything listed in stages 5–6.

## Unresolved questions

1. Confirm the audience and competitions: who are the first 2–3 groups, and do they care about the
   Premier League, Champions League, NPFL or a mix?
2. Nigerian legal position on free prediction games with no prizes, and on team names in the app.
3. A second admin: who settles when the owner is unavailable?
4. A scheduler for reminders: GitHub Actions, an external cron, or Vercel Pro.
5. Shown times: always WAT, or the device's time zone? Worlds currently follow the device.
6. Whether beta users can see the whole beta table or only people they follow.

## Recommended smallest first experiment

**Three weeks, two or three friend groups, one free football question a day that resolves.**
- Answered on Home in seconds.
- Watched together in the match World on matchdays.
- Settled by hand from an official source.
- Ranked in one beta table.

To build:
- a two-table migration with lock and scoring rules in Postgres;
- an admin "Calls" section;
- a Daily Drop card and pick panel;
- a results notice through the existing push pipeline.

**Major risks:**
- **Empty room:** if the groups don't bring each other, no feature fixes it.
- **Admin burden and single-person trust:** one admin settling results by hand.
- **No scheduler:** reminders can't be guaranteed, so the habit must come from the people, not pushes.
- **Legal clarity:** free play with no prizes keeps this away from betting, but it needs confirming
  for Nigeria.
- **The beta table stands in for leagues:** it may understate the appeal of private leagues. Watch
  for groups asking for their own table.

## Sources (fixtures and hosting; checked 27 Oct 2026, via search; provider pages could not be fetched directly)

- football-data.org: [about](https://www.football-data.org/about), [blog (free = non-commercial)](https://www.football-data.org/blog), [third-party limits summary](https://www.thestatsapi.com/blog/football-data-org-free-tier-limits-2026)
- API-Football: [terms](https://www.api-football.com/terms), [getting started](https://www.api-football.com/news/post/how-to-get-started-with-api-football-the-complete-beginners-guide)
- Fixture-list rights: [CMS on the 2012 Court of Appeal outcome](https://cms.law/en/gbr/legal-updates/football-fixture-lists-has-the-final-whistle-been-blown-for-database-copyright), [SCL on CJEU C-604/10](https://www.scl.org/2379-judgment-in-football-fixture-copyright-case/)
- NPFL calendar: [Leadership (season Aug–May)](https://leadership.ng/npfl-clubs-converge-on-ibadan-for-agm-2026-27-fixtures-draw/), [Soccerway NPFL](https://gh.soccerway.com/nigeria/npfl/fixtures)
- Vercel cron limits: [usage and pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing)
