# Creator Programme eligibility — plan for review

Status: **applied to verify-1029 only** (3 Nov 2026), with the nine choices in section 2 accepted as
proposed. Not on Production. The full database suite passes on the local scratch Postgres (738 checks,
44 of them new), and the twelve function bodies on verify-1029 match the tested ones exactly.

## 1. Existing schema audit

| Area | What exists | Reused for |
|---|---|---|
| `monetization_settings` | `programme_open`, `applications_open`, `criteria` (empty jsonb), `public_note` | Applications stay gated by `applications_open`. `criteria` is **not** used for thresholds (see 2). |
| `creator_applications` | status `pending / info_requested / approved / rejected / withdrawn`, `snapshot` jsonb, review fields; one active application per person | Applying and admin review, unchanged. `snapshot` now also stores the eligibility result at apply time. |
| `creator_monetization_status` | `not_eligible / eligible / suspended / revoked` | "Approved" = `eligible`, set only by an admin decision. `suspended`/`revoked` count against standing. |
| `monetization_fraud_flags` | open/resolved flags by admins | An open flag counts against standing ("under review"). |
| `creator_engagement(uid)` | followers, verified followers, posts in 30 days, support received (confirmed **visits** from email-confirmed supporters), account age from `profiles.created_at`, open flags | Its definitions are followed (email-confirmed supporters, profile age), but supporters are now counted as **unique people**, not visits. |
| `creator_stats(uid)` | dashboard for approved creators | Unchanged. |
| Apply paths | `creator_apply` (current app), `apply_for_monetization` (original) | Both now require eligibility. |
| Approve paths | `admin_creator_application_decide` (current), `admin_creator_application_review` (original), `admin_monetization_status_set` (manual status) | All three refuse to make someone eligible who doesn't meet every requirement. |
| `post_views` (20261104090000) | one row per account per post, `viewed_at` | Views in the last 90 days. |
| `support_requests` / `support_visits` | `creator_id`; `confirmed_at` per person per request; self-support refused by `confirm_support` | Supporters. |
| `posts` | `parent_id` (replies), `repost_of_id`, `deleted_at` (also set by moderation takedowns), `visibility`, `business_id` (business posts have no personal author) | Posts and replies. |
| `app_auth.users.email_confirmed_at` | kept in sync with Neon Auth (checked: 14/14 users match on verify-1029) | Verified email. |
| `account_suspensions` / `is_suspended()` | active suspensions | Standing. |
| `account_warnings` | warnings with acknowledgement | **Not** part of standing (see 2). |

Support Credits (`support_ledger`, `support_settings`, `confirm_support` earning/spending): **not read or written** by anything new. A test fingerprints every ledger row before and after and requires them identical.

## 2. Eligibility calculation

`creator_eligibility(uid)` works everything out from the records on each call (no stored score a client could change):

| Requirement | Definition | Threshold |
|---|---|---:|
| Views | rows in `post_views` for the creator's own non-deleted posts **and replies**, with `viewed_at` in the last 90 days | 50,000 |
| Supporters | distinct people with `confirmed_at` set on the creator's own requests, excluding `rejected`/`removed` requests, excluding the creator, only supporters with a confirmed email | 20 |
| Posts | the creator's non-deleted top-level posts; followers-only posts count; plain reposts (no text) don't | 50 |
| Replies | the creator's non-deleted replies to **someone else's** post | 20 |
| Verified email | `email_confirmed_at` is set | required |
| Account age | whole days since `profiles.created_at` | 90 days |
| Good standing | no active suspension, no open fraud flag, creator status not `suspended`/`revoked` | required |

Result shape (also what the screens read):

```json
{ "eligible": false, "window_days": 90, "checked_at": "…",
  "requirements": [
    { "key": "views_90d", "value": 32000, "required": 50000, "met": false },
    { "key": "good_standing", "value": true, "required": true, "met": true, "reasons": [] } ] }
```

### Choices I made where the definition left room (please confirm or change)

1. **Views of replies count**, as well as views of top-level posts. They're genuine views of the creator's content.
2. **Supporters must have a confirmed email**, matching how `creator_engagement` already counts support.
3. **Support on rejected or removed requests doesn't count.**
4. **"Unpublished" posts**: the schema has no drafts, so this means deleted or taken down. Followers-only posts count as published.
5. **Plain reposts don't count as posts**; quote posts (with text) do.
6. **Replies to your own posts don't count**, to stop self-threads padding the number.
7. **Warnings don't affect standing.** Only suspensions, open fraud flags and a suspended/revoked creator status do. Admins still see warnings elsewhere.
8. **Thresholds are fixed in the migration**, not an admin setting, so changing them is always a reviewed change. `monetization_settings.criteria` stays unused.
9. **Eligibility gates applying and approving.** Someone not eligible can't apply, and an admin can't approve (or set "eligible" by hand) unless the creator meets every requirement at that moment. Rejecting and asking for more information are always allowed.

