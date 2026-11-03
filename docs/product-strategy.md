# Amigo World — product strategy (pre-launch)

*27 Oct 2026. Analysis only: nothing here is built yet. Based on the code on
`claude/amigo-world-restart-7mrbrf` and aggregate counts from the live database.*

## 1. Honest starting point

**What exists is a general-purpose social network, built unusually well, with almost no users.**

Built and working today:

| Area | State | Where |
| --- | --- | --- |
| Feed, posts, replies, likes, bookmarks, edit/delete | Complete | `src/screens/HomeScreen.tsx`, `feed_posts()` |
| Profiles, follow / Follow Back, follower lists | Complete | `ProfileScreen`, `FollowListScreen` |
| Moments (24-hour stories, photo/text, views, reactions) | Complete | `src/features/moments/` |
| Direct messages, end-to-end encrypted (Matrix crypto), photos, reactions, edits | Complete, unusually strong | `src/data/supabase/e2e.ts`, `messages.ts` |
| Notifications, Web Push (messages, activity, Worlds) | Complete | `activity_push`, `web_push` migrations |
| Search / Explore, "Suggested for you" | Basic: suggestions rank by follower count | `suggested_profiles()` |
| **Worlds** (scheduled events) | **Substantial MVP** — see below | `src/features/worlds/`, `WorldScreen.tsx` |
| Interests (12 topics, chosen at sign-up) | Stored, **used for nothing** | `user_interests` |
| Support Hub (ask for / give support on outside links, credits, reputation) | Complete | `SUPPORT_HUB.md` |
| Creator Programme (applications, review, dashboard; no money) | Complete, closed | `creator_programme` |
| Moderation, reports, suspensions, admin console, audit log | Complete | `src/features/admin/` |

Worlds already has more than the brief assumes:
- scheduled start/end on the server's clock, with countdowns;
- join/leave, posting inside a World, and competition entries with an entry limit;
- a leaderboard computed from likes and replies, never from follower counts, which freezes at the end;
- "Amigo pick" bonus points, live chat, and "Meet people here";
- "a World you joined is live" push notices;
- admin create/edit/cancel with fairness rules, and reporting.

Missing from Worlds:
- recurring/series Worlds and per-World templates;
- outcomes that resolve after the event (predictions, results);
- winner records that persist after the event;
- invite links into a World, and any private or group scope.

**Daily Drop does not exist in any form. Communities/groups do not exist.** Friend discovery is a
follower-count leaderboard plus "Meet people here" inside a World.

**Usage:**
- 13 profiles, most of them test accounts.
- 16 top-level posts; none in the last 7 days.
- 1 World ever run, with 3 members and 2 chat messages.
- 3 people have saved interests.

There is no signal yet that anyone wants any of this. That is normal before launch, but it means
every recommendation below is a hypothesis to test, not a plan to scale.

## 2. Is the three-pillar concept strong?

**Partly. The pieces are good; the framing is too wide.**

- **Three loops at once is three cold-start problems.** A daily prompt, live events and a friendship
  graph each need people present at the same time to feel alive. With a few hundred users spread
  across football, music, memes, debates and trends, every room is empty. Empty rooms kill social
  products faster than missing features.
- **A generic daily prompt is not a reason to come back.** BeReal-style prompts faded once the novelty
  went; Wordle worked because it was a puzzle that resolved and was easy to compare with friends. A
  Daily Drop needs an *outcome* (you were right / wrong / ranked) and an *audience you care about*.
- **Worlds scored by likes become popularity contests.** In a small beta the winner is whoever brings
  the most friends, which feels unfair to everyone else.
- **The app already has feature parity with the giants, not difference.** Feed, stories, DMs,
  follows: people already have those, with their friends already on them. More of the same isn't a
  reason to switch.

**What is genuinely distinctive and already built:** scheduled, time-boxed, shared experiences (Worlds)
with fair scoring and live chat, plus private messaging good enough to trust. The difference
Amigo can credibly own is **"doing a live thing together with your own people, with a result at the
end"** — not another place to post.

## 3. Recommended direction

### Target audience (initial)

**Football fans aged 18–30 in Nigeria who already banter about matches in WhatsApp groups and on X.**

Why:
- **Natural cadence.** Matches are scheduled, recurring (weekends plus midweek) and emotional:
  exactly the shape of a World.
