-- =============================================================================
-- Safety hardening, stage 1b (on top of 20261027090000; additive, no existing
-- rows are changed)
--
-- 1. Key backup writes need proof of possession, checked cryptographically.
--    Postgres can't verify Ed25519, so writes go through /api/e2e-backup:
--      a. the device asks for a one-time challenge (e2e_proof_challenge);
--      b. it signs "challenge + what it wants to write" with its own device key
--         (only that device holds the private key);
--      c. the API fetches the device's public keys (e2e_proof_material) and checks
--         device key -> self-signing key -> master key and the request signature
--         with WebCrypto Ed25519, then calls the write function with the server
--         secret, the challenge and a hash of the keys it checked.
--    The write functions accept only the server (push_require_server), consume
--    the challenge (no replays), and refuse if the keys changed since the check.
--    Naming a device id, pasting a made-up signature or replaying a request no
--    longer works. The master key is the root of trust (as everywhere in the app).
-- 2. Replacing an existing identity (master / self-signing / user-signing key)
--    is refused to ordinary calls; /api/e2e-identity does it after checking the
--    session was signed in within the last 10 minutes, verifies the new keys,
--    records it (e2e_security_events) and emails the account. Uploading the same
--    keys again (finishing an interrupted setup) still works directly.
-- 3. Older backups: the owner can list them (e2e_backup_versions) and restore one
--    with its recovery key.
-- 4. Edits vs reactions: dm_send_v3 takes p_kind ('reaction' | 'edit'), stored in
--    relates_kind (the server learns which, never the content). Reactions are
--    allowed at any age; edits only by the message's sender within 15 minutes
--    (server time); no kind (apps from before this) is treated as a possible edit.
--    Receivers apply an annotation only when its encrypted type matches the label.
-- 5. Media cleanup: queue rows are leased, not deleted, and removed only once the
--    file is confirmed gone (media_cleanup_done). A lease expires after 10
--    minutes, so a crash means a retry, never a lost file. 10 attempts at most.
--
-- Error codes: DM014 identity change needs a fresh sign-in; DM015 keys changed
-- since they were checked; DM016 missing/used/expired challenge.
-- =============================================================================

-- ------------------------------------------------- 1. proof of possession

create table public.e2e_proof_challenges (
  user_id     uuid not null references public.profiles (id) on delete cascade,
  device_id   text not null,
  nonce       text not null,
  expires_at  timestamptz not null,
  primary key (user_id, nonce)
);
revoke all on public.e2e_proof_challenges from anon, authenticated;
alter table public.e2e_proof_challenges enable row level security;

