-- =============================================================================
-- Amigo World — messaging security: devices, cross-signing, verification,
-- encrypted key backup, and message-report review.
--
-- Additive on top of 20261006200000_messages.sql. All cryptography still
-- happens on devices (@matrix-org/matrix-sdk-crypto-wasm / vodozemac); the
-- server stores only PUBLIC keys, signatures and ciphertext:
--
--   e2e_cross_signing_keys   each person's PUBLIC master / self-signing /
--                            user-signing keys (cross-signing: one identity
--                            per person that vouches for their devices)
--   e2e_user_signatures      "I verified this person" signatures — visible
--                            only to the person who made them
--   e2e_backup_versions      encrypted key backup: the backup's PUBLIC key
--   e2e_backup_keys          conversation keys encrypted TO that public key
--                            (m.megolm_backup.v1.curve25519-aes-sha2). Only
--                            the recovery key, which never reaches the
--                            server, can decrypt them.
--   e2e_revoked_devices      devices removed in Settings → Your devices
--   e2e_devices (+columns)   device name and last-active time, private to
--                            the owner
--
-- Verification (emoji comparison, SAS) runs device to device; the server
-- only relays its to-device events.
--
-- Admins: still no access to conversations, keys, signatures or backups.
-- They can review message reports, which contain only what the reporter
-- chose to submit, and mark them reviewed (audit-logged).
-- Error codes: DM009 device removed · DM010 backup version changed ·
--              DM011 invalid keys/signatures
-- =============================================================================

-- --------------------------------------------------------------- tables

alter table public.e2e_devices
  add column display_name    text check (char_length(display_name) <= 64),
  add column last_seen_at    timestamptz,
  add column auth_session_id uuid;
-- The existing column grant (user_id, device_id, device_keys, updated_at) keeps
-- these three private: they're only returned to the owner by e2e_my_devices().

create table public.e2e_revoked_devices (
  user_id     uuid not null references public.profiles (id) on delete cascade,
  device_id   text not null,
  revoked_at  timestamptz not null default now(),
  primary key (user_id, device_id)
);

create table public.e2e_cross_signing_keys (
  user_id     uuid not null references public.profiles (id) on delete cascade,
  key_type    text not null check (key_type in ('master', 'self_signing', 'user_signing')),
  key         jsonb not null check (pg_column_size(key) <= 8192),
  updated_at  timestamptz not null default now(),
  primary key (user_id, key_type)
);

create table public.e2e_user_signatures (
  signer_id   uuid not null references public.profiles (id) on delete cascade,
  target_id   uuid not null references public.profiles (id) on delete cascade,
  key_id      text not null,          -- the target's master key id
  signatures  jsonb not null check (pg_column_size(signatures) <= 4096),
  created_at  timestamptz not null default now(),
  primary key (signer_id, target_id, key_id)
);

create table public.e2e_backup_versions (
  version     bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  algorithm   text not null check (algorithm = 'm.megolm_backup.v1.curve25519-aes-sha2'),
  auth_data   jsonb not null check (jsonb_typeof(auth_data -> 'public_key') = 'string' and pg_column_size(auth_data) <= 8192),
  created_at  timestamptz not null default now()
);
create index e2e_backup_versions_user on public.e2e_backup_versions (user_id, version desc);

create table public.e2e_backup_keys (
  version              bigint not null references public.e2e_backup_versions (version) on delete cascade,
  room_id              text not null,
  session_id           text not null,
  first_message_index  int not null default 0,
  forwarded_count      int not null default 0,
  is_verified          boolean not null default false,
  -- Encrypted to the backup public key; nothing else is allowed in here.
  session_data         jsonb not null check (
    jsonb_typeof(session_data -> 'ciphertext') = 'string'
    and jsonb_typeof(session_data -> 'ephemeral') = 'string'
    and jsonb_typeof(session_data -> 'mac') = 'string'
    and (session_data - array['ciphertext', 'ephemeral', 'mac']) = '{}'::jsonb
    and pg_column_size(session_data) <= 16384),
  updated_at           timestamptz not null default now(),
  primary key (version, room_id, session_id)
);

alter table public.dm_reports
  add column reviewed_by uuid references public.profiles (id) on delete set null,
  add column reviewed_at timestamptz;

revoke all on public.e2e_revoked_devices, public.e2e_cross_signing_keys, public.e2e_user_signatures,
  public.e2e_backup_versions, public.e2e_backup_keys from anon, authenticated;
