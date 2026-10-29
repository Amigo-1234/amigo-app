-- =============================================================================
-- Approved by the project owner 2026-10-17; run once that day after re-verification.
--
-- Removes the 14 accounts created by the automated test runs on 2026-10-12
-- (live E2E messaging test, 4 runs x 2 accounts) and 2026-10-13 (latency
-- benchmark, 3 runs x 2 accounts). Targets an explicit id list, not a pattern;
-- the pattern is only a second safety check.
--
-- Deleting neon_auth."user" cascades to sessions/accounts, and through the
-- app_auth.users mirror trigger to profiles and everything owned by them
-- (devices, keys, messages). Their conversations are removed explicitly.
--
-- Safety checks (any failure aborts with nothing deleted):
--   * exactly 14 of the listed ids exist
--   * each is an unverified account with no admin rights or official badge whose email matches the test
--     run naming (amigo-e2e-<run>-a|b / amigo-perf-<run>-a|b @example.com)
--   * none shares a conversation or follow with an account outside the list
-- Inspected 2026-10-17: 14 found, 0 shared conversations, 0 cross follows,
-- 9 device records, 28 messages between test accounts only.
-- =============================================================================
do $$
declare
  ids uuid[] := array[
    '22cb3f0b-a496-4d05-a159-5b03bdae330b', '03869e7a-5257-4e90-bde1-5a6039b39fc9',  -- e2e 4de75f65
    '7bcbdb30-894e-440f-96a3-67955f1ab03e', '32a7424e-69a1-44e6-a07c-46ad45fdcd46',  -- e2e 7a27bd93
    '23af28ba-f702-4470-a39d-72cf4c519266', 'ea9528ef-b4b8-450e-a411-648604d4715a',  -- e2e 62b87df1
    '2956ab63-d07f-4991-9c2e-9b13dacef778', 'e299719e-70a0-4270-a11f-b2e726e337bf',  -- e2e 8bce0d73
    '98ef704d-f4d9-4c1c-892e-8831d382c157', '76fcc5c8-dac8-4aa7-8049-18dbae7c138f',  -- perf eb3ba6
    '43b182a0-489a-4cef-99ab-6e7af308e224', 'a39f76b8-4a43-4c2d-b955-4ada6ea5bd04',  -- perf 507ec4
    '9017c217-69bd-478b-bc87-fd63dc70c3e5', '8cc42ad0-133b-486e-93ca-78145fddabfa'   -- perf 2855bc
  ]::uuid[];
  n integer;
begin
  select count(*) into n from neon_auth."user" u
   where u.id = any(ids)
     and u.email ~ '^amigo-(e2e|perf)-[0-9a-f]{6,8}-[ab]@example\.com$'
     and not u."emailVerified"
     and coalesce(u.role, 'user') = 'user'
     and not exists (select 1 from public.app_admins a where a.user_id = u.id)
     and not exists (select 1 from public.profile_verifications v where v.user_id = u.id);
  if n <> 14 then raise exception 'expected 14 matching test accounts, found %', n; end if;

  if exists (select 1 from public.dm_participants p
              where p.conversation_id in (select conversation_id from public.dm_participants where user_id = any(ids))
                and not p.user_id = any(ids)) then
    raise exception 'a test account shares a conversation with a real account';
  end if;
  if exists (select 1 from public.follows f where (f.follower_id = any(ids)) <> (f.followee_id = any(ids))) then
    raise exception 'a test account follows or is followed by a real account';
  end if;

  -- Conversations have no owner column, so remove the test-only ones explicitly
  -- (their messages and participants cascade).
  delete from public.dm_conversations c
   where exists (select 1 from public.dm_participants p where p.conversation_id = c.id and p.user_id = any(ids))
     and not exists (select 1 from public.dm_participants p where p.conversation_id = c.id and not p.user_id = any(ids));

  delete from neon_auth."user" where id = any(ids);
  get diagnostics n = row_count;
  if n <> 14 then raise exception 'deleted % rows, expected 14 — rolled back', n; end if;
  raise notice 'removed 14 test accounts';
end $$;
