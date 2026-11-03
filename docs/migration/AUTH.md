# Auth migration: Firebase Auth → Supabase Auth

## Can passwords be copied?

**No.** Firebase hashes passwords with a modified scrypt (with a project signer key).
Supabase Auth can only import **bcrypt** and **Argon2** hashes
([Supabase docs](https://supabase.com/docs/guides/platform/migrating-to-supabase/auth0)).
There is no safe way to convert one into the other, and we never want plaintext passwords.

## Strategy: same accounts, password re-verified on first sign-in

1. **Export.** The admin extractor (`--source admin`) lists every Firebase Auth user: uid, email,
   verified flag, disabled flag and dates. **Password hashes are not exported** (not needed).
2. **Create.** For each Firebase user, the migration calls `auth.admin.createUser` with the
   **same email**, **no password**, `app_metadata.legacy_firebase_uid`, and `email_confirm: true`.
   Firebase never verified emails, so this keeps the same trust level the account had.
   Getting in still requires the Firebase password (checked by Google) or access to the inbox.
   Disabled Firebase users are created banned.
3. **Map.** `legacy.user_map (firebase_uid → user_id)` keeps posts, replies, likes and follows
   attached to the right person, and makes re-runs idempotent.
4. **No duplicates.** If an auth user with that email already exists (someone signed up on the
   new app early), the migration **links** to it instead of creating a second account
   (`link_method = 'linked'`) and leaves their profile as they set it.
5. **First sign-in** (`legacy-sign-in` Edge Function):
   - Supabase rejects the password (the account has none).
   - The app asks the function to verify it against Firebase's own sign-in endpoint.
   - If the Firebase uid matches the mapping, the function sets it as the Supabase password,
     bcrypt-hashed by Supabase.
   - A trigger stamps `password_migrated_at`, which closes that path for this account forever.
6. **Fallback.** "Forgot password?" works for everyone: it emails a Supabase reset link, then the
   in-app *Choose a new password* screen. That also stamps `password_migrated_at`.

People notice nothing: they sign in with the email and password they always used.

### Accounts with no email

uids that appear in content but have no Firebase Auth record or email
(7 in the REST audit, likely 0 with the Admin export):

- `--orphans skip` (default): their content is held back and listed in the report.
- `--orphans placeholder`: creates a login-less account (`firebase-<uid>@legacy.amigo.invalid`)
  so their posts survive. If the real person turns up later, update that account's email in
  the dashboard and they can reset their password.

### Turning it off, then removing the Firebase dependency

When most active users have migrated (`select count(*) from legacy.user_map where password_migrated_at is null`):

1. **Disable:** `supabase secrets set LEGACY_SIGNIN_ENABLED=false` (instant kill switch), and set
   `VITE_LEGACY_SIGNIN=false` in Vercel and redeploy. Remaining people use "Forgot password?".
2. **Remove the function:** `supabase functions delete legacy-sign-in` and
   `supabase secrets unset FIREBASE_WEB_API_KEY LEGACY_SIGNIN_HASH_KEY LEGACY_SIGNIN_ENABLED`.
3. **Remove client code:** `tryLegacySignIn` in `src/data/supabaseSource.ts`,
   `src/data/firebaseSource.ts`, `src/data/legacy.ts`, `src/lib/firebase.ts` and the `firebase` dependency.
4. **Remove database helpers** (new migration):
   `drop function public.legacy_find_unmigrated_user, public.legacy_signin_throttle, public.legacy_signin_succeeded`,
   the `public.legacy_*` import functions, and finally `drop schema legacy cascade`.
5. Shut down the Firebase project.

## Security notes

- The function never logs or stores passwords. The password goes from the browser to the
  function to Google over TLS, which is exactly what the old app sent directly.
- Unknown emails, already-migrated accounts and wrong passwords all return the same
  `no_match` response, and Firebase is called in every case, so timing doesn't reveal which
  emails are migrated accounts.
- **Rate limited:** 5 failed attempts per email and 20 per IP in 15 minutes
  (`legacy.signin_attempts`). Only HMAC hashes of email and IP are stored, keyed with
  `LEGACY_SIGNIN_HASH_KEY`. Limits apply equally to emails that don't exist, so a
  `429` reveals nothing. A successful migration clears that email's counter.
  Supabase's own sign-in rate limits apply on top.
- Lock the function down with `ALLOWED_ORIGINS`, and turn it off when migration is done.
