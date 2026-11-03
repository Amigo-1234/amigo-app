-- Username reservations: housekeeping before launch (on top of 20261103090000).
--
-- - Retention: a reservation's email is kept only while it's needed. 30 days
--   after a reservation closes (claimed, expired, revoked or never confirmed)
--   the row is deleted, email and all. Time-expired rows are closed first.
--   reservation_housekeeping() does this; the reservation route's calls run it
--   now and then (like the attempt log's clean-up), and admins can run it.
-- - Admin list: a reservation whose time has run out shows as expired (or not
--   confirmed) straight away, not only once something touches it.
-- - reserve_check also returns hold_days, so the page states the real hold.
--
-- Additive: one new function, three replaced. Undo: drop
-- reservation_housekeeping() and restore the three functions from 20261103090000.

create function public.reservation_housekeeping() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  closed integer;
  purged integer;
begin
  update public.username_reservations
     set status = case status when 'pending' then 'abandoned' else 'expired' end, closed_at = now(), code_hash = null
   where (status = 'pending' and code_expires_at <= now()) or (status = 'active' and expires_at <= now());
  get diagnostics closed = row_count;
  delete from public.username_reservations
   where status in ('claimed', 'expired', 'revoked', 'abandoned') and closed_at < now() - interval '30 days';
  get diagnostics purged = row_count;
  delete from public.reservation_attempts where at < now() - interval '2 days';
  return jsonb_build_object('closed', closed, 'purged', purged);
end $$;

-- As before; the occasional clean-up now covers reservations too.
create or replace function public.reservation_over_limit(p_key text, p_window interval, p_max integer) returns boolean
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  select count(*) into n from public.reservation_attempts where key = p_key and at > now() - p_window;
  insert into public.reservation_attempts (key) values (p_key);
  if random() < 0.02 then perform public.reservation_housekeeping(); end if;
  return n >= p_max;
end $$;

-- As before, plus how long a reservation is held.
create or replace function public.reserve_check(p_name text, p_ip_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  n text := lower(btrim(coalesce(p_name, '')));
  st text;
begin
  if coalesce(p_ip_hash, '') !~ '^[0-9a-f]{64}$' then raise exception 'bad request' using errcode = '22023'; end if;
  if public.reservation_over_limit('check:' || left(p_ip_hash, 32), interval '10 minutes', 120) then
    return jsonb_build_object('error', 'slow_down');
  end if;
  st := case
    when n !~ '^[a-z0-9_]{3,24}$' then 'invalid'
    when public.username_protected(n) then 'not_allowed'
    when exists (select 1 from public.profiles where username = n) then 'taken'
    when exists (select 1 from public.username_reservations r where r.username = n
                  and ((r.status = 'active' and r.expires_at > now()) or (r.status = 'pending' and r.code_expires_at > now()))) then 'reserved'
    else 'available' end;
  return (select jsonb_build_object('username', n, 'status', st, 'open', s.open, 'hold_days', s.hold_days) from public.reservation_settings s);
end $$;

-- As before, but the status shown is the real one even before housekeeping runs.
create or replace function public.admin_reservations(p_status text default 'live', p_query text default '') returns table (
  id uuid, username text, email text, status text, created_at timestamptz, verified_at timestamptz, expires_at timestamptz,
  claimed_username text, closed_reason text)
language plpgsql stable security definer set search_path = '' as $$
declare q text := lower(btrim(coalesce(p_query, '')));
begin
  perform public.support_require_admin();
  return query
    with r as (
      select x.*, case
               when x.status = 'active' and x.expires_at <= now() then 'expired'
               when x.status = 'pending' and x.code_expires_at <= now() then 'abandoned'
               else x.status end as shown
        from public.username_reservations x)
    select r.id, r.username, r.email, r.shown, r.created_at, r.verified_at, r.expires_at, p.username, r.closed_reason
      from r left join public.profiles p on p.id = r.claimed_by
     where (p_status = 'all' or (p_status = 'live' and r.shown in ('pending', 'active')) or r.shown = p_status)
       and (q = '' or r.username like '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%'
            or r.email like '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%')
     order by r.created_at desc
     limit 300;
end $$;

-- Admins can run the clean-up on demand (it runs on its own as well).
create function public.admin_reservation_housekeeping() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r jsonb;
begin
  perform public.support_require_admin();
  r := public.reservation_housekeeping();
  perform public.admin_log('reservations.housekeeping', 'reservation_settings', null,
    format('closed %s, deleted %s', r ->> 'closed', r ->> 'purged'));
  return r;
end $$;

revoke execute on function public.reservation_housekeeping(), public.admin_reservation_housekeeping() from public, anon, authenticated;
grant execute on function public.admin_reservation_housekeeping() to authenticated;