- **The behaviour already exists, served badly:**
  - WhatsApp groups are chaotic: no structure, no scores, no memory of who called it.
  - X is strangers and abuse.
  - Fantasy apps are solo and stats-heavy.
  - Betting apps are about money.
- **The market fits the product:** the domain is `.com.ng`, and football is the most widely shared
  live interest in that market.
- **Groups recruit groups.** One fan pulls in the friends they argue with, so recruitment arrives
  with density built in.

This is an inferred audience (from the domain and the interests list). Confirm it matches the
people you can actually reach in the first month. The *shape* matters more than the topic: one
recurring live interest, entered with friends.

### Unique value proposition

> **"Matchday with your people."** Call the result before kick-off, watch it together in a live
> room, and see who was right — in a table that only your friends are on.

What existing platforms don't deliver well:
- a structured, scored, *friendly* rivalry inside an existing friend group;
- live shared rooms tied to a real event, not an endless feed;
- outcomes that persist ("I've topped our table three weeks running");
- no money and no strangers by default.

### Core experience: how the three pillars connect

One loop, built around a fixture:

1. **Daily Drop = the daily call.** One short question every day, locking at a set time.
   - Matchdays: "Arsenal v Chelsea: who wins, and first scorer?"
   - Non-matchdays: one football question that resolves (e.g. "Will X start on Saturday?").
   - About 20 seconds to answer. It resolves within a day.
2. **World = the live room.** Every Daily Drop fixture has a World:
   - your friends' calls are shown;
   - live chat and quick reactions during the match;
   - at the end, the result settles everyone's calls.
3. **Friendship = your league.** A small private group of friends joined by invite link, with a
   season table built from Daily Drop results.
   - The recap card ("Tunde called it, 3–1") is shareable to WhatsApp and Status. That is the growth loop.
   - People you keep meeting in public match rooms become suggestions, replacing "most followers".

Posts, Moments and DMs stay as they are; they become supporting acts (talk about the match, message
your rival), not the reason to open the app.

### Worlds strategy: casual and competitive together

- **Every match World is casual first:** anyone joins, chats and reacts. Competition is *opt-in*
  through the Daily Drop call attached to it.
- **Rank by being right, not by likes.**
  - Points come from resolved predictions (correct result, correct score, a bonus for calling an
    upset), so a quiet person with good judgement can win.
  - Keep the existing like-and-reply leaderboard only for creative Worlds (best meme, best take),
    and run those rarely.
- **Rankings are scoped:** your league first, then a public weekly table for the curious. Winners
  get a recorded weekly/season title on their profile. The data model for this is already
  sketched in `WORLDS.md`.
- **Moderation:**
  - Leagues are small and invite-only, so their members police themselves.
  - Public match rooms use the existing rate limits, reports, admin chat removal and suspensions.
  - Before any public room opens, add a slow-mode switch and a basic word filter.
  - No prizes of value and no money, ever, in this phase. That keeps it clearly apart from betting,
    which matters legally and for trust in this market.

### MVP priorities

**Improve what exists:**
1. **Worlds:**
   - series and templates, so an admin can create a weekend of fixtures in minutes;
   - a match-room layout that puts the chat first on phones (pending task P3/P4);
   - an invite/share link that opens straight into the World.
2. **Onboarding:**
   - land in "join your friend's league" or "pick your club";
   - use the interests already collected;
   - skip the generic feed on first open.
3. **Suggestions:** rank by shared Worlds and leagues instead of follower count (`suggested_profiles()`).
4. **Push:** keep only meaningful ones: "your call locks in 30 min", "match room is live", "results
   are in". The "World is live" notice already exists.

**Genuinely new (small, but new):**
1. **Calls (predictions):**
   - a question with options, a lock time, an admin-entered outcome and points;
   - this is what the Daily Drop is built from;
   - roughly 2–3 tables, a few functions and one screen.
2. **Leagues:** a private group (name, members, invite code) whose table is computed from members'
   calls. This is the first and only "community" primitive needed.
3. **Recap cards:** a shareable result image and link with Open Graph tags, landing on a sign-up
   that joins the league.

Everything else waits.

### Retention: why open it daily, come back for matches, invite friends

- **Daily:** there's a call to make that your friends will see, and yesterday's call has a result.
  The pull is "did I beat Chidi?", not a streak counter.
- **Scheduled Worlds:** the match is happening anyway; the room is where your league is reacting and
  where your call plays out live.
