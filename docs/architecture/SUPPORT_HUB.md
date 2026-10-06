# Support Hub + admin (MVP)

Support Hub is where people ask for genuine help or feedback on something outside Amigo — a song,
video, app, business, design or social page — and help others in return. It is not a post feed.

## How it works

1. **Ask** (`/support/new`): title, short description, link (http/https only, normalised), category,
   what kind of support, and a supporter goal. The review step shows the credit cost and your
   balance before you confirm. With moderation on, requests wait for an admin before going public.
2. **Support** (`/support/:id`): tapping Support opens the link in a new tab and records that you
   opened it. When you come back you confirm you checked it out — not sooner than a few seconds
   after opening. Nothing external is required or verified: no follows, subscriptions, streams or likes.
3. **Feedback** (optional): a quick reaction and/or a short note. Only the creator (and admins) see it.
4. A request **completes** when it reaches its supporter goal.

Rules: one support per person per request; never your own request; feedback once.

## Credits and reputation

| | Credits | Reputation |
| --- | --- | --- |
| What | Spendable | Permanent, can't be spent or reduced |
| Starter | 5 (enough for a first request) | 0 |
| Support someone | +1 | +2 |
| Written feedback (10+ characters) | +1 | +1 |
| Create a request | −5 | — |
| Request rejected by an admin | refunded | — |

All values live in one settings row (`support_settings`; demo: `DEFAULT_SUPPORT_CONFIG` in
`src/data/supportRules.ts`). Balances are sums of an append-only ledger, so every change is
explainable. No real money; later paid boosts/campaigns/plans would add ledger reasons and a
placements table rather than change this model.

## Discovery

Sections: **For you**, **Needs support**, **New**, **Completed**, **Yours**, with category chips and
text search.

"For you" never uses follower counts. Score = Amigo featured (+3) + freshness (2 × e^(−age/48h)) +
remaining need (2 × share of goal still open) + you've supported this category before (+1) + you
haven't opened it yet (+1) + creator's earned reputation (up to +1, log-scaled) + a small daily
per-viewer rotation. Your own requests, ones you already supported, and non-open ones are excluded.
"Needs support" orders by supporters still needed, oldest first.

## Admin (`/admin`)

Navigation: Overview · Support Hub · Worlds · Users · Reports. Support Hub is fully built; Users has
verification (below); Worlds lists Worlds read-only (created with SQL); Reports says plainly what
isn't built yet.

### Verification (Admin → Users)

Admins can verify someone (type: notable person, creator, business, organization, Amigo team, plus a
private note), change the type, or remove it. The badge shows beside the name on posts, replies,
profiles, people lists/search, Support Hub, World leaderboards/winner and chat. Nobody can verify
themselves, and there's no application flow yet.

Supabase: migration `20261006180000_profile_verification.sql` adds `profile_verifications`
(one row per verified person). It's a separate table so the existing profile-editing policy and
column grants can never reach it. Clients can read only `user_id`, `verification_type` and
`verified_at` (column grants — the note is never readable); there are no client write grants or
policies. Writes go through `admin_verify_user` / `admin_unverify_user`, which require
`is_admin()` and write to `admin_audit_log`. Every person embed in the app's queries includes the
verification so the badge appears everywhere.

Support Hub admin: requests by status (approve / reject with refund / remove / close / reopen /
feature / unfeature), a supporter inspector (time from opening to confirming), reports, suspicious
activity (confirmations under 20 s, 5+ supports in 10 minutes — from real timestamps), manual credit
adjustments with a required reason, and an audit log. The Overview shows only real counts that need
attention plus recent admin actions.

**Authorisation is backend-side.** Hiding `/admin` is cosmetic; in Supabase every admin function
calls `support_require_admin()` (`is_admin()` → `app_admins`) and the request/ledger/visit select
policies include `is_admin()`. Admins are granted with SQL as the service role:

```sql
insert into public.app_admins (user_id, note) values ('<profile id>', 'founder');
```

In the demo, the signed-in viewer is an admin so the area can be reviewed; open the app with
`?demo=member` to be a regular member.

## Supabase — migration `20261006170000_support_hub.sql`

Additive (no existing objects change): `app_admins`, `admin_audit_log`, `support_settings`,
`support_requests`, `support_visits`, `support_reports`, `support_ledger`, plus functions.

- Clients have **no write grants** on these tables. Every write is a `SECURITY DEFINER` function
  (`create_support_request`, `open_support`, `confirm_support`, `leave_support_feedback`,
  `report_support_request`, and `admin_*`) that checks `auth.uid()` and the rules. Errors use
  `SP001`–`SP008` (mapped to `SupportError`).
- Reads: open/completed requests are public; pending/closed/rejected/removed only for their creator
  and admins. Visits and ledger rows only for their owner (and admins). Reports and the audit log:
  admin functions only. Feedback: `support_feedback()` returns rows only to the creator or an admin.
- `support_discover()` is `SECURITY INVOKER`, so RLS decides what each viewer can see.
- Each reward can be earned once (partial unique indexes on the ledger); spending is serialised per
  person with an advisory lock; reputation entries can't be negative.
- Realtime: `support_requests` added to the publication.

## Testing

- Demo hooks: `__amigoDemo.support.support(person, requestId)`, `.backdateVisit(...)`, `.wallet(person)`.
- `supabase/tests/database.test.sql` and `scripts/test/supabase-api.test.mjs` cover the rules,
  privacy and admin enforcement on local Postgres + PostgREST. Nothing is deployed anywhere real.