-- A one-time challenge for one of your (not removed) devices, valid 5 minutes.
create function public.e2e_proof_challenge(p_device text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.e2e_require_device(p_device);
  n text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
begin
  if not exists (select 1 from public.e2e_devices where user_id = uid and device_id = p_device) then
    raise exception 'unknown device' using errcode = 'DM012';
  end if;
  delete from public.e2e_proof_challenges where user_id = uid and expires_at < now();
  if (select count(*) from public.e2e_proof_challenges where user_id = uid) >= 50 then
    raise exception 'slow down' using errcode = 'RL001';
  end if;
  insert into public.e2e_proof_challenges (user_id, device_id, nonce, expires_at) values (uid, p_device, n, now() + interval '5 minutes');
  return n;
end $$;

-- What the check is about: the public keys as stored now, and a hash of exactly those.
create function public.e2e_proof_hash(p_user uuid, p_device text) returns text
language sql stable security definer set search_path = '' as $$
  select encode(sha256(convert_to(
           coalesce((select device_keys::text from public.e2e_devices where user_id = p_user and device_id = p_device), '') || '|' ||
           coalesce((select key::text from public.e2e_cross_signing_keys where user_id = p_user and key_type = 'master'), '') || '|' ||
           coalesce((select key::text from public.e2e_cross_signing_keys where user_id = p_user and key_type = 'self_signing'), ''),
         'UTF8')), 'hex')
$$;

-- For the API only (server secret): the caller's device keys and cross-signing keys (all public).
create function public.e2e_proof_material(p_key text, p_device text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid;
  r jsonb;
begin
  perform public.push_require_server(p_key);
  uid := public.e2e_require_device(p_device);
  select jsonb_build_object(
           'user', public.e2e_user_id(uid),
           'device_keys', d.device_keys,
           'master', (select key from public.e2e_cross_signing_keys where user_id = uid and key_type = 'master'),
           'self_signing', (select key from public.e2e_cross_signing_keys where user_id = uid and key_type = 'self_signing'),
           'hash', public.e2e_proof_hash(uid, p_device))
    into r
    from public.e2e_devices d where d.user_id = uid and d.device_id = p_device;
  if r is null or r -> 'master' = 'null'::jsonb or r -> 'self_signing' = 'null'::jsonb then
    raise exception 'approve this device from another of your devices first' using errcode = 'DM012';
  end if;
  return r;
end $$;

-- Uses up the challenge; the keys must still be the ones the API checked.
create function public.e2e_proof_consume(p_user uuid, p_device text, p_nonce text, p_hash text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.e2e_proof_challenges
   where user_id = p_user and nonce = p_nonce and device_id = p_device and expires_at >= now();
  if not found then raise exception 'challenge missing, used or expired' using errcode = 'DM016'; end if;
  if p_hash is distinct from public.e2e_proof_hash(p_user, p_device) then
    raise exception 'keys changed; try again' using errcode = 'DM015';
  end if;
end $$;

-- Stage 1's device-id-only writes are replaced by the verified ones below.
drop function public.e2e_backup_create(text, text, jsonb);
drop function public.e2e_backup_put(text, text, jsonb);

create function public.e2e_backup_create_verified(p_key text, p_device text, p_nonce text, p_hash text, p_algorithm text, p_auth_data jsonb)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid;
  v bigint;
begin
  perform public.push_require_server(p_key);
  uid := public.e2e_require_trusted_device(p_device);
  perform public.e2e_proof_consume(uid, p_device, p_nonce, p_hash);
  begin
    insert into public.e2e_backup_versions (user_id, algorithm, auth_data) values (uid, p_algorithm, p_auth_data)
    returning version into v;
  exception when check_violation then
    raise exception 'invalid backup' using errcode = 'DM011';
  end;
  update public.e2e_backup_versions set superseded_at = now()
   where user_id = uid and version < v and superseded_at is null;
  return v::text;
end $$;

create function public.e2e_backup_put_verified(p_key text, p_device text, p_nonce text, p_hash text, p_version text, p_rooms jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid;
  v bigint;
  r record; s record;
  n int := 0;
  fmi int; fwd int; ver boolean;
begin
  perform public.push_require_server(p_key);
  uid := public.e2e_require_trusted_device(p_device);
  perform public.e2e_proof_consume(uid, p_device, p_nonce, p_hash);
  select version into v from public.e2e_backup_versions where user_id = uid order by version desc limit 1;
  if v is null or v::text <> p_version then raise exception 'backup version changed' using errcode = 'DM010'; end if;
  for r in select key as room_id, value as room from jsonb_each(coalesce(p_rooms, '{}')) loop
    for s in select key as session_id, value as k from jsonb_each(coalesce(r.room -> 'sessions', '{}')) loop
      n := n + 1;
      if n > 1000 then raise exception 'too many keys at once' using errcode = 'DM011'; end if;
      fmi := coalesce((s.k ->> 'first_message_index')::int, 0);
      fwd := coalesce((s.k ->> 'forwarded_count')::int, 0);
      ver := coalesce((s.k ->> 'is_verified')::boolean, false);
      insert into public.e2e_backup_keys_replaced (version, room_id, session_id, first_message_index, forwarded_count,
                                                   is_verified, session_data, updated_at, replaced_by_device)
      select k.version, k.room_id, k.session_id, k.first_message_index, k.forwarded_count, k.is_verified, k.session_data, k.updated_at, p_device
        from public.e2e_backup_keys k
       where k.version = v and k.room_id = r.room_id and k.session_id = s.session_id
         and ((ver and not k.is_verified)
              or (ver = k.is_verified and (fmi, fwd) < (k.first_message_index, k.forwarded_count)));
      begin
        insert into public.e2e_backup_keys (version, room_id, session_id, first_message_index, forwarded_count, is_verified, session_data)
        values (v, r.room_id, s.session_id, fmi, fwd, ver, s.k -> 'session_data')
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

-- Your backups, newest first (older ones can be restored with their own recovery key).
create function public.e2e_backup_versions() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'version', v.version::text, 'algorithm', v.algorithm, 'auth_data', v.auth_data,
           'created_at', v.created_at, 'superseded_at', v.superseded_at,
           'count', (select count(*) from public.e2e_backup_keys k where k.version = v.version))
           order by v.version desc), '[]'::jsonb)
  from public.e2e_backup_versions v
  where v.user_id = (select auth.uid())
$$;

-- ------------------------------------------------ 2. identity replacement

create table public.e2e_security_events (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  kind        text not null check (kind in ('identity_reset')),
  device_id   text,
  old_master  text,
  new_master  text,
  created_at  timestamptz not null default now()
);
create index e2e_security_events_user on public.e2e_security_events (user_id, created_at desc);
revoke all on public.e2e_security_events from anon, authenticated;
alter table public.e2e_security_events enable row level security;

-- Shared by the direct upload and the verified replacement: shape checks and the write.
create function public.e2e_store_signing_keys(p_user uuid, p_master jsonb, p_self_signing jsonb, p_user_signing jsonb, p_replace boolean)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  k record;
  old jsonb;
begin
  for k in select * from (values ('master', p_master), ('self_signing', p_self_signing), ('user_signing', p_user_signing)) v(t, key) loop
    continue when k.key is null or k.key = 'null'::jsonb;
    if k.key ->> 'user_id' is distinct from public.e2e_user_id(p_user)
       or not (k.key -> 'usage') ? k.t
       or jsonb_typeof(k.key -> 'keys') <> 'object' then
      raise exception 'invalid cross-signing key' using errcode = 'DM011';
    end if;
    select c.key into old from public.e2e_cross_signing_keys c where c.user_id = p_user and c.key_type = k.t;
    if not p_replace and old is not null and old -> 'keys' is distinct from k.key -> 'keys' then
      raise exception 'resetting your security key needs a fresh sign-in' using errcode = 'DM014';
    end if;
    begin
      insert into public.e2e_cross_signing_keys (user_id, key_type, key) values (p_user, k.t, k.key)
      on conflict (user_id, key_type) do update set key = excluded.key, updated_at = now();
    exception when check_violation then
      raise exception 'invalid cross-signing key' using errcode = 'DM011';
    end;
  end loop;
  perform public.e2e_touch_user(p_user);
end $$;

-- Direct: first-time setup, or the same keys again. A different key is DM014.
create or replace function public.e2e_upload_signing_keys(p_master jsonb, p_self_signing jsonb, p_user_signing jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'sign in first' using errcode = 'DM001'; end if;
  perform public.e2e_store_signing_keys(uid, p_master, p_self_signing, p_user_signing, false);
end $$;

-- For the API only: replaces the identity after a fresh sign-in and a check of the new keys.
create function public.e2e_replace_identity(p_key text, p_session_user uuid, p_device text,
                                            p_master jsonb, p_self_signing jsonb, p_user_signing jsonb)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid;
  old text;
begin
  perform public.push_require_server(p_key);
  uid := public.e2e_require_device(p_device);
  if p_session_user is distinct from uid then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_master is null or p_self_signing is null then raise exception 'invalid cross-signing key' using errcode = 'DM011'; end if;
  select (select k from jsonb_object_keys(key -> 'keys') k limit 1) into old
    from public.e2e_cross_signing_keys where user_id = uid and key_type = 'master';
  perform public.e2e_store_signing_keys(uid, p_master, p_self_signing, p_user_signing, true);
  insert into public.e2e_security_events (user_id, kind, device_id, old_master, new_master)
  values (uid, 'identity_reset', p_device, old, (select k from jsonb_object_keys(p_master -> 'keys') k limit 1));
end $$;

-- Your recent security events (shown on Your devices).
create function public.e2e_my_security_events() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('kind', e.kind, 'device_id', e.device_id, 'at', e.created_at) order by e.created_at desc), '[]'::jsonb)
  from (select * from public.e2e_security_events where user_id = (select auth.uid()) order by created_at desc limit 20) e