alter table public.e2e_revoked_devices enable row level security;
alter table public.e2e_cross_signing_keys enable row level security;
alter table public.e2e_user_signatures enable row level security;
alter table public.e2e_backup_versions enable row level security;
alter table public.e2e_backup_keys enable row level security;
-- No client policies or grants: everything goes through the functions below.

-- ------------------------------------------------------------- helpers

create function public.e2e_require_device(p_device text) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'sign in first' using errcode = 'DM001'; end if;
  if exists (select 1 from public.e2e_revoked_devices where user_id = uid and device_id = p_device) then
    raise exception 'this device was removed' using errcode = 'DM009';
  end if;
  return uid;
end $$;

-- Others re-download a person's keys after any change (device lists are keyed off this).
create function public.e2e_touch_user(p_user uuid) returns void
language sql security definer set search_path = '' as $$
  update public.e2e_devices set updated_at = now() where user_id = p_user
$$;

-- Merges signature maps: {signer: {key_id: sig}} ∪ {signer: {key_id: sig}}.
create function public.e2e_merge_signatures(a jsonb, b jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_object_agg(s, coalesce(a -> s, '{}'::jsonb) || coalesce(b -> s, '{}'::jsonb)), '{}'::jsonb)
  from (select jsonb_object_keys(coalesce(a, '{}'::jsonb)) as s
        union select jsonb_object_keys(coalesce(b, '{}'::jsonb))) keys
$$;

-- ------------------------------------------------------------ device keys

-- Same as before, plus: removed devices can't come back under the same id,
-- signatures added later (cross-signing) survive a re-upload, and the
-- device's sign-in session is remembered so removing it can end that sign-in.
create or replace function public.e2e_upload_keys(p_device text, p_device_keys jsonb, p_one_time_keys jsonb, p_fallback_keys jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.e2e_require_device(p_device);
  sess uuid := nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'session_id', '')::uuid;
  k record;
begin
  if p_device !~ '^[A-Za-z0-9_-]{1,64}$' then raise exception 'bad device id' using errcode = 'DM006'; end if;

  if p_device_keys is not null and p_device_keys <> 'null'::jsonb then
    if p_device_keys ->> 'user_id' is distinct from public.e2e_user_id(uid)
       or p_device_keys ->> 'device_id' is distinct from p_device
       or jsonb_typeof(p_device_keys -> 'keys') <> 'object'
       or pg_column_size(p_device_keys) > 8192 then
      raise exception 'device keys must be for your own device' using errcode = 'DM006';
    end if;
    if exists (select 1 from public.e2e_devices d where d.user_id = uid and d.device_id = p_device
               and d.device_keys -> 'keys' <> p_device_keys -> 'keys') then
      raise exception 'device keys already set' using errcode = 'DM006';
    end if;
    insert into public.e2e_devices (user_id, device_id, device_keys, auth_session_id, last_seen_at)
    values (uid, p_device, p_device_keys, sess, now())
    on conflict (user_id, device_id) do update
      set device_keys = jsonb_set(excluded.device_keys, '{signatures}',
            public.e2e_merge_signatures(e2e_devices.device_keys -> 'signatures', excluded.device_keys -> 'signatures')),
          updated_at = now(), last_seen_at = now(),
          auth_session_id = coalesce(excluded.auth_session_id, e2e_devices.auth_session_id);
  end if;

  if not exists (select 1 from public.e2e_devices d where d.user_id = uid and d.device_id = p_device) then
    raise exception 'upload device keys first' using errcode = 'DM006';
  end if;

  for k in select key, value from jsonb_each(coalesce(nullif(p_one_time_keys, 'null'::jsonb), '{}')) loop
    insert into public.e2e_one_time_keys (user_id, device_id, key_id, key) values (uid, p_device, k.key, k.value)
    on conflict do nothing;
  end loop;
  if p_fallback_keys is not null and p_fallback_keys <> 'null'::jsonb and p_fallback_keys <> '{}'::jsonb then
    delete from public.e2e_one_time_keys where user_id = uid and device_id = p_device and fallback;
    for k in select key, value from jsonb_each(p_fallback_keys) loop
      insert into public.e2e_one_time_keys (user_id, device_id, key_id, key, fallback) values (uid, p_device, k.key, k.value, true)
      on conflict (user_id, device_id, key_id) do update set key = excluded.key, fallback = true;
    end loop;
  end if;
  if (select count(*) from public.e2e_one_time_keys where user_id = uid and device_id = p_device) > 200 then
    raise exception 'too many one-time keys' using errcode = 'DM006';
  end if;

  return jsonb_build_object('one_time_key_counts', jsonb_build_object('signed_curve25519',
    (select count(*) from public.e2e_one_time_keys where user_id = uid and device_id = p_device and not fallback)));
