# Football predictions beta — implementation blueprint

*27 Oct 2026. Planning only: nothing here is built. Follows
[product-strategy.md](product-strategy.md) and
[football-predictions-feasibility.md](football-predictions-feasibility.md). Based on the code on
`claude/amigo-world-restart-7mrbrf`. Legend: **[exists]** today · **[new]** to build ·
**[decide]** needs the owner's approval.*

## 0. What already exists and is reused

| Piece | Where | Used for |
| --- | --- | --- |
| `worlds` with server-clock `starts_at` / `ends_at` / `cancelled_at`, `server_now()`, admin create/edit/cancel with fairness rules + audit | `20261006160000_worlds.sql`, `20261019120000_worlds_admin.sql`, `WorldEditor.tsx`, `AdminWorlds` | The match room. Every prediction question belongs to one World |
| `world_members`, `world_chat_messages` (members only, while live), `WorldChat`, `JoinButton`, `PeopleHere` | `WorldParts.tsx`, `WorldBits.tsx` | Discussing the match |
| `world_notices` (unique per recipient+World+kind) → `unread_notification_count()` badge → `world_push_targets()` → `/api/worlds-tick` → `sendPush` → `public/sw.js` (payload `{t:"world", k, s, n}`) | worlds_admin migration, `api/worlds-tick.ts`, `public/sw.js` | "Results are in" in-app and as push, no new pipeline |
| `is_admin()`, `support_require_admin()`, `admin_log()` → `admin_audit_log`; 1 admin today | `20261006170000_support_hub.sql` | Admin-only actions, audited |
| `is_suspended()` (AS001), `rate_limit_check()` pattern (RL001) | moderation and safety migrations | Suspended accounts can't pick; floods stopped |
| Client clock correction `serverNow()`, `useNow()`, `countdown()`, `statusLine()` | `src/features/worlds/time.ts` | Countdowns that match the server |
| Demo data source with Worlds; Playwright demo-mode test pattern; `database.test.sql` harness; CI (`ci.yml`) | `src/data/demoWorlds.ts`, `scripts/test/moment-viewer.test.mjs` | Offline UI tests and database tests |

**Not available:** a scheduler that runs more than once a day (Vercel Hobby). Today, time-based
work only happens when a signed-in app calls `/api/worlds-tick`.

## 1. MVP scope

**In:**
1. **One Daily Drop question per day** (Lagos date). It is attached to that day's football
   World: on matchdays the headline match; on other days a 24-hour "football question" World.
2. **A single question type:** pick one of 2–3 options (e.g. Home / Draw / Away). One pick per
   person; it can be changed until the lock.
3. **The lock** is enforced by the database clock at the question's `locks_at` (kick-off).
4. **Picks stay hidden until the lock.** Your own pick is always visible to you; after the lock,
   option counts are shown.
5. **The match World** reuses the existing room (join, chat, people).
6. **Settlement:** an admin settles with a mandatory source link. Correction within 48 h; void for
   abandoned or unplayable matches.
7. **Points:** 1 per correct pick, computed and never stored. A **weekly and an all-time beta
   table**.
8. **"Results are in"**, in-app plus push, through the existing World notices.
9. **Beta access by allowlist:** only listed accounts see and play (admins always).
10. **Internal checks before release:** an unpublished question is visible to admins only.

**Explicitly out:**
- private leagues;
- automated sports-data APIs;
- prizes of any value;
- scheduled reminders ("locks soon");
- exact-score or first-scorer questions;
- multiple questions per day;
- share cards and referral systems;
- user-created questions.

## 2. Database [new] — one additive migration

### Tables

