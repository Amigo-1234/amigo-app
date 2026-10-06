# Cutover runbook: Firebase → Supabase

Firebase stays untouched and keeps serving production until the very last
step, and it stays available as the rollback path afterwards.

## 0. One-time setup

1. **Create the Supabase project** (organisation of your choice, region near your users,
   e.g. `eu-west-2`).
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
6. Regenerate types from the real project and commit any diff:
   `npx supabase gen types typescript --project-id <ref> > src/data/supabase/database.types.ts`

## 1. Review RLS

- `DATABASE_URL=… npm run db:test` must end with `ALL DATABASE TESTS PASSED`. It rolls back,
  so it's safe on any database.
- Dashboard → Advisors → Security: no warnings expected.
- Read [DATABASE.md](../architecture/DATABASE.md#row-level-security-review).

## 2. Dry run (on a Supabase branch or a throwaway project)

```bash
GOOGLE_APPLICATION_CREDENTIALS=secrets/firebase-service-account.json npm run migrate:extract   # read-only
npm run migrate:audit
npm run migrate:plan
DATABASE_URL=… SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npm run migrate:run
npm run migrate:run      # second run must create nothing
```

## 3. Verify

- The report (`migration-data/report-*.md`) must show all checks PASS.
- Review the "Not migrated, by reason" table and accept or fix every line.
- Spot-check 5 posts in the Supabase table editor against the Firebase console.

## 4. Test with a real account

- Point a local build at the dry-run project (`.env.local`, `VITE_DATA_SOURCE=supabase`).
- Sign in **with an old Firebase password**. It should work on the first try (legacy-sign-in).
- Post with a photo, like, reply, follow, sign out and in, and reset a password.

## 5. Vercel preview

- In Vercel → Settings → Environment Variables, **Preview** scope only:
  `VITE_DATA_SOURCE=supabase`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`,
  `VITE_LEGACY_SIGNIN=true`.
- Production keeps no `VITE_DATA_SOURCE`, so it stays on Firebase.
- Open the preview on a phone and repeat step 4.

## 6. Production switch

1. Announce a short write freeze, or just accept that posts made during the next few minutes
   on the old app need the delta run.
2. Run a fresh extract and `npm run migrate:run` against **production** Supabase. It only adds
   what's new since the dry run.
3. Run `npm run migrate:validate`; all checks must PASS.
4. Set the same variables for the Vercel **Production** scope and redeploy.
5. Smoke test: sign in, post, like, reply.

## Rollback

- **Before step 6:** nothing to roll back; production never left Firebase.
- **After step 6:** remove `VITE_DATA_SOURCE` from Production and redeploy. The app is back on
  Firebase within a minute.
  - Content created on Supabase after the switch is **not** copied back. Keep the window
    short, or export it from Supabase first.
- The migration never deletes or edits Firebase data, so Firebase is exactly as it was.

## Afterwards

- Keep Firebase read-only for at least 30 days, and apply the
  [proposed rules](firebase-rules-proposal.md) to stop the public email exposure.
- Turn off legacy sign-in when `password_migrated_at is null` stops shrinking (see [AUTH.md](AUTH.md)).
- Then remove `src/data/firebaseSource.ts`, `src/lib/firebase.ts` and the `firebase` dependency,
  and eventually `drop schema legacy cascade`.