end $$;

-- keys/query, now with cross-signing keys. A person's "I verified X"
-- signatures are only included when they themselves ask.
create or replace function public.e2e_query_keys(p_users text[]) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  u record;
  uid uuid;
  devices jsonb := '{}'; masters jsonb := '{}'; selfs jsonb := '{}'; users jsonb := '{}';
  mk jsonb;
begin
  if me is null then raise exception 'sign in first' using errcode = 'DM001'; end if;
  for u in select distinct x as mxid from unnest(p_users[1:100]) x loop
    uid := public.e2e_user_from_id(u.mxid);
    continue when uid is null;
    devices := devices || jsonb_build_object(u.mxid, coalesce(
      (select jsonb_object_agg(device_id, device_keys) from public.e2e_devices where user_id = uid), '{}'::jsonb));
    select key into mk from public.e2e_cross_signing_keys where user_id = uid and key_type = 'master';
    if mk is not null then
      select jsonb_set(mk, '{signatures}', public.e2e_merge_signatures(mk -> 'signatures', s.signatures))
        into mk
        from public.e2e_user_signatures s
        where s.signer_id = me and s.target_id = uid
          and mk -> 'keys' ? s.key_id;
      if mk is null then select key into mk from public.e2e_cross_signing_keys where user_id = uid and key_type = 'master'; end if;
      masters := masters || jsonb_build_object(u.mxid, mk);
    end if;
    selfs := selfs || coalesce((select jsonb_build_object(u.mxid, key) from public.e2e_cross_signing_keys
                               where user_id = uid and key_type = 'self_signing'), '{}'::jsonb);
    if uid = me then
      users := users || coalesce((select jsonb_build_object(u.mxid, key) from public.e2e_cross_signing_keys
                                 where user_id = uid and key_type = 'user_signing'), '{}'::jsonb);
    end if;
  end loop;
  return jsonb_build_object('device_keys', devices, 'master_keys', masters, 'self_signing_keys', selfs,
                            'user_signing_keys', users, 'failures', '{}'::jsonb);
end $$;