```sql
prediction_beta_members (               -- who can see and play in the beta
  user_id uuid primary key references profiles on delete cascade,
  added_by uuid references profiles on delete set null,
  added_at timestamptz not null default now()
)

prediction_questions (
  id            uuid primary key default gen_random_uuid(),
  world_id      uuid not null unique references worlds on delete restrict,  -- one question per World
  drop_date     date not null unique,              -- the Daily Drop (Africa/Lagos date); one per day
  prompt        text not null check (char_length(btrim(prompt)) between 5 and 140),
  options       text[] not null check (array_length(options, 1) between 2 and 3
                                       and all option labels 1–40 chars),
  locks_at      timestamptz not null,              -- kick-off; picks refused from this instant
  points        smallint not null default 1 check (points between 1 and 5),
  published_at  timestamptz,                       -- null: admins only (internal checks)
  correct_option smallint check (correct_option between 0 and 2),
  result_source text check (result_source ~ '^https://'),
  result_note   text check (char_length(result_note) <= 280),
  settled_at    timestamptz, settled_by uuid references profiles,
  corrected_at  timestamptz,
  voided_at     timestamptz, void_reason text check (char_length(void_reason) between 3 and 280),
  created_by    uuid references profiles, created_at timestamptz default now(), updated_at timestamptz default now(),
  check (not (settled_at is not null and voided_at is not null)),
  check ((settled_at is null) = (correct_option is null) and (settled_at is null) = (result_source is null))
)

predictions (
  question_id  uuid not null references prediction_questions on delete cascade,
  user_id      uuid not null references profiles on delete cascade,
  option       smallint not null check (option between 0 and 2),
  change_count smallint not null default 0 check (change_count <= 10),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (question_id, user_id)                -- one pick per person per question
)
```

- **Access:** row security is on for all three tables, with **no insert/update/delete grants** to
  clients. `predictions` has a select policy for *own rows only*; questions are read through
  functions. The pattern is the same as `world_notices` and the backup tables.
- **Lock guard:** a trigger `predictions_lock_guard` (before insert or update on `predictions`)
  refuses if `now() >= locks_at`, or if the question is settled, void or unpublished. It is a second
  wall behind the function, so no future code path can write a late pick.
- **Notices:** `world_notices.kind` gains `'settled'` and `'voided'` (check constraint replaced).
  Recipients are the people who picked.

### Functions (all `security definer`, `search_path = ''`)

