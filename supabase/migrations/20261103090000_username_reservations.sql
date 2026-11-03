-- Username reservations: people can hold a username before public registration
-- opens, without getting an Amigo account.
--
--   protected_usernames    system and brand names nobody can take (admin-managed)
--   reservation_settings   one row: open?, how long a hold lasts, holds per email
--   username_reservations  one row per attempt: pending (code sent) → active
--                          (email verified) → claimed / expired / revoked / abandoned
--   reservation_attempts   rate-limit log (hashed IPs and emails only)
--
-- One rule decides every username, wherever it's chosen (sign-up, rename, the
-- reservation page): the format check, then not taken by a profile, not
-- protected, and not held by someone else's verified reservation. A trigger on
-- profiles enforces it, so no path (including direct table updates) gets round it.
-- A reservation is claimed by signing in with a confirmed account on the same
-- email; nothing else can move a reserved name to an account (except an admin).
--
-- The public reservation page never talks to the database as a signed-in user:
-- the server route (api/reserve.ts) uses the login-less role username_reserver,
-- which can run reserve_check / reserve_start / reserve_verify and nothing else.
-- Codes are made and emailed by that route; only their SHA-256 is stored here.
-- Nothing here reveals which email holds a name. Errors: UR001–UR009 (the
-- reservation route's three functions answer with {"error": …} instead).
--
-- Additive: new tables, functions, one trigger on profiles (new and changed
-- usernames only; existing usernames are untouched) and replacements of
-- generate_username / handle_new_user that skip protected and reserved names.
-- Undo: drop the trigger, the new functions and tables; restore the two
-- functions from 20261006120000_core_schema.sql.

-- ------------------------------------------------------------ protected names

create table public.protected_usernames (
  username    text primary key check (username ~ '^[a-z0-9_]{1,24}$'),
  note        text check (note is null or char_length(note) <= 200),
  created_at  timestamptz not null default now()
);
insert into public.protected_usernames (username, note)
select n, 'system or brand name' from unnest(array[
  'amigo', 'amigoworld', 'amigo_world', 'amigoofficial', 'amigo_official', 'amigohq', 'amigo_hq', 'amigoapp', 'amigo_app',
  'amigosupport', 'amigo_support', 'amigoteam', 'amigo_team', 'amigodev', 'amigo_dev', 'amigonews', 'amigo_news',
  'admin', 'administrator', 'root', 'system', 'sysadmin', 'superuser', 'owner', 'staff', 'team', 'official', 'verified',
  'moderator', 'mod', 'mods', 'support', 'help', 'helpdesk', 'contact', 'info', 'security', 'safety', 'trust',
  'abuse', 'privacy', 'legal', 'terms', 'policy', 'policies', 'billing', 'payments', 'pay', 'wallet', 'credits',
  'news', 'press', 'media', 'jobs', 'careers', 'about', 'blog', 'status', 'api', 'dev', 'developer', 'developers',
  'www', 'mail', 'email', 'noreply', 'no_reply', 'postmaster', 'webmaster', 'hostmaster',
  'settings', 'account', 'accounts', 'login', 'logout', 'signin', 'signup', 'register', 'reserve', 'reservations',
  'explore', 'search', 'home', 'market', 'marketplace', 'shop', 'store', 'business', 'businesses', 'worlds',
  'messages', 'notifications', 'profile', 'creator', 'creators', 'studio', 'null', 'undefined', 'anonymous',
  'everyone', 'here', 'all', 'test', 'tester', 'demo'
]) n;
revoke all on public.protected_usernames from anon, authenticated;
alter table public.protected_usernames enable row level security;

create function public.username_protected(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.protected_usernames where username = p_name)
$$;

-- ------------------------------------------------------------ settings

create table public.reservation_settings (
  id             integer primary key default 1 check (id = 1),
  open           boolean not null default false,
  hold_days      integer not null default 180 check (hold_days between 7 and 730),
  max_per_email  integer not null default 1 check (max_per_email between 1 and 5),
  updated_at     timestamptz not null default now()
);
insert into public.reservation_settings default values;
revoke all on public.reservation_settings from anon, authenticated;
alter table public.reservation_settings enable row level security;

-- ------------------------------------------------------------ reservations

create table public.username_reservations (
  id               uuid primary key default gen_random_uuid(),
  username         text not null check (username ~ '^[a-z0-9_]{3,24}$'),
  email            text not null check (char_length(email) between 6 and 254 and email = lower(email) and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  status           text not null default 'pending' check (status in ('pending', 'active', 'claimed', 'expired', 'revoked', 'abandoned')),
  code_hash        text check (code_hash is null or code_hash ~ '^[0-9a-f]{64}$'),
  code_expires_at  timestamptz,
  code_sent_at     timestamptz,
  code_attempts    smallint not null default 0,
  created_at       timestamptz not null default now(),
  verified_at      timestamptz,
  expires_at       timestamptz,
  claimed_by       uuid references public.profiles (id) on delete set null,
  claimed_at       timestamptz,
  closed_at        timestamptz,
  closed_reason    text check (closed_reason is null or char_length(closed_reason) <= 300),
  constraint username_reservations_active check (status <> 'active' or (verified_at is not null and expires_at is not null))
);
-- At most one live (pending or active) reservation per name. Stale rows are
-- closed under a per-name lock before a new one is inserted (reservation_sweep).
create unique index username_reservations_live on public.username_reservations (username) where status in ('pending', 'active');
create index username_reservations_email on public.username_reservations (email, status);
create index username_reservations_recent on public.username_reservations (created_at desc);
revoke all on public.username_reservations from anon, authenticated;
alter table public.username_reservations enable row level security;

create table public.reservation_attempts (
  key  text not null check (char_length(key) <= 80),
  at   timestamptz not null default now()
);
create index reservation_attempts_key on public.reservation_attempts (key, at desc);
create index reservation_attempts_at on public.reservation_attempts (at);
revoke all on public.reservation_attempts from anon, authenticated;
alter table public.reservation_attempts enable row level security;

-- The verified holder's email, while the hold lasts (null when nobody holds it).
create function public.username_reserved_email(p_name text) returns text
language sql stable security definer set search_path = '' as $$
  select r.email from public.username_reservations r
   where r.username = p_name and r.status = 'active' and r.expires_at > now()
   limit 1
$$;

-- Whether p_user may have p_name (format and uniqueness are checked separately).
-- A reserved name is theirs only once their account's email is confirmed and
-- is the reservation's email.
create function public.username_claimable(p_name text, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select not public.username_protected(p_name)
     and case when public.username_reserved_email(p_name) is null then true
              -- No confirmed email (or a different one): not theirs.
              else coalesce(public.username_reserved_email(p_name) = (
                     select lower(u.email) from auth.users u where u.id = p_user and u.email_confirmed_at is not null), false) end
$$;

-- Closes stale rows for one name (and one email): pending past its code, active past its hold.
create function public.reservation_sweep(p_name text, p_email text default null) returns void
language sql security definer set search_path = '' as $$
  update public.username_reservations
     set status = case status when 'pending' then 'abandoned' else 'expired' end, closed_at = now(), code_hash = null
   where (username = p_name or (p_email is not null and email = p_email))
     and ((status = 'pending' and code_expires_at <= now()) or (status = 'active' and expires_at <= now()));
$$;

-- ------------------------------------------------------------ one rule for usernames

create function public.profiles_username_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.username = old.username then return new; end if;
  -- Admins assigning a name (admin_set_username) set this for their transaction only.
  if current_setting('amigo.username_admin', true) = 'on' then return new; end if;
  if public.username_protected(new.username) then
    raise exception 'that username isn''t available' using errcode = 'UR001';
  end if;
  if not public.username_claimable(new.username, new.id) then
    raise exception 'that username is reserved' using errcode = 'UR002';
  end if;
  return new;
end $$;
create trigger profiles_username_guard before insert or update of username on public.profiles
  for each row execute function public.profiles_username_guard();

-- As before, but never lands on a protected or reserved name.
create or replace function public.generate_username(seed text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  base text;
  candidate text;
  attempt integer := 0;
begin
  base := lower(coalesce(seed, ''));
  base := translate(base, 'àáâãäåāçćčèéêëēėęìíîïīįłñńòóôõöøōśšùúûüūÿýžźż', 'aaaaaaaccceeeeeeeiiiiiilnnooooooossuuuuuyyzzz');
  base := regexp_replace(base, '[^a-z0-9_]+', '_', 'g');
  base := btrim(base, '_');
  base := left(base, 20);
  if char_length(base) < 3 then
    base := 'amigo' || case when base = '' then '' else '_' || base end;
  end if;
  candidate := base;
  while exists (select 1 from public.profiles where username = candidate)
        or public.username_protected(candidate) or public.username_reserved_email(candidate) is not null loop
    attempt := attempt + 1;
    candidate := left(base, 19) || '_' || (floor(random() * 9000) + 1000)::int::text;
    if attempt > 50 then
      candidate := 'amigo_' || replace(gen_random_uuid()::text, '-', '')::text;
      candidate := left(candidate, 24);
    end if;
  end loop;
  return candidate;
end $$;

-- As before; a wanted username is used only when this account may have it.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  name text := nullif(btrim(left(coalesce(meta ->> 'display_name', meta ->> 'full_name', meta ->> 'name', ''), 50)), '');
  wanted text := lower(nullif(btrim(meta ->> 'username'), ''));
  final_username text;
begin
  if wanted is not null and wanted ~ '^[a-z0-9_]{3,24}$'
     and not exists (select 1 from public.profiles where username = wanted)
     and public.username_claimable(wanted, new.id) then
    final_username := wanted;
  else
    final_username := public.generate_username(coalesce(name, wanted));
  end if;

  insert into public.profiles (id, username, display_name)
  values (new.id, final_username, coalesce(name, final_username));
  return new;
end $$;

-- For the app's username field: free for the signed-in person to take?
create function public.username_available(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is not null
     and p_name ~ '^[a-z0-9_]{3,24}$'
     and not exists (select 1 from public.profiles p where p.username = p_name and p.id <> (select auth.uid()))
     and (exists (select 1 from public.profiles p where p.username = p_name and p.id = (select auth.uid()))
          or public.username_claimable(p_name, (select auth.uid())))
$$;

-- ------------------------------------------------------------ the reservation page (server route only)

-- Counts this key's attempts in the window and records one more; true when over the limit.
create function public.reservation_over_limit(p_key text, p_window interval, p_max integer) returns boolean
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  select count(*) into n from public.reservation_attempts where key = p_key and at > now() - p_window;
  insert into public.reservation_attempts (key) values (p_key);
  -- Keep the log small: anything older than two days is no use to any limit.
  if random() < 0.02 then delete from public.reservation_attempts where at < now() - interval '2 days'; end if;
  return n >= p_max;
end $$;

-- These three answer {"error": "..."} instead of raising: an exception would roll
-- back the attempt log and the wrong-code count, and with them the limits.
-- Errors: slow_down, closed, invalid_name, invalid_email, unavailable,
-- wait (resend cooldown), expired, wrong_code (with tries_left), taken.

-- 'invalid' | 'not_allowed' | 'taken' | 'reserved' | 'available', and whether reservations are open.
create function public.reserve_check(p_name text, p_ip_hash text) returns jsonb
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
  return jsonb_build_object('username', n, 'status', st, 'open', (select open from public.reservation_settings));
end $$;

-- Starts (or resends, or renews) a reservation. The route makes the code and
-- emails it; only its hash comes here. What happens is told to the email's
-- owner, never to the browser: 'code' (send the code), 'notice_active' (this
-- email already holds the name, outside the renewal window) or 'notice_limit'
-- (this email holds as many names as allowed). The route answers the browser
-- the same way in all three cases, so nobody learns which email holds what.
create function public.reserve_start(p_name text, p_email text, p_code_hash text, p_ip_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  n text := lower(btrim(coalesce(p_name, '')));
  e text := lower(btrim(coalesce(p_email, '')));
  s public.reservation_settings;
  r public.username_reservations;
  held text[];
begin
  if coalesce(p_ip_hash, '') !~ '^[0-9a-f]{64}$' or coalesce(p_code_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'bad request' using errcode = '22023';
  end if;
  select * into s from public.reservation_settings;
  if not s.open then return jsonb_build_object('error', 'closed'); end if;
  if public.reservation_over_limit('start-ip:' || left(p_ip_hash, 32), interval '1 hour', 10) then
    return jsonb_build_object('error', 'slow_down');
  end if;
  if n !~ '^[a-z0-9_]{3,24}$' then return jsonb_build_object('error', 'invalid_name'); end if;
  if char_length(e) not between 6 and 254 or e !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    return jsonb_build_object('error', 'invalid_email');
  end if;
  if public.reservation_over_limit('start-email:' || left(encode(sha256(convert_to(e, 'UTF8')), 'hex'), 32), interval '1 day', 6) then
    return jsonb_build_object('error', 'slow_down');
  end if;

  -- One reservation decision per name at a time.
  perform pg_advisory_xact_lock(hashtext('username-reservation:' || n));
  perform public.reservation_sweep(n, e);

  if public.username_protected(n) or exists (select 1 from public.profiles where username = n) then
    return jsonb_build_object('error', 'unavailable');
  end if;
  select * into r from public.username_reservations where username = n and status in ('pending', 'active') for update;
  if r.id is not null and r.email <> e then return jsonb_build_object('error', 'unavailable'); end if;

  if r.id is not null and r.status = 'active' and r.expires_at > now() + interval '30 days' then
    return jsonb_build_object('action', 'notice_active', 'username', n, 'email', e, 'expires_at', r.expires_at);
  end if;

  -- Only an actual new code waits a minute.
  if r.id is not null and r.code_sent_at > now() - interval '60 seconds' then return jsonb_build_object('error', 'wait'); end if;
  if r.id is null then
    select coalesce(array_agg(x.username order by x.username), '{}') into held from public.username_reservations x
     where x.email = e and x.status in ('pending', 'active');
    if cardinality(held) >= s.max_per_email then
      return jsonb_build_object('action', 'notice_limit', 'username', n, 'email', e, 'held', to_jsonb(held));
    end if;
    insert into public.username_reservations (username, email, code_hash, code_expires_at, code_sent_at)
    values (n, e, p_code_hash, now() + interval '15 minutes', now())
    returning * into r;
  else
    -- Resend for a pending one; renewal for an active one in its last 30 days.
    update public.username_reservations
       set code_hash = p_code_hash, code_expires_at = now() + interval '15 minutes', code_sent_at = now(), code_attempts = 0
     where id = r.id
    returning * into r;
  end if;
  return jsonb_build_object('action', 'code', 'id', r.id, 'username', n, 'email', e, 'renewal', r.status = 'active');
end $$;

-- Checks a code. Five wrong tries and the code is gone. On success the name is
-- held for hold_days (a renewal restarts the clock). Returns the details for
-- the confirmation email.
create function public.reserve_verify(p_id uuid, p_code_hash text, p_ip_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.username_reservations;
  days integer := (select hold_days from public.reservation_settings);
begin
  if coalesce(p_ip_hash, '') !~ '^[0-9a-f]{64}$' or coalesce(p_code_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'bad request' using errcode = '22023';
  end if;
  if public.reservation_over_limit('verify-ip:' || left(p_ip_hash, 32), interval '1 hour', 30) then
    return jsonb_build_object('error', 'slow_down');
  end if;
  select * into r from public.username_reservations
   where id = p_id and status in ('pending', 'active') and code_hash is not null for update;
  if r.id is null or r.code_expires_at <= now() or r.code_attempts >= 5 then
    return jsonb_build_object('error', 'expired');
  end if;
  if r.code_hash <> p_code_hash then
    update public.username_reservations
       set code_attempts = code_attempts + 1, code_hash = case when code_attempts + 1 >= 5 then null else code_hash end
     where id = r.id;
    return jsonb_build_object('error', 'wrong_code', 'tries_left', 4 - r.code_attempts);
  end if;
  -- Someone may have registered the name while the code was on its way.
  if r.status = 'pending' and exists (select 1 from public.profiles where username = r.username) then
    update public.username_reservations set status = 'abandoned', closed_at = now(), closed_reason = 'taken before verification', code_hash = null where id = r.id;
    return jsonb_build_object('error', 'taken');
  end if;
  update public.username_reservations
     set status = 'active', verified_at = coalesce(verified_at, now()), expires_at = now() + make_interval(days => days),
         code_hash = null, code_expires_at = null, code_attempts = 0
   where id = r.id
  returning * into r;
  return jsonb_build_object('username', r.username, 'email', r.email, 'expires_at', r.expires_at);
end $$;

-- ------------------------------------------------------------ claiming (signed in)

-- Active reservations held by the signed-in person's confirmed email.
create function public.my_reservations() returns table (id uuid, username text, expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select r.id, r.username, r.expires_at from public.username_reservations r
   where r.status = 'active' and r.expires_at > now()
     and r.email = (select lower(u.email) from auth.users u where u.id = (select auth.uid()) and u.email_confirmed_at is not null)
   order by r.username
$$;

-- Moves a reserved name onto the signed-in account, in one transaction.
create function public.claim_reserved_username(p_reservation uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  mail text := (select lower(u.email) from auth.users u where u.id = (select auth.uid()) and u.email_confirmed_at is not null);
  r public.username_reservations;
begin
  if uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  if mail is null then raise exception 'confirm your email first' using errcode = 'UR008'; end if;
  select * into r from public.username_reservations where id = p_reservation for update;
  if r.id is null or r.status <> 'active' or r.expires_at <= now() or r.email <> mail then
    raise exception 'no such reservation' using errcode = 'UR009';
  end if;
  update public.profiles set username = r.username where id = uid;
  update public.username_reservations set status = 'claimed', claimed_by = uid, claimed_at = now(), closed_at = now() where id = r.id;
  return r.username;
end $$;

-- ------------------------------------------------------------ admin

create function public.admin_reservation_settings() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.support_require_admin();
  return (select jsonb_build_object('open', open, 'hold_days', hold_days, 'max_per_email', max_per_email,
            'active', (select count(*) from public.username_reservations where status = 'active' and expires_at > now()),
            'claimed', (select count(*) from public.username_reservations where status = 'claimed'))
            from public.reservation_settings);
end $$;

create function public.admin_set_reservation_settings(p_open boolean, p_hold_days integer, p_max_per_email integer) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.support_require_admin();
  begin
    update public.reservation_settings set open = p_open, hold_days = p_hold_days, max_per_email = p_max_per_email, updated_at = now();
  exception when check_violation then raise exception 'hold 7–730 days; 1–5 names per email' using errcode = '22023';
  end;
  perform public.admin_log('reservations.settings', 'reservation_settings', null,
    format('reservations %s, %s days, %s per email', case when p_open then 'open' else 'closed' end, p_hold_days, p_max_per_email));
end $$;

-- 'live' (pending or active), 'all', or one status. Admins see emails (disputes need them).
create function public.admin_reservations(p_status text default 'live', p_query text default '') returns table (
  id uuid, username text, email text, status text, created_at timestamptz, verified_at timestamptz, expires_at timestamptz,
  claimed_username text, closed_reason text)
language plpgsql stable security definer set search_path = '' as $$
declare q text := lower(btrim(coalesce(p_query, '')));
begin
  perform public.support_require_admin();
  return query
    select r.id, r.username, r.email, r.status, r.created_at, r.verified_at, r.expires_at, p.username, r.closed_reason
      from public.username_reservations r left join public.profiles p on p.id = r.claimed_by
     where (p_status = 'all' or (p_status = 'live' and r.status in ('pending', 'active')) or r.status = p_status)
       and (q = '' or r.username like '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%'
            or r.email like '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%')
     order by r.created_at desc
     limit 300;
end $$;

create function public.admin_revoke_reservation(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare n text;
begin
  perform public.support_require_admin();
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'give a reason' using errcode = '22023'; end if;
  update public.username_reservations
     set status = 'revoked', closed_at = now(), closed_reason = left(btrim(p_reason), 300), code_hash = null
   where id = p_id and status in ('pending', 'active')
  returning username into n;
  if n is null then raise exception 'no such reservation' using errcode = 'UR009'; end if;
  -- The email isn't put in the audit log.
  perform public.admin_log('reservations.revoke', 'username_reservation', p_id, format('revoked @%s — %s', n, left(btrim(p_reason), 200)));
end $$;

create function public.admin_extend_reservation(p_id uuid, p_days integer) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare
  n text;
  until timestamptz;
begin
  perform public.support_require_admin();
  if p_days not between 1 and 365 then raise exception 'extend by 1–365 days' using errcode = '22023'; end if;
  update public.username_reservations set expires_at = greatest(expires_at, now()) + make_interval(days => p_days)
   where id = p_id and status = 'active'
  returning username, expires_at into n, until;
  if n is null then raise exception 'no such reservation' using errcode = 'UR009'; end if;
  perform public.admin_log('reservations.extend', 'username_reservation', p_id, format('extended @%s by %s days', n, p_days));
  return until;
end $$;

create function public.admin_protected_usernames() returns table (username text, note text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.support_require_admin();
  return query select p.username, p.note, p.created_at from public.protected_usernames p order by p.username;
end $$;

create function public.admin_protect_username(p_name text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare n text := lower(btrim(coalesce(p_name, '')));
begin
  perform public.support_require_admin();
  if n !~ '^[a-z0-9_]{1,24}$' then raise exception 'not a username' using errcode = '22023'; end if;
  insert into public.protected_usernames (username, note) values (n, nullif(left(btrim(coalesce(p_note, '')), 200), ''))
  on conflict (username) do update set note = excluded.note;
  perform public.admin_log('reservations.protect', 'protected_username', null, format('protected @%s', n));
end $$;

create function public.admin_unprotect_username(p_name text) returns void
language plpgsql security definer set search_path = '' as $$
declare n text := lower(btrim(coalesce(p_name, '')));
begin
  perform public.support_require_admin();
  delete from public.protected_usernames where username = n;
  if not found then raise exception 'not protected' using errcode = 'UR009'; end if;
  perform public.admin_log('reservations.unprotect', 'protected_username', null, format('unprotected @%s', n));
end $$;

-- Dispute resolution and official accounts: give an account a name, even a
-- protected or reserved one. Any live reservation on that name is revoked.
create function public.admin_set_username(p_user uuid, p_name text, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  n text := lower(btrim(coalesce(p_name, '')));
  old text;
begin
  perform public.support_require_admin();
  if n !~ '^[a-z0-9_]{3,24}$' then raise exception 'usernames are 3–24 letters, numbers or _' using errcode = 'UR003'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'give a reason' using errcode = '22023'; end if;
  select username into old from public.profiles where id = p_user;
  if old is null then raise exception 'no such account' using errcode = 'UR009'; end if;
  if exists (select 1 from public.profiles where username = n and id <> p_user) then
    raise exception 'another account has that username' using errcode = 'UR004';
  end if;
  update public.username_reservations
     set status = 'revoked', closed_at = now(), closed_reason = left('given to an account by Amigo: ' || btrim(p_reason), 300), code_hash = null
   where username = n and status in ('pending', 'active');
  perform set_config('amigo.username_admin', 'on', true);
  update public.profiles set username = n where id = p_user;
  perform set_config('amigo.username_admin', 'off', true);
  perform public.admin_log('reservations.assign', 'profile', p_user, format('set @%s → @%s — %s', old, n, left(btrim(p_reason), 200)));
end $$;

-- ------------------------------------------------------------ grants

-- The reservation route's role (an operator gives it a login): these three functions and nothing else.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'username_reserver') then
    create role username_reserver nologin;
  end if;
end $$;
grant usage on schema public to username_reserver;

revoke execute on function
  public.username_protected(text), public.username_reserved_email(text), public.username_claimable(text, uuid),
  public.reservation_sweep(text, text), public.profiles_username_guard(), public.username_available(text),
  public.reservation_over_limit(text, interval, integer),
  public.reserve_check(text, text), public.reserve_start(text, text, text, text), public.reserve_verify(uuid, text, text),
  public.my_reservations(), public.claim_reserved_username(uuid),
  public.admin_reservation_settings(), public.admin_set_reservation_settings(boolean, integer, integer),
  public.admin_reservations(text, text), public.admin_revoke_reservation(uuid, text), public.admin_extend_reservation(uuid, integer),
  public.admin_protected_usernames(), public.admin_protect_username(text, text), public.admin_unprotect_username(text),
  public.admin_set_username(uuid, text, text)
from public, anon, authenticated;
grant execute on function public.reserve_check(text, text), public.reserve_start(text, text, text, text), public.reserve_verify(uuid, text, text)
  to username_reserver;
grant execute on function
  public.username_available(text), public.my_reservations(), public.claim_reserved_username(uuid),
  public.admin_reservation_settings(), public.admin_set_reservation_settings(boolean, integer, integer),
  public.admin_reservations(text, text), public.admin_revoke_reservation(uuid, text), public.admin_extend_reservation(uuid, integer),
  public.admin_protected_usernames(), public.admin_protect_username(text, text), public.admin_unprotect_username(text),
  public.admin_set_username(uuid, text, text)
to authenticated;