- **Inviting:** a league with two people is boring, so the product's value grows with each friend
  you add. The recap card does the inviting for you.
- **Staying:** the season table is a running story among friends that resets each season, which
  is not a streak to protect.

### Launch strategy: private-beta experiment

- **Duration:** 4 weeks, during the club season.
- **Who:** 4–6 *existing* friend groups of 8–20 football fans each (about 50–100 people), recruited
  as whole groups through WhatsApp. Avoid recruiting individuals: a lone user has no league.
- **What runs:**
  - one Daily Drop every day;
  - a match World for every Premier League fixture plus a few Champions League and NPFL matches;
  - an admin team of 1–2 people creating fixtures and entering results. Do this by hand at first;
    automated fixtures can come later.
- **Week 4:** short interviews with 10 people (5 most active, 5 who dropped off) about what they
  would miss.
- **Prerequisites before inviting anyone:**
  - the Stage 1/1b security migrations are rolled out;
  - legal drafts are reviewed;
  - Support Hub and Creator Programme are hidden, to keep the app focused.
- **Kill or rethink if:**
  - by week 3, fewer than 25% of beta users make a call on 4 or more days a week; **or**
  - fewer than 30% of league members return for a second matchday.

### Success metrics

All of these can be computed from the database (participation tables), with no tracking SDK.

| Question | Metric | Target for the beta |
| --- | --- | --- |
| Is there a daily habit? | Share of beta users making the Daily Drop call on ≥4 of 7 days (weeks 3–4) | ≥ 40% |
| Do people come back? | Week-1 → week-4 cohort retention (made at least one call in the week) | ≥ 35% |
| Are Worlds alive? | Share of league members who join ≥1 match room per matchday weekend; median chat messages per active member per match | ≥ 50%; ≥ 3 |
| Do friendships form? | New follows/DMs between people who weren't connected and met in a match room | ≥ 1 per active user over 4 weeks |
| Does it spread on its own? | Invites accepted ÷ active users (k-factor); new leagues started by beta users | ≥ 0.3; ≥ 3 |
| Would they miss it? | "How would you feel if Amigo World went away?": share answering "very disappointed" | ≥ 30% |

Leading indicator to watch weekly: **calls made per active user per week**. If this stays flat, the
loop isn't working regardless of sign-ups.

## 4. Risks and trade-offs

- **Narrowing to football excludes others.**
  - Deliberate. The engine (Worlds, calls, leagues) is topic-neutral, so music and debates can be
    added once one vertical works.
  - Running several topics at once with no users spreads density thin.
- **Admin load:** someone has to create fixtures and enter results every day. Templates and series
  keep this to minutes; if it can't be done reliably by hand for 4 weeks, the loop won't work later
  either.
- **Betting proximity:** keep it strictly free, with no prizes of value, and say so in the app.
- **Legal and safety:**
  - live chat with young users needs the moderation listed above;
  - the legal drafts must be reviewed before any public launch.
- **Do not build yet:**
  - user-created Worlds;
  - open public communities or groups;
  - an algorithmic feed;
  - video;
  - more Moment features;
  - Creator Programme or monetization;
  - Support Hub growth;
  - a native app;
  - a live sports-data integration;
  - new interest verticals.
- **Hide for the beta (keep the code):** Support Hub and Creator Programme. They dilute the message
  and add moderation surface.
- **How to avoid spreading effort:** every proposed piece of work must improve one of: making a
  call, the live room, the league table, or the invite. If it doesn't, it waits until after the beta.

## 5. Strongest recommendation

**Validate "Matchday with your people" first:** a free daily football call that resolves, watched
together in a live World, ranked in a private league of friends.

**Why:**
- It turns the one distinctive thing already built — scheduled, fairly-scored Worlds — into a reason
  to return every day.
- It recruits through groups that already exist.
- It can be tested in four weeks with about 80 people and three small additions.

**Next three steps, in order:**

1. **Calls:** prediction questions with lock times, admin-entered results and points, plus a Daily
   Drop screen that shows today's call. Attach one call to a World.
2. **Leagues:** a private group with an invite link, and a table computed from members' calls,
   shown on the World and on Home.
3. **Recap and invite:** a shareable result card and link that opens straight into the league and
   World, plus "your call locks soon" / "results are in" pushes, using the existing push system.

Then recruit the first friend groups and run the 4-week beta before building anything else.
