-- =============================================================================
-- Rate limiting for the legacy-sign-in Edge Function.
--
-- Stores only keyed hashes (HMAC computed in the function), never raw emails or
-- IP addresses. Limits apply identically whether or not an email belongs to a
-- migrated account, so being throttled reveals nothing.
--
--   per email:  5 failed attempts / 15 minutes
--   per IP:    20 failed attempts / 15 minutes
-- =============================================================================

create table legacy.signin_attempts (
  id            bigint generated always as identity primary key,
  email_key     text not null,
  ip_key        text not null,
  attempted_at  timestamptz not null default now()
);
create index signin_attempts_email_idx on legacy.signin_attempts (email_key, attempted_at desc);
create index signin_attempts_ip_idx on legacy.signin_attempts (ip_key, attempted_at desc);

-- Returns true and records the attempt if under the limits; false if throttled.
create function public.legacy_signin_throttle(p_email_key text, p_ip_key text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  window_start timestamptz := now() - interval '15 minutes';
begin
  -- Opportunistic cleanup keeps the table tiny.
  delete from legacy.signin_attempts where attempted_at < now() - interval '1 day';

  if (select count(*) from legacy.signin_attempts where email_key = p_email_key and attempted_at > window_start) >= 5
     or (select count(*) from legacy.signin_attempts where ip_key = p_ip_key and attempted_at > window_start) >= 20 then
    return false;
  end if;

  insert into legacy.signin_attempts (email_key, ip_key) values (p_email_key, p_ip_key);
  return true;
end $$;

-- A successful sign-in clears that email's failures.
create function public.legacy_signin_succeeded(p_email_key text) returns void
language sql security definer set search_path = '' as $$
  delete from legacy.signin_attempts where email_key = p_email_key;
$$;

revoke execute on function public.legacy_signin_throttle(text, text) from public, anon, authenticated;
revoke execute on function public.legacy_signin_succeeded(text) from public, anon, authenticated;
grant execute on function public.legacy_signin_throttle(text, text) to service_role;
grant execute on function public.legacy_signin_succeeded(text) to service_role;