$$;

-- ------------------------------------------------- 4. edits vs reactions

alter table public.dm_messages
  add column relates_kind text check (relates_kind in ('reaction', 'edit')),
  add constraint dm_messages_relates_kind_target check (relates_kind is null or relates_to is not null);

create or replace function public.dm_annotation_window() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  t record;
begin
  if new.relates_to is null or new.relates_kind = 'reaction' then return new; end if;
  select x.sender_id, x.created_at into t from public.dm_messages x where x.id = new.relates_to;
  if not found then return new; end if; -- the foreign key refuses it
  if new.relates_kind = 'edit' and t.sender_id <> new.sender_id then
    raise exception 'only your own messages can be edited' using errcode = 'DM006';
  end if;
  -- An edit, or no kind (an app from before kinds existed: it may be an edit).
  if t.sender_id = new.sender_id and t.created_at < now() - interval '15 minutes' then
    raise exception 'too late to change this message' using errcode = 'DM013';
  end if;
  return new;
end $$;

drop function public.dm_send_v3(uuid, uuid, text, jsonb, uuid);
-- As before, plus p_kind for annotations (older apps leave it out).
create function public.dm_send_v3(p_id uuid, p_conversation uuid, p_device text, p_content jsonb, p_relates_to uuid default null,
                                  p_kind text default null)