-- keys/device_signing/upload: publish (or replace, after a reset) your
-- PUBLIC cross-signing keys. Replacing them is visible to everyone who talks
-- to you — their apps show that your security key changed.
create function public.e2e_upload_signing_keys(p_master jsonb, p_self_signing jsonb, p_user_signing jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  k record;
begin
  if uid is null then raise exception 'sign in first' using errcode = 'DM001'; end if;
  for k in select * from (values ('master', p_master), ('self_signing', p_self_signing), ('user_signing', p_user_signing)) v(t, key) loop
    continue when k.key is null or k.key = 'null'::jsonb;
    if k.key ->> 'user_id' is distinct from public.e2e_user_id(uid)
       or not (k.key -> 'usage') ? k.t
       or jsonb_typeof(k.key -> 'keys') <> 'object' then
      raise exception 'invalid cross-signing key' using errcode = 'DM011';
    end if;
    begin
      insert into public.e2e_cross_signing_keys (user_id, key_type, key) values (uid, k.t, k.key)
      on conflict (user_id, key_type) do update set key = excluded.key, updated_at = now();
    exception when check_violation then
      raise exception 'invalid cross-signing key' using errcode = 'DM011';
    end;
  end loop;
  perform public.e2e_touch_user(uid);
end $$;

-- keys/signatures/upload. Only your own signatures are accepted:
--   on your own devices (self-signing) and your own master key → public,
--   on someone else's master key (user-signing, "I verified them") → private to you.
create function public.e2e_upload_signatures(p_signatures jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  me text;
  t record; o record;
  target uuid;
  mine jsonb;
begin
  if uid is null then raise exception 'sign in first' using errcode = 'DM001'; end if;
  me := public.e2e_user_id(uid);
  for t in select key as mxid, value as objects from jsonb_each(coalesce(p_signatures, '{}')) loop
    target := public.e2e_user_from_id(t.mxid);
    if target is null then raise exception 'bad user' using errcode = 'DM011'; end if;
    for o in select key as key_id, value as obj from jsonb_each(t.objects) loop
      mine := jsonb_build_object(me, coalesce(o.obj -> 'signatures' -> me, '{}'::jsonb));
      if mine -> me = '{}'::jsonb or pg_column_size(mine) > 4096 then
        raise exception 'no signature from you' using errcode = 'DM011';
      end if;
      if target = uid and exists (select 1 from public.e2e_devices where user_id = uid and device_id = o.key_id) then
        update public.e2e_devices
          set device_keys = jsonb_set(device_keys, '{signatures}', public.e2e_merge_signatures(device_keys -> 'signatures', mine))
          where user_id = uid and device_id = o.key_id;
      elsif target = uid and exists (select 1 from public.e2e_cross_signing_keys
                                     where user_id = uid and key_type = 'master' and key -> 'keys' ? ('ed25519:' || o.key_id)) then
        update public.e2e_cross_signing_keys
          set key = jsonb_set(key, '{signatures}', public.e2e_merge_signatures(key -> 'signatures', mine)), updated_at = now()
          where user_id = uid and key_type = 'master';
      elsif target <> uid and exists (select 1 from public.e2e_cross_signing_keys
                                      where user_id = target and key_type = 'master' and key -> 'keys' ? ('ed25519:' || o.key_id)) then
        insert into public.e2e_user_signatures (signer_id, target_id, key_id, signatures)
        values (uid, target, 'ed25519:' || o.key_id, mine)
        on conflict (signer_id, target_id, key_id) do update
          set signatures = public.e2e_merge_signatures(e2e_user_signatures.signatures, excluded.signatures);
      else
        raise exception 'unknown key' using errcode = 'DM011';
      end if;
    end loop;
    perform public.e2e_touch_user(target);
  end loop;
  perform public.e2e_touch_user(uid);
  return jsonb_build_object('failures', '{}'::jsonb);
end $$;

-- Same relay rules as before, plus the events emoji verification and
-- device-to-device secret sharing need. Secrets themselves (m.secret.send)
-- only travel Olm-encrypted, as m.room.encrypted.
create or replace function public.e2e_send_to_device(p_event_type text, p_messages jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  u record; d record; rid uuid;
  n int := 0;
begin
  if uid is null then raise exception 'sign in first' using errcode = 'DM001'; end if;
  if p_event_type not in ('m.room.encrypted', 'm.room_key.withheld', 'm.room_key_request', 'm.dummy',
      'm.key.verification.request', 'm.key.verification.ready', 'm.key.verification.start',
      'm.key.verification.accept', 'm.key.verification.key', 'm.key.verification.mac',
      'm.key.verification.cancel', 'm.key.verification.done', 'm.secret.request') then
    raise exception 'event type not allowed' using errcode = 'DM007';
  end if;
  for u in select key as mxid, value as devices from jsonb_each(coalesce(p_messages, '{}')) loop
    rid := public.e2e_user_from_id(u.mxid);
    if rid is null then raise exception 'bad recipient' using errcode = 'DM007'; end if;
    if rid <> uid and not exists (
      select 1 from public.dm_participants a join public.dm_participants b on b.conversation_id = a.conversation_id
      where a.user_id = uid and b.user_id = rid) then
      raise exception 'no conversation with recipient' using errcode = 'DM007';
    end if;
    for d in select key as device_id, value as content from jsonb_each(u.devices) loop
      n := n + 1;
      if n > 500 or pg_column_size(d.content) > 65536 then raise exception 'too much to-device mail' using errcode = 'DM007'; end if;
      if p_event_type = 'm.room.encrypted' and d.content ->> 'algorithm' is distinct from 'm.olm.v1.curve25519-aes-sha2' then
        raise exception 'room keys must be Olm-encrypted' using errcode = 'DM007';
      end if;
      if d.device_id = '*' then
        insert into public.e2e_to_device (recipient_id, recipient_device, sender_id, event_type, content)
        select rid, e.device_id, uid, p_event_type, d.content from public.e2e_devices e where e.user_id = rid;
      else
        insert into public.e2e_to_device (recipient_id, recipient_device, sender_id, event_type, content)
        values (rid, d.device_id, uid, p_event_type, d.content);
      end if;
    end loop;
  end loop;
end $$;

-- ------------------------------------------------------- your devices

create function public.e2e_touch_device(p_device text, p_name text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.e2e_require_device(p_device);
begin
  update public.e2e_devices
    set last_seen_at = now(),
        display_name = coalesce(nullif(left(btrim(coalesce(p_name, '')), 64), ''), display_name)
    where user_id = uid and device_id = p_device;
end $$;

create function public.e2e_my_devices() returns table (
  device_id text, display_name text, device_keys jsonb, created_at timestamptz, last_seen_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select d.device_id, d.display_name, d.device_keys, d.created_at, d.last_seen_at
  from public.e2e_devices d
  where d.user_id = (select auth.uid())
  order by d.created_at
$$;

-- Remove one of your devices: its keys and mail are deleted, it can't come
-- back under the same id, and (on hosted Supabase) its sign-in is ended.
create function public.e2e_remove_device(p_device text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  sess uuid;
begin
  if uid is null then raise exception 'sign in first' using errcode = 'DM001'; end if;
  select auth_session_id into sess from public.e2e_devices where user_id = uid and device_id = p_device;
  insert into public.e2e_revoked_devices (user_id, device_id) values (uid, p_device) on conflict do nothing;
  delete from public.e2e_to_device where recipient_id = uid and recipient_device = p_device;
  delete from public.e2e_devices where user_id = uid and device_id = p_device;
  if sess is not null and to_regclass('auth.sessions') is not null then
    execute 'delete from auth.sessions where id = $1 and user_id = $2' using sess, uid;
  end if;
  perform public.e2e_touch_user(uid);
end $$;

-- -------------------------------------------------------- key backup

-- Starts a new backup (replacing any old one). auth_data holds the backup's
-- PUBLIC key, signed by the device that created it.
create function public.e2e_backup_create(p_algorithm text, p_auth_data jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  v bigint;
begin
  if uid is null then raise exception 'sign in first' using errcode = 'DM001'; end if;
  delete from public.e2e_backup_versions where user_id = uid;
  begin
    insert into public.e2e_backup_versions (user_id, algorithm, auth_data) values (uid, p_algorithm, p_auth_data)
    returning version into v;
  exception when check_violation then
    raise exception 'invalid backup' using errcode = 'DM011';
  end;
  return v::text;
end $$;

create function public.e2e_backup_current() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('version', v.version::text, 'algorithm', v.algorithm, 'auth_data', v.auth_data,
           'count', (select count(*) from public.e2e_backup_keys k where k.version = v.version),
           'etag', (select coalesce(extract(epoch from max(k.updated_at))::bigint, 0)::text from public.e2e_backup_keys k where k.version = v.version))
  from public.e2e_backup_versions v
  where v.user_id = (select auth.uid())
  order by v.version desc limit 1
$$;

-- room_keys/keys PUT. Keeps the better copy of each key (earlier first index,
-- verified, fewer forwards), as the Matrix spec describes.
create function public.e2e_backup_put(p_version text, p_rooms jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  v bigint;
  r record; s record;
  n int := 0;
begin
  if uid is null then raise exception 'sign in first' using errcode = 'DM001'; end if;
  select version into v from public.e2e_backup_versions where user_id = uid order by version desc limit 1;
  if v is null or v::text <> p_version then raise exception 'backup version changed' using errcode = 'DM010'; end if;
  for r in select key as room_id, value as room from jsonb_each(coalesce(p_rooms, '{}')) loop
    for s in select key as session_id, value as k from jsonb_each(coalesce(r.room -> 'sessions', '{}')) loop
      n := n + 1;
      if n > 1000 then raise exception 'too many keys at once' using errcode = 'DM011'; end if;
      begin
        insert into public.e2e_backup_keys (version, room_id, session_id, first_message_index, forwarded_count, is_verified, session_data)
        values (v, r.room_id, s.session_id, coalesce((s.k ->> 'first_message_index')::int, 0),
                coalesce((s.k ->> 'forwarded_count')::int, 0), coalesce((s.k ->> 'is_verified')::boolean, false), s.k -> 'session_data')
        on conflict (version, room_id, session_id) do update
          set first_message_index = excluded.first_message_index, forwarded_count = excluded.forwarded_count,
              is_verified = excluded.is_verified, session_data = excluded.session_data, updated_at = now()
          where (excluded.is_verified and not e2e_backup_keys.is_verified)
             or (excluded.is_verified = e2e_backup_keys.is_verified
                 and (excluded.first_message_index, excluded.forwarded_count) < (e2e_backup_keys.first_message_index, e2e_backup_keys.forwarded_count));
      exception when check_violation then
        raise exception 'backup keys must be encrypted' using errcode = 'DM011';
      end;
    end loop;
  end loop;
  return (select jsonb_build_object('count', count(*), 'etag', coalesce(extract(epoch from max(updated_at))::bigint, 0)::text)
          from public.e2e_backup_keys where version = v);
end $$;

-- room_keys/keys GET: the encrypted keys, for restoring on a new device.
create function public.e2e_backup_get(p_version text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(room_id, jsonb_build_object('sessions', sessions)), '{}'::jsonb)
  from (
    select k.room_id, jsonb_object_agg(k.session_id, jsonb_build_object(
             'first_message_index', k.first_message_index, 'forwarded_count', k.forwarded_count,
             'is_verified', k.is_verified, 'session_data', k.session_data)) as sessions
    from public.e2e_backup_keys k
    join public.e2e_backup_versions v on v.version = k.version
    where v.user_id = (select auth.uid()) and v.version::text = p_version
    group by k.room_id) rooms
$$;

create function public.e2e_backup_delete() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then raise exception 'sign in first' using errcode = 'DM001'; end if;
  delete from public.e2e_backup_versions where user_id = (select auth.uid());
end $$;

-- ---------------------------------------------------- report review

drop function public.admin_dm_reports();
create function public.admin_dm_reports() returns table (
  id uuid, reporter_id uuid, reporter_username text, reported_id uuid, reported_username text,
  reason text, note text, evidence jsonb, status text, created_at timestamptz,
  reviewed_by_username text, reviewed_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.support_require_admin();
  return query
    select r.id, r.reporter_id, a.username, r.reported_id, b.username, r.reason, r.note, r.evidence, r.status, r.created_at,
           c.username, r.reviewed_at
    from public.dm_reports r
    join public.profiles a on a.id = r.reporter_id
    join public.profiles b on b.id = r.reported_id
    left join public.profiles c on c.id = r.reviewed_by
    order by (r.status = 'open') desc, r.created_at desc
    limit 200;
end $$;

create function public.admin_dm_report_set_status(p_report uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_admin();
  who text;
begin
  if p_status not in ('open', 'reviewed') then raise exception 'invalid status' using errcode = 'SP006'; end if;
  update public.dm_reports set status = p_status,
         reviewed_by = case when p_status = 'reviewed' then uid end,
         reviewed_at = case when p_status = 'reviewed' then now() end
  where id = p_report
  returning (select username from public.profiles where id = reported_id) into who;
  if who is null then raise exception 'no such report' using errcode = 'SP005'; end if;
  perform public.admin_log(case when p_status = 'reviewed' then 'dm_report.reviewed' else 'dm_report.reopened' end,
    'dm_report', p_report, format('%s message report about @%s', case when p_status = 'reviewed' then 'reviewed' else 'reopened' end, who));
end $$;

-- ------------------------------------------------------------ grants

revoke execute on function
  public.e2e_require_device(text), public.e2e_touch_user(uuid), public.e2e_merge_signatures(jsonb, jsonb),
  public.e2e_upload_signing_keys(jsonb, jsonb, jsonb), public.e2e_upload_signatures(jsonb),
  public.e2e_touch_device(text, text), public.e2e_my_devices(), public.e2e_remove_device(text),
  public.e2e_backup_create(text, jsonb), public.e2e_backup_current(), public.e2e_backup_put(text, jsonb),
  public.e2e_backup_get(text), public.e2e_backup_delete(),
  public.admin_dm_reports(), public.admin_dm_report_set_status(uuid, text)
from public, anon;

grant execute on function
  public.e2e_upload_signing_keys(jsonb, jsonb, jsonb), public.e2e_upload_signatures(jsonb),
  public.e2e_touch_device(text, text), public.e2e_my_devices(), public.e2e_remove_device(text),
  public.e2e_backup_create(text, jsonb), public.e2e_backup_current(), public.e2e_backup_put(text, jsonb),
  public.e2e_backup_get(text), public.e2e_backup_delete(),
  public.admin_dm_reports(), public.admin_dm_report_set_status(uuid, text)
to authenticated;
-- e2e_require_device, e2e_touch_user, e2e_merge_signatures: internal only.

-- Your devices list updates live (RLS still limits rows; clients filter to their own user).
alter publication supabase_realtime add table public.e2e_devices;