| Function | Who | Rules |
| --- | --- | --- |
| `prediction_today()` | beta member / admin | Today's (Lagos) published question with: World slug/title, options, `locks_at`, server `now`, your pick, `locked`, and **counts only if locked**, plus result/void state and your points. Admins also see unpublished. |
| `prediction_for_world(world_id)` | beta member / admin | Same shape, for the World page. |
| `submit_pick(question_id, option)` | beta member | Not suspended (AS001); published, not settled or void; `now() < locks_at` (**PR001** locked); option within the options (**PR002**); upsert on the primary key; same option again is a no-op (idempotent); a different option increments `change_count`, capped at 10 (**PR003**). Rate limit 30 calls/min (RL001). Returns the stored pick and the server time. |
| `prediction_table(p_period 'week' or 'all', p_limit)` | beta member / admin | Computed: over **settled** questions only (void excluded); points = Σ `points` where pick = `correct_option`. Week = Monday–Sunday, Africa/Lagos. Returns user, name, handle, avatar, points, correct, played, `rank()` (ties share a rank). Beta members only. |
| `admin_create_question(world_id, drop_date, prompt, options, locks_at, points)` | admin | World exists, not cancelled, not ended; `locks_at` in the future and ≤ World `ends_at`; one per World and per date. Audit `prediction.create`. |
| `admin_update_question(id, patch)` | admin | Before the first pick: anything. After the first pick, only `prompt` wording and moving `locks_at` (postponement, below), and only before the lock. Options are frozen once anyone has picked. Audit. |
| `admin_publish_question(id)` | admin | Sets `published_at`; members can now see and pick. Audit. |
| `admin_settle_question(id, option, source_url, note)` | admin | Only after `locks_at`; not void; not already settled; `https://` source required. Sets result fields; creates `'settled'` notices for pickers (`on conflict do nothing`). Audit with source. |
| `admin_correct_question(id, option, source_url, reason)` | admin | Only if settled, within 48 h of `settled_at`; option differs. Sets `corrected_at`; tables recompute automatically. No new push (the result view shows "Corrected"). Audit with old and new option and reason. |
| `admin_void_question(id, reason)` | admin | Any time before settlement, or within 48 h after it. Sets void fields; creates `'voided'` notices for pickers; scores nothing. Audit. |
| `admin_set_beta_member(user_id, member boolean)` | admin | Adds or removes beta access. Audit. |
| `admin_unsettled_questions()` | admin | Past their lock, neither settled nor void, oldest first (the admin's to-do list). |

New error codes: **PR001** locked · **PR002** invalid option · **PR003** too many changes ·
**PR004** not available (unpublished/not a beta member/void) · **PR005** admin rule refused (with
message).

## 3. Admin workflow

The workflow lives in the existing **Admin → Worlds** section, with one new panel per World and an
"Unsettled" list.

1. **The night before:**
   - create the World for tomorrow's headline match with the existing editor: room opens about
     60 min before kick-off and closes about 30 min after full time;
   - add the question: prompt, options, `locks_at` = kick-off from an **official** source (league or
     club site);
   - check how it looks (unpublished: only admins see it);
   - **Publish**.
2. **On days without a match:** a 24-hour World with a football question that resolves the same day
   or the next.
3. **After full time:**
   - open "Unsettled";
   - check the result on an official source (league or club site, or a major broadcaster);
   - paste the link, choose the option, settle.
   - **Target: within 3 hours of full time.**
4. **Mistake:** "Correct result" within 48 h, with a reason. Everyone sees "Corrected".
5. **Postponed before kick-off:**
   - new kick-off known and the room not yet open: edit the World times and the question's
     `locks_at`;
   - room already open, or new date unknown: **void** ("Postponed"), cancel the World (existing),
     and create a new World and question later.
   - Picks are never carried over to a different World.
6. **Abandoned or postponed after kick-off:** void ("Abandoned"). Rule: the result at full time on
   the day counts; later decisions (awarded matches, replays) don't re-score.
7. **Beta access:** add or remove members by handle.

Everything is in the audit log (`admin_audit_log`).

**[decide]** A second admin before the beta, so results don't depend on one person.

## 4. User experience [new]

- **Home: "Today's Drop" card**, between Moments and the composer. It shows only for beta members.
  It has five states:
  1. **Open:**
     - the prompt, 2–3 large option buttons and "Locks in 2 h 10 m" (server-corrected countdown);
     - your pick highlighted, with "You can change it until kick-off";
     - "Join the match room →".
  2. **Locked:** "Your pick: Arsenal", how everyone picked (bars), "Result after full time", and the
     room link.
  3. **Settled:** "You called it ✓ +1" / "Not this time", the result and source, and links to the table.
  4. **Void:** "No result: postponed" or "abandoned". No points.
  5. **No question today:** hidden, or a quiet "Next Drop tomorrow".
- **Picking:**
  - one tap stores the pick, and the button shows a spinner while saving;
  - repeat taps are ignored;
  - errors read "Picks closed at kick-off" or "Couldn't save — try again".
  - The UI never decides the lock; the server's answer does.
- **World page:** the same card as a panel at the top of the Live tab. Join, chat and people are
  unchanged. On a beta World, the existing like-based leaderboard tab is hidden (no entries).
- **Results view:** the settled card, plus a small "This week" list of your results.
- **Table:** a new screen `/worlds/table` (linked from the card and the Worlds screen).
  - It has a This week / All time switch.
  - Rows show rank, avatar, name, points and correct/played.
  - Your row is pinned.
  - Shared ranks are shown as ties.
- **Notifications:**
  - The Notifications screen shows "Results are in: Arsenal v Chelsea" and "No result:
    Arsenal v Chelsea was postponed".
  - `sw.js` shows the same text for push kinds `settled` and `voided`, and opens `/worlds/<slug>`.
- **Times:** shown in the device's time zone, like Worlds today. **[decide]** Always WAT instead.

## 5. Notifications without a cron

- **Creation:** `admin_settle_question` / `admin_void_question` insert the notices **in the same
  transaction**. The badge and Notifications screen show them immediately (the existing app pulse
  counts unread World notices).
- **Push:**
  - right after settling, the **admin's app calls `/api/worlds-tick`** (existing route, forced
    tick);
  - it pushes every fresh World notice once, through `world_push_targets()`;
  - any other signed-in app opening also triggers a tick, so pushes still go out if the admin's
    call fails.
  - Pushes only go to members who allow World notifications (existing setting), and only while the
    notice is under 1 hour old and unread (existing rule).
- **Code changes:** `/api/worlds-tick.ts` (widen the `kind` type) and `public/sw.js` (text for
  `settled`/`voided`). No new secret, route or scheduler.