returns table (id uuid, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.dm_require_participant(p_conversation);
  peer uuid;
  m record;
begin
  if p_id is null then raise exception 'message id required' using errcode = 'DM005'; end if;
  if p_kind is not null and (p_relates_to is null or p_kind not in ('reaction', 'edit')) then
    raise exception 'invalid kind' using errcode = 'DM005';
  end if;
  select x.id, x.created_at, x.sender_id, x.conversation_id into m from public.dm_messages x where x.id = p_id;
  if found then
    if m.sender_id <> uid or m.conversation_id <> p_conversation then raise exception 'id in use' using errcode = 'DM005'; end if;
    return query select m.id, m.created_at;
    return;
  end if;
  if p_relates_to is not null and not exists (
    select 1 from public.dm_messages t where t.id = p_relates_to and t.conversation_id = p_conversation and t.relates_to is null) then
    raise exception 'no such message' using errcode = 'DM006';
  end if;
  select user_id into peer from public.dm_participants where conversation_id = p_conversation and user_id <> uid limit 1;
  if peer is not null and public.dm_blocked_between(uid, peer) then
    raise exception 'blocked' using errcode = 'DM004';
  end if;
  if not exists (select 1 from public.e2e_devices d where d.user_id = uid and d.device_id = p_device) then
    raise exception 'unknown device' using errcode = 'DM005';
  end if;
  begin
    insert into public.dm_messages (id, conversation_id, sender_id, sender_device_id, content, relates_to, relates_kind)
    values (p_id, p_conversation, uid, p_device, p_content, p_relates_to, p_kind)
    returning dm_messages.id, dm_messages.created_at into m;
  exception
    when check_violation then raise exception 'not an encrypted message' using errcode = 'DM005';
    when unique_violation then
      return query select x.id, x.created_at from public.dm_messages x
        where x.id = p_id and x.sender_id = uid and x.conversation_id = p_conversation;
      return;
  end;
  if p_relates_to is null then
    update public.dm_conversations set last_message_at = m.created_at where dm_conversations.id = p_conversation;
    update public.dm_participants set last_read_at = greatest(last_read_at, m.created_at),
           last_delivered_at = greatest(last_delivered_at, m.created_at)
     where conversation_id = p_conversation and user_id = uid;
  else
    update public.dm_conversations set changed_at = m.created_at where dm_conversations.id = p_conversation;
  end if;
  return query select m.id, m.created_at;
end $$;

-- dm_thread, now with relates_kind.
create or replace function public.dm_thread(p_conversation uuid, p_after timestamptz default null, p_before timestamptz default null, p_limit integer default 50)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := public.dm_require_participant(p_conversation);
  peer uuid;
begin
  select user_id into peer from public.dm_participants where conversation_id = p_conversation and user_id <> uid limit 1;
  return jsonb_build_object(
    'members', (select jsonb_agg(jsonb_build_object('user_id', p.user_id, 'last_read_at', p.last_read_at, 'last_delivered_at', p.last_delivered_at))
                  from public.dm_participants p where p.conversation_id = p_conversation),
    'blocked_by_me', exists (select 1 from public.user_blocks b where b.blocker_id = uid and b.blocked_id = peer),
    'blocked_either', peer is not null and public.dm_blocked_between(uid, peer),
    'messages', (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at, x.id), '[]'::jsonb) from (
                   select m.id, m.conversation_id, m.sender_id, m.sender_device_id, m.content, m.created_at, m.relates_to, m.relates_kind
                     from public.dm_messages m
                    where m.conversation_id = p_conversation
                      and (p_after is null or m.created_at >= p_after)
                      and (p_before is null or m.created_at < p_before)
                    order by m.created_at desc, m.id desc
                    limit least(greatest(coalesce(p_limit, 50), 1), 100)) x),
    'deleted', case when p_after is null then '[]'::jsonb else
                 (select coalesce(jsonb_agg(t.message_id), '[]'::jsonb) from public.dm_tombstones t
                   where t.conversation_id = p_conversation and t.deleted_at >= p_after) end
  );
