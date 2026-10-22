-- =============================================================================
-- Web Push: notifications on a locked phone (additive)
--
-- * push_subscriptions: one row per browser/device that turned notifications
--   on (its push service endpoint and the public keys the browser gave for
--   encrypting to it). Endpoints must belong to a known browser push service,
--   so the sending function can never be pointed anywhere else.
-- * notification_prefs: what each person wants pushed (messages on by default).
-- * Sending is done by the server (api/push-notify.ts) right after someone
--   sends a message. push_message_targets() only answers that server (it
--   holds a secret whose hash is stored here; the secret itself is not), and
--   only if the caller really sent a new message in that conversation in the
--   last two minutes. Blocked pairs and people who turned message pushes off
--   are skipped, and each person gets at most one push per conversation every
--   15 seconds.
-- * Privacy: a push says only that there is a new message and in which
--   conversation (encrypted to the device, so the push service can't read
--   even that). Message text, sender names and keys are never sent.
-- =============================================================================

create table public.push_subscriptions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles (id) on delete cascade,
  endpoint         text not null unique check (
    char_length(endpoint) <= 1000 and endpoint ~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)/[A-Za-z0-9/_:.?=&%-]+$'),
  p256dh           text not null check (p256dh ~ '^[A-Za-z0-9_-]{80,100}$'),
  auth             text not null check (auth ~ '^[A-Za-z0-9_-]{16,32}$'),
  label            text not null default '' check (char_length(label) <= 60),
  created_at       timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  last_success_at  timestamptz,
  failures         integer not null default 0
);
create index push_subscriptions_user on public.push_subscriptions (user_id);
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;
-- Your own devices, without their keys or endpoints.
grant select (id, user_id, label, created_at, last_seen_at, last_success_at) on public.push_subscriptions to authenticated;
create policy push_subscriptions_own on public.push_subscriptions for select to authenticated using (user_id = (select auth.uid()));

create table public.notification_prefs (
  user_id        uuid primary key references public.profiles (id) on delete cascade,
  push_messages  boolean not null default true,
  push_worlds    boolean not null default true,
  push_social    boolean not null default false,
  updated_at     timestamptz not null default now()
);
alter table public.notification_prefs enable row level security;
revoke all on public.notification_prefs from anon, authenticated;
grant select on public.notification_prefs to authenticated;
create policy notification_prefs_own on public.notification_prefs for select to authenticated using (user_id = (select auth.uid()));

-- Last push per person and conversation (rate limit only; no content).
create unlogged table public.push_rate (
  recipient_id     uuid not null,
  conversation_id  uuid not null,
  last_at          timestamptz not null,
  primary key (recipient_id, conversation_id)
);
alter table public.push_rate enable row level security;
revoke all on public.push_rate from anon, authenticated;

-- The sending server's secret, as a SHA-256 hash (set outside migrations).
create table public.push_server (
  id        integer primary key default 1 check (id = 1),
  key_hash  text not null check (key_hash ~ '^[0-9a-f]{64}$')
);
alter table public.push_server enable row level security;
revoke all on public.push_server from anon, authenticated;

create function public.push_require_server(p_key text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_key is null or not exists (
    select 1 from public.push_server where key_hash = encode(sha256(convert_to(p_key, 'UTF8')), 'hex')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
end $$;

-- ------------------------------------------------------------------ devices

create function public.push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_label text default '')
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  sid uuid;
begin
  if uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  begin
    -- The same browser signed in as someone else now: the device moves to them.
    insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, label)
    values (uid, p_endpoint, p_p256dh, p_auth, left(coalesce(p_label, ''), 60))
    on conflict (endpoint) do update
      set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label,
          last_seen_at = now(), failures = 0
    returning id into sid;
  exception when check_violation then
    raise exception 'not a supported push service' using errcode = '22023';
  end;
  -- At most 10 devices each: the least recently seen go.
  delete from public.push_subscriptions where id in (
    select id from public.push_subscriptions where user_id = uid order by last_seen_at desc offset 10);
  return sid;
end $$;