- **No "locks soon" reminders in the beta.** They need a scheduler that runs on time. Revisit with
  GitHub Actions on a schedule, an external cron calling a server-secret route, or Vercel Pro.

## 6. Security and integrity

- **Authorization:**
  - clients have no table write grants;
  - every write goes through a function that checks `auth.uid()`, beta membership, suspension, and
    `is_admin()` for admin functions;
  - grants go to `authenticated` only (never `anon`/`anonymous`);
  - hiding the admin UI is cosmetic; the database decides.
- **Lock:**
  - checked with the database clock in `submit_pick` *and* the lock-guard trigger;
  - the phone's clock is only used to draw the countdown (corrected with `server_now()`).
- **Duplicates:**
  - the primary key `(question_id, user_id)` means one pick;
  - `submit_pick` is an upsert, and the same option again changes nothing;
  - the client blocks double taps;
  - changes are capped at 10 per question.
- **Rate limits:**
  - `submit_pick` is limited to 30 calls/minute per person (RL001);
  - admin functions are low-volume and audited.
- **Scores:**
  - never stored and never accepted from the client;
  - tables are computed from `predictions` and settled questions only;
  - a void question scores nothing;
  - results can only be set by an admin, after the lock, with a source.
- **Hidden picks:** no client can list others' picks. Counts are returned only once `now() >= locks_at`.
- **Audit:** every admin action is in `admin_audit_log` with source, reason, and old and new values.
  Each pick keeps `created_at`/`updated_at`/`change_count`.
- **Not money:** no prizes. The app copy says "Free to play — bragging rights only".

## 7. Tests

**Automated (all must pass in CI):**

- **`database.test.sql`** (new section):
  - non-admins can't create, publish, settle, correct, void or manage beta members;
  - non-members and unpublished questions are refused (PR004);
  - a suspended account can't pick (AS001);
  - one pick: a repeat is a no-op, a change increments, the 11th change is refused (PR003);
  - an invalid option is refused (PR002);
  - picking **after the lock** is refused through `submit_pick` **and** by the trigger, even when
    called directly as the table owner;
  - counts are hidden before the lock and shown after;
  - settle is refused before the lock, without an `https` source, or twice;
  - points are correct; ties share a rank; the week boundary uses Lagos time;
  - void excludes the question and creates notices once;
  - correct works within 48 h and is refused after, and the table recomputes;
  - postponement moves `locks_at` before the lock only;
  - options are frozen after the first pick;
  - an audit row exists for each admin action;
  - the rate limit fires;
  - grants: nothing callable by `anon`/`anonymous`, and the internal helpers aren't callable.
- **Demo-mode browser test** (Playwright, phone viewport, demo data, no network):
  - the Drop card cycles open → pick → change → locked (via demo clock) → settled → void;
  - double tap stores once;
  - the table renders ties and the pinned row;
  - the World panel shows the same state.
- **`sw.js` push text test** for `settled` and `voided` (small, like `sw-photo-cache.test.mjs`).
- **Existing suites unchanged and passing:** typecheck, build, offline tests, Moment viewer, database.

**On the isolated Neon branch** (`stage1b-verify` or a fresh one), with disposable accounts only:
- apply the migration after Stage 1/1b;
- run the database tests;
- a Data API smoke run: member picks; non-member refused; late pick refused by server time;
  admin settles; table and notices correct.

**Manual acceptance:** iPhone Safari (installed and in the browser), Android Chrome and desktop.
1. A beta member sees the Drop and picks; changing the pick works.
2. With the phone clock set 10 minutes slow, the pick is still refused at the real kick-off.
3. Join the room and chat.
4. The admin settles with a link; the push arrives with the app closed; the result card and table
   update.
5. Void flow and correction flow.
6. A non-member sees nothing.
7. Screen reader labels and countdown announcements, consistent with the Worlds countdowns.

## 8. Prerequisites (separate from this implementation)

1. **Security migrations Stage 1/1b**:
   - finish the **isolated Neon verification** (paused at `stage1b-verify`, schema not yet applied);
   - then roll out to Production with its own approval.
   - The prediction migration builds on that schema.
2. **A second admin** (an account the owner trusts; added by SQL by the owner).
3. **Legal:**
   - "free to play, no prizes" wording;
   - prediction-game terms;
   - a check of the Nigerian position on free prediction games and team names.