end $$;

-- ------------------------------------------------------ 5. media cleanup

alter table public.media_cleanup_queue
  add column claimed_at timestamptz,
  add column claim_token uuid,
  add column attempts integer not null default 0;

drop function public.media_cleanup_take(text, integer);
-- Leases a few queued files (not taken by anyone else in the last 10 minutes). Nothing is deleted here.
create function public.media_cleanup_take(p_key text, p_limit integer default 5)
returns table (item_id bigint, item_path text, claim uuid)
language plpgsql security definer set search_path = '' as $$
declare
  t uuid := gen_random_uuid();
begin
  perform public.push_require_server(p_key);
  return query
    update public.media_cleanup_queue q
       set claimed_at = now(), claim_token = t, attempts = q.attempts + 1
     where q.id in (select c.id from public.media_cleanup_queue c
                     where c.bucket = 'r2' and c.attempts < 10
                       and (c.claimed_at is null or c.claimed_at < now() - interval '10 minutes')
                     order by c.id
                     limit least(greatest(coalesce(p_limit, 5), 1), 20)
                     for update skip locked)
    returning q.id, q.path, q.claim_token;
end $$;

-- The files the caller confirmed gone: [{"id":…,"claim":"…"}]. Only the current lease holder can finish an item.
create function public.media_cleanup_done(p_key text, p_items jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  n integer;
begin
  perform public.push_require_server(p_key);
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 20 then
    raise exception 'invalid items' using errcode = '22023';
  end if;
  delete from public.media_cleanup_queue q
   using jsonb_to_recordset(p_items) as i(id bigint, claim uuid)
   where q.id = i.id and q.claim_token = i.claim;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------- grants

revoke execute on function
  public.e2e_proof_challenge(text), public.e2e_proof_hash(uuid, text), public.e2e_proof_material(text, text),
  public.e2e_proof_consume(uuid, text, text, text),
  public.e2e_backup_create_verified(text, text, text, text, text, jsonb),
  public.e2e_backup_put_verified(text, text, text, text, text, jsonb),
  public.e2e_backup_versions(), public.e2e_store_signing_keys(uuid, jsonb, jsonb, jsonb, boolean),
  public.e2e_replace_identity(text, uuid, text, jsonb, jsonb, jsonb), public.e2e_my_security_events(),
  public.dm_send_v3(uuid, uuid, text, jsonb, uuid, text),
  public.media_cleanup_take(text, integer), public.media_cleanup_done(text, jsonb)
from public, anon;
-- Callable signed in; the *_verified, material, replace and cleanup ones also need the server secret.
grant execute on function
  public.e2e_proof_challenge(text), public.e2e_proof_material(text, text),
  public.e2e_backup_create_verified(text, text, text, text, text, jsonb),
  public.e2e_backup_put_verified(text, text, text, text, text, jsonb),
  public.e2e_backup_versions(), public.e2e_replace_identity(text, uuid, text, jsonb, jsonb, jsonb),
  public.e2e_my_security_events(), public.dm_send_v3(uuid, uuid, text, jsonb, uuid, text),
  public.media_cleanup_take(text, integer), public.media_cleanup_done(text, jsonb)
to authenticated;
-- e2e_proof_hash, e2e_proof_consume, e2e_store_signing_keys: internal only.
