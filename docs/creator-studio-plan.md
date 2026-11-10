# Creator Studio — implementation plan (for review; nothing built)

## What it is

One place where a creator sees how their content and community are doing, and where they stand
with the Creator Programme. Built only from records Amigo already keeps. No earnings, balances,
payouts or financial promises, and no list of who viewed anything.

## What exists today

| Piece | Where | Notes |
|---|---|---|
| Programme dashboard (approved creators only) | `creator_stats(uid)`, shown in Settings → Creator Monetization | posts, likes and replies received, followers, verified followers, 8-week trend, 10 recent posts. **No views.** |
| Eligibility progress | `my_creator_eligibility()` (20261105090000), "Your progress" card | the seven requirements, real figures |
| View totals per post | `post_view_totals(ids)` (20261104090000) | per post only; who viewed is never exposed |
| Support Hub | `support_requests`, `support_visits` | requests, opens, confirmed supports, feedback |
| Feedback to the Amigo team | `creator_feedback_submit`, admin inbox | private |

## Proposed screens (Settings → Creator Studio, also linked from your profile)

1. **Overview** — this period vs the last (7 / 28 / 90 days): views, likes, replies, new followers,
   confirmed supporters; one simple daily chart for views.
2. **Content** — your posts and replies, newest first or by views, each with views, likes and replies;
   tap through to the post. Deleted posts excluded.
3. **Audience** — followers over time, verified followers, unique supporters (count only).
4. **Support Hub** — your requests: opens, confirmed supports, feedback received, status.
5. **Creator Programme** — the eligibility card, application status and feedback (moved here from
   Settings → Creator Monetization, which keeps a link).

## Database (one migration, shown for approval before it runs)

- `creator_studio_overview(p_days int)` — your own totals for the period and the previous one, plus a
  daily views series. Signed-in user only; computes from `post_views`, `post_likes`, `posts`,
  `follows`, `support_visits`.
- `creator_studio_posts(p_sort text, p_limit int, p_before timestamptz)` — your posts with counts,
  paged; reuses `post_view_counts`.
- Both: `security definer`, read-only, take no user id (you can only ever see your own), bounded
  windows (max 90 days) and page sizes. Possibly an index on `post_likes (post_id, created_at)` and
  `follows (followee_id, created_at)` if the explain plans need them.
- Admins: `admin_creator_studio(p_user)` reusing the same functions, for reviewing applications.
- No tables, no data changes, Support Credits untouched.

## Decisions for you

1. **Who gets Studio?** Recommended: every signed-in person (it shows progress towards eligibility);
   approved creators see the same plus programme status. Alternative: approved creators only.
2. **Periods**: 7 / 28 / 90 days (90 matches the eligibility window)?
3. **Replace or keep** the current approved-creator dashboard in Settings → Creator Monetization?
   Recommended: replace it with a link to Studio, so the numbers live in one place.
4. **Charts**: one daily views chart to start (no charting library; plain SVG like the existing
   weekly bars), more later?

## Testing

- Database: figures against known activity, the period boundaries, deleted posts, only your own data,
  no viewer identities, page limits; Support Credits ledger unchanged.
- API: through PostgREST as real users (the local setup from the eligibility verification).
- App: the screens against verify-1029 locally, phone and desktop widths.

## Order

Approve the decisions → write the migration (shown before running) → apply to verify-1029 only →
build the screens → verify locally → report. Nothing to Production; Creator Programme stays unpublished.