## 3. Migration, item by item

| Item | What and why | Permission |
|---|---|---|
| Index `post_views_post_time_idx (post_id, viewed_at)` | Counts a creator's 90-day views from the index alone. Small extra write per view. | — |
| `creator_eligibility_rules()` | The seven thresholds and the 90-day window, in one place. | No one (internal). |
| `creator_eligibility(uuid)` | The calculation above. Security definer, read-only. | No one (internal). |
| `my_creator_eligibility()` | Your own progress; takes no user id, so you can't ask about anyone else. | Signed-in users. |
| `admin_creator_eligibility(uuid)` | Anyone's progress. | Signed-in users, admins only (checked inside). |
| `creator_apply` (new version) | Refuses with `MN007` unless eligible; stores the eligibility result in `snapshot`. | Unchanged. |
| `creator_application_update` (new version) | Refreshes `snapshot` with current eligibility. | Unchanged. |
| `apply_for_monetization` (new version) | Same eligibility rule (`MN007`), so the original path can't bypass it. | Unchanged. |
| `admin_creator_application_decide` (new version) | Approving refuses with `MN008` unless eligible now. | Unchanged. |
| `admin_creator_application_review` (new version) | Same rule for the original review path. | Unchanged. |
| `admin_monetization_status_set` (new version) | Setting `eligible` by hand needs eligibility too. Suspending, revoking and resetting don't. | Unchanged. |
| `my_creator_programme` (new version) | Adds `eligibility` to what the creator screen loads. | Unchanged. |
| `admin_creator_applications_v2` (new version) | Adds `eligibility` inside the existing `current` column (same columns, so the app keeps working). | Unchanged. |

No new tables or columns, no table grants, no data changes. All new and changed functions keep `security definer` with an empty `search_path`, like the rest of the schema. Undo: drop the four new functions and the index, and restore the six functions from their original migrations.

## 4. Creator screen (Settings → Creator Programme)

A new **"Your progress"** card above the application form:

- One row per requirement: label, `value / required` (e.g. *Views (last 90 days) 32,000 / 50,000*), a progress bar for the counts, and a tick or a clear "not yet".
- Email: *Verified* / *Not verified* (with a link to verify). Age: *120 / 90 days*. Standing: *Good*, or the reason in plain words ("Your account is suspended", "Under review").
- An overall line: **"You meet every requirement — you can apply"**, or **"Still needed: 18,000 more views, 8 more supporters, 12 more posts"**.
- "Checked just now" with a refresh button. Figures come only from the server; nothing is estimated in the app.
- The Apply button is shown only when eligible (the server enforces this regardless). If an application is already open, the card still shows progress.

## 5. Admin (Admin → Creator Programme)

- Each application shows a compact **eligibility checklist** (current figures, from `current.eligibility`) next to what was recorded when they applied (`snapshot.eligibility`), so changes since applying are visible.
- **Approve** is disabled with the reason ("Doesn't meet: views, supporters") when not eligible; the server refuses anyway (`MN008`). Reject and "Ask for more information" stay available.
- A **"Check a creator"** box: enter a username and see their full eligibility (`admin_creator_eligibility`), useful before applications open.
- The existing status, fraud-flag and feedback tools stay as they are.

## 6. Security and tests

All calculation happens in the database from records the app can't write: `post_views`, `support_visits`, `posts`, auth and moderation tables have no direct client write path for these fields, and the eligibility functions take no figures from the caller. The new database tests (44) cover:

- each threshold on its own, a creator meeting all seven, and failing exactly one at a time;
- the rolling window (91 days out, 89 days in), and views of deleted posts;
- duplicate supporters across requests, unconfirmed visits, supporters without a verified email, removed requests, other creators' requests;
- deleted/taken-down posts, followers-only posts, plain reposts; self-replies and deleted replies;
- unverified email, 89 vs 90 days, suspension, open and resolved fraud flags;
- manipulation: calling the internal functions, reading someone else's progress, writing status/applications/views directly, both apply paths and all three approval paths when not eligible;
- Support Credits ledger unchanged.

App tests (to add with the screens): the progress card with real figures, the overall status and "still needed" text, Apply hidden when not eligible, the admin checklist and disabled Approve.

## 7. Order of work after approval

1. Apply the migration to **verify-1029 only** and refresh its Data API.
2. Build the creator card and admin checklist; test locally against verify-1029.
3. Report back. Nothing goes to Production, and the Creator Programme isn't published.