-- At app start: is this browser still registered (and to whom)? Moves it to the
-- signed-in person if another account had it; never re-adds a removed device.
create function public.push_touch(p_endpoint text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  if uid is null then return false; end if;
  update public.push_subscriptions set user_id = uid, last_seen_at = now() where endpoint = p_endpoint;
  return found;
end $$;

create function public.push_unsubscribe(p_endpoint text) returns void
language sql security definer set search_path = '' as $$
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = (select auth.uid())
$$;

create function public.push_remove_device(p_id uuid) returns void
language sql security definer set search_path = '' as $$
  delete from public.push_subscriptions where id = p_id and user_id = (select auth.uid())
$$;

create function public.set_notification_prefs(p_messages boolean default null, p_worlds boolean default null, p_social boolean default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  insert into public.notification_prefs (user_id, push_messages, push_worlds, push_social)
  values (uid, coalesce(p_messages, true), coalesce(p_worlds, true), coalesce(p_social, false))
  on conflict (user_id) do update
    set push_messages = coalesce(p_messages, notification_prefs.push_messages),
        push_worlds = coalesce(p_worlds, notification_prefs.push_worlds),
        push_social = coalesce(p_social, notification_prefs.push_social),
        updated_at = now();
end $$;

-- ------------------------------------------------------------------ sending (server only)

create function public.push_message_targets(p_key text, p_conversation uuid)
returns table (id uuid, endpoint text, p256dh text, auth_secret text)
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  perform public.push_require_server(p_key);
  if uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  -- Only right after the caller sent a new message (not a reaction or edit) in this conversation.
  if not exists (
    select 1 from public.dm_messages m
     where m.conversation_id = p_conversation and m.sender_id = uid and m.relates_to is null
       and m.created_at > now() - interval '2 minutes') then
    return;
  end if;
  return query
    with recipients as (
      select p.user_id
        from public.dm_participants p
        left join public.notification_prefs np on np.user_id = p.user_id
       where p.conversation_id = p_conversation and p.user_id <> uid
         and coalesce(np.push_messages, true)
         and not public.dm_blocked_between(uid, p.user_id)
    ), stamped as (
      insert into public.push_rate as r (recipient_id, conversation_id, last_at)
      select user_id, p_conversation, now() from recipients
      on conflict (recipient_id, conversation_id) do update set last_at = now()
        where r.last_at < now() - interval '15 seconds'
      returning r.recipient_id
    )
    select s.id, s.endpoint, s.p256dh, s.auth
      from public.push_subscriptions s
      join stamped on stamped.recipient_id = s.user_id
     where s.failures < 20;
end $$;

-- "Send a test notification": your own devices, at most once every 20 seconds.
create function public.push_self_targets(p_key text)
returns table (id uuid, endpoint text, p256dh text, auth_secret text)
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  perform public.push_require_server(p_key);
  if uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  insert into public.push_rate as r (recipient_id, conversation_id, last_at) values (uid, uid, now())
  on conflict (recipient_id, conversation_id) do update set last_at = now() where r.last_at < now() - interval '20 seconds';
  if not found then return; end if;
  return query select s.id, s.endpoint, s.p256dh, s.auth from public.push_subscriptions s where s.user_id = uid;
end $$;

-- Outcome per device: [{ "id": …, "ok": true } | { "id": …, "gone": true } | { "id": … }].
create function public.push_report(p_key text, p_results jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.push_require_server(p_key);
  delete from public.push_subscriptions
   where id in (select (r ->> 'id')::uuid from jsonb_array_elements(coalesce(p_results, '[]')) r where (r ->> 'gone')::boolean);
  update public.push_subscriptions s set last_success_at = now(), failures = 0
   where s.id in (select (r ->> 'id')::uuid from jsonb_array_elements(coalesce(p_results, '[]')) r where (r ->> 'ok')::boolean);
  update public.push_subscriptions s set failures = s.failures + 1
   where s.id in (select (r ->> 'id')::uuid from jsonb_array_elements(coalesce(p_results, '[]')) r
                   where not coalesce((r ->> 'ok')::boolean, false) and not coalesce((r ->> 'gone')::boolean, false));
  -- Keep the rate table small.
  delete from public.push_rate where last_at < now() - interval '1 hour';
end $$;

revoke execute on function
  public.push_require_server(text), public.push_subscribe(text, text, text, text), public.push_touch(text), public.push_unsubscribe(text),
  public.push_remove_device(uuid), public.set_notification_prefs(boolean, boolean, boolean),
  public.push_message_targets(text, uuid), public.push_self_targets(text), public.push_report(text, jsonb)
from public, anon, authenticated;
grant execute on function
  public.push_subscribe(text, text, text, text), public.push_touch(text), public.push_unsubscribe(text), public.push_remove_device(uuid),
  public.set_notification_prefs(boolean, boolean, boolean), public.push_message_targets(text, uuid), public.push_self_targets(text),
  public.push_report(text, jsonb)
to authenticated;