4. **Beta groups chosen** (2–3 friend groups, 20–40 people) and competitions agreed.
5. **[decide]** Hide Support Hub / Creator Programme for beta members.

## 9. Staged rollout

| Stage | What | Exit check |
| --- | --- | --- |
| **R0 Local** | Migration + database tests on a throwaway Postgres; data layer + demo source; UI with demo data; CI green | All automated tests pass in CI |
| **R1 Isolated Neon** | Apply on the isolated branch (after 1/1b); database tests; Data API smoke with disposable accounts | Results match R0; grants verified on Neon roles |
| **R2 Internal** | **[decide]** either (a) a Preview build pointed at the isolated branch (needs a Preview-only env override), or (b) the additive migration on Production with everything **unpublished** and only admins/2 internal testers on the allowlist | Owner + 2 testers run the manual acceptance list on real phones for at least 2 real matches |
| **R3 Production beta** | **Explicit approval.** Deploy the app; add the 20–40 beta members; publish one question a day for 3 weeks; admin settles daily | Go/no-go criteria in the feasibility doc |

Rollback:
- the app returns to the previous deployment;
- questions can be unpublished;
- the migration is additive (new tables, new functions, one widened check) and can stay in place.

Never restore by deleting data.

## 10. Effort (one developer, with the existing patterns)

| Work | Estimate |
| --- | --- |
| Migration + database tests | 2–3 days |
| Data layer (types, Neon calls, demo source) | 1–1.5 days |
| Admin panel (question, publish, settle, correct, void, unsettled list, beta members) | 2 days |
| Home card + World panel + results + table | 3–4 days |
| Notices, push text, Notifications screen | 0.5–1 day |
| Browser tests, accessibility, polish | 1.5–2 days |
| Isolated Neon verification + internal phone testing | 1–2 days |
| **Total** | **≈ 11–15 working days**, excluding prerequisites and approvals |

Beta operations:
- about 15–20 min/day of admin work (create, publish, settle) for 3 weeks;
- a weekly check of the metrics.

## 11. Decisions that need your approval

1. Every question belongs to a World, and **one Drop per day** (headline match on busy days).
2. Beta access by **allowlist** (recommended) vs every signed-in user.
3. Competitions: Premier League / Champions League / NPFL / mix.
4. Scoring: 1 point per correct pick, no bonus or exact score in the beta.
5. Table visibility: all beta members see the full table with names (recommended for the beta).
6. Times shown in the device's zone (as Worlds today) or always WAT.
7. Correction window of 48 h; void rules for postponed and abandoned matches as written.
8. Internal testing route R2(a) vs R2(b).
9. Who the second admin is.
10. App copy: "Free to play — bragging rights only", and the push wording.

## Recommended first implementation stage

**R0, part 1: the database migration and its tests**, on a throwaway local Postgres and in CI:
- the three tables, the lock guard, `submit_pick`, the table function and the admin functions;
- the `'settled'`/`'voided'` notice kinds;
- the full `database.test.sql` section from §7.

It is self-contained, needs no UI, and settles the integrity rules first.

**Dependencies:**
- the Stage 1/1b migrations exist in the repository (they do), so the new migration is written on
  top of them;
- decisions 1, 2, 4 and 7 affect the schema and should be confirmed first;
- nothing reaches Neon or Production in this stage.

## Checklist before Production

- [ ] Stage 1/1b security migrations verified on the isolated Neon branch and approved for Production
- [ ] Prediction migration passes the database tests locally, in CI and on the isolated Neon branch
- [ ] Grants checked on Neon: nothing for `anon`/`anonymous`; internal helpers not callable; no client table writes
- [ ] Late pick refused by server time (phone clock wrong on purpose) on a real phone
- [ ] Picks hidden before the lock; counts after
- [ ] Settle / correct / void each tested end to end, each with an audit row and a source link
- [ ] "Results are in" push received with the app closed on iPhone (installed) and Android
- [ ] Table correct after settle, correction and void; ties shown fairly
- [ ] Non-members see nothing; unpublished questions visible to admins only
- [ ] Second admin in place; settlement routine written down
- [ ] Legal wording ("free to play, no prizes") reviewed
- [ ] Rollback steps confirmed (previous deployment ID noted; unpublish works)
- [ ] Explicit owner approval for the production beta
