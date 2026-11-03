-- =============================================================================
-- Self-service account deletion
--
--   delete_my_account('DELETE')
--     Deletes the signed-in account and everything that cascades from it
--     (profile, posts and the threads under them, likes, follows,
--     notifications, Moments, World membership and chat, Support Hub requests
--     and support, messaging devices, keys, encrypted backups, sent encrypted
--     messages, conversations they were in, reports they made or that were
--     about them, legal acceptances, monetization records). Admin audit-log
--     rows keep the action but lose the link to the person (set null).
--
--   Recent authentication is required on Neon: the account must have signed
--   in within the last 10 minutes (the app re-checks the password right
--   before calling this), so a stolen long-lived session alone can't delete
--   an account.
-- =============================================================================

create function public.delete_my_account(p_confirm text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  fresh boolean;
begin
  if uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  if p_confirm is distinct from 'DELETE' then raise exception 'confirmation required' using errcode = 'AC002'; end if;
  if to_regclass('neon_auth.session') is not null then
    execute 'select exists (select 1 from neon_auth.session where "userId" = $1 and "createdAt" > now() - interval ''10 minutes'')'
      into fresh using uid;
    if not fresh then raise exception 'confirm your password again' using errcode = 'AC001'; end if;
    -- Cascades to sessions/accounts, then (sync trigger) to the profile and everything above.
    execute 'delete from neon_auth."user" where id = $1' using uid;
  else
    delete from auth.users where id = uid;
  end if;
end $$;

revoke execute on function public.delete_my_account(text) from public, anon;
grant execute on function public.delete_my_account(text) to authenticated;
