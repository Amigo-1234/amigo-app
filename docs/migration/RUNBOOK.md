# Cutover runbook: Firebase → Supabase

Firebase stays untouched and keeps serving production until the very last
step, and it stays available as the rollback path afterwards.

## Secrets: where each one lives

| Secret | Where | Used by |
| --- | --- | --- |
| `FIREBASE_SERVICE_ACCOUNT_BASE64` | cloud environment settings → environment variables (or a git-ignored `.env.local`) | extract, `firebase:rules` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | cloud environment settings | migrate / validate |
| `FIREBASE_WEB_API_KEY`, `LEGACY_SIGNIN_HASH_KEY`, `LEGACY_SIGNIN_ENABLED`, `ALLOWED_ORIGINS` | `supabase secrets set` | legacy-sign-in function |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` (public) | Vercel env vars (Preview, later Production) | the app |

Never in Git, docs, chat or Vercel: the service-account JSON and the Supabase secret key.
`migration-data/` and `secrets/` are git-ignored. Reports and logs mask emails.

The migration needs **HTTPS only**. It talks to Supabase through the Data API (service-role-only
`legacy_*` import functions), Auth admin and Storage, so no direct Postgres connection is required.

## 0. One-time setup

1. **Create the Supabase project** `amigo-world` (region `eu-west-2`, London: closest to the
   current users). On the Free plan, an account can have only 2 *active* projects across all
   its organisations.
2. **Auth settings:**
   - Site URL = the production domain.
   - Add the Vercel preview URLs to Redirect URLs.
   - Enable email confirmations.
   - Configure custom SMTP before launch (the built-in mailer is rate-limited).
3. Apply the schema:
   ```bash
   npx supabase link --project-ref <ref>
   npx supabase db push            # applies supabase/migrations
   ```
4. Check that `legacy` is **not** listed under Settings → API → Exposed schemas.
5. Deploy the Edge Function:
   ```bash
   npx supabase functions deploy legacy-sign-in
   npx supabase secrets set LEGACY_SIGNIN_ENABLED=true FIREBASE_WEB_API_KEY=… ALLOWED_ORIGINS=https://…
   ```
6. **Register the owner account** (SQL editor, as the service role — keep the address out of git):
   ```sql
   insert into admin_private.owner_accounts (email) values ('<owner email>');
   ```
   The owner's account becomes the Amigo admin and the Official Amigo account as soon as it exists
   with a confirmed email (now, or when it's created/imported/confirmed later). Check:
   `select user_id from public.app_admins;` and `select user_id, verification_type from public.profile_verifications;`
   — both must list only the owner.
7. Regenerate types from the real project and commit any diff:
   `npx supabase gen types typescript --project-id <ref> > src/data/supabase/database.types.ts`

## 1. Review RLS

- Run `supabase/tests/database.test.sql` (298 checks). It must end with `ALL DATABASE TESTS PASSED`.
  It rolls back, so it's safe on any database: use `psql` where a connection is possible,
  otherwise the SQL editor or the MCP SQL tool.
- Dashboard → Advisors → Security: no warnings expected.
- Read [DATABASE.md](../architecture/DATABASE.md#row-level-security-review).

## 2. Dry run (on a Supabase branch or a throwaway project)

```bash
npm run migrate:extract            # read-only; keeps the previous snapshot
npm run migrate:diff               # what changed in Firebase since the previous snapshot
npm run migrate:audit
npm run migrate:plan               # counts before anything is written
npm run migrate:run
npm run migrate:run                # second run must create nothing
```

## 3. Verify

- The report (`migration-data/report-*.md`) must show all checks PASS.
- Review the "Not migrated, by reason" table and accept or fix every line.
- Spot-check 5 posts in the Supabase table editor against the Firebase console.

## 4. Test with a real account

- Point a local build at the dry-run project (`.env.local`, `VITE_DATA_SOURCE=supabase`).
- Sign in **with an old Firebase password**. It should work on the first try (legacy-sign-in).
- Post with a photo, like, reply, follow, sign out and in, and reset a password.
- With a second account: follow, like, reply and @mention the first one, and check its
  notifications arrive **live** (Realtime can't be tested on the local stack).

## 5. Vercel preview

- In Vercel → Settings → Environment Variables, **Preview** scope only:
  `VITE_DATA_SOURCE=supabase`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`,
  `VITE_LEGACY_SIGNIN=true`.
- Production keeps no `VITE_DATA_SOURCE`, so it stays on Firebase.
- Open the preview on a phone and repeat step 4.

## 6. Production switch

1. Announce a short write freeze, or just accept that posts made during the next few minutes
   on the old app need the delta run.
2. Run `npm run migrate:extract`, then `npm run migrate:diff`, then `npm run migrate:run`. The run
   only adds what's new since the previous one.
3. Run `npm run migrate:validate`; all checks must PASS.
4. **Back up** the database. Pro plan: daily backups are automatic; trigger or confirm one in
   Database → Backups. Free plan: no automatic backups; run `npx supabase db dump` from a machine
   that can reach Postgres.
5. Set the same variables for the Vercel **Production** scope and redeploy.
6. Smoke test: sign in, post, like, reply.

## Rollback

- **Before step 6:** nothing to roll back; production never left Firebase.
- **After step 6:** remove `VITE_DATA_SOURCE` from Production and redeploy. The app is back on
  Firebase within a minute.
  - Content created on Supabase after the switch is **not** copied back. Keep the window
    short, or export it from Supabase first.
- The migration never deletes or edits Firebase data, so Firebase is exactly as it was.

## Afterwards

- Keep Firebase as a rollback source for at least 30 days. The email exposure is fixed by
  `npm run firebase:rules deploy` (see [AUDIT.md](AUDIT.md#security-findings)), which can run
  as soon as the Admin credentials exist.
- Turn off legacy sign-in when `password_migrated_at is null` stops shrinking (see [AUTH.md](AUTH.md)).
- Then remove `src/data/firebaseSource.ts`, `src/lib/firebase.ts` and the `firebase` dependency,
  and eventually `drop schema legacy cascade`.
