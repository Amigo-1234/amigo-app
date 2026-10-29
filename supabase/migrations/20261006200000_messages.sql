-- =============================================================================
-- Amigo World — direct messages, end-to-end encrypted
--
-- Additive. Nothing existing changes.
--
-- Encryption happens on people's devices with the Olm/Megolm protocols, via
-- the audited vodozemac implementation in @matrix-org/matrix-sdk-crypto-wasm
-- (see docs/architecture/MESSAGES.md). This database is only the mailbox:
--
--   dm_conversations / dm_participants   who talks to whom, read/delivered markers
--   dm_messages                          Megolm ciphertext only. A check
--                                        constraint allows exactly the fields of
--                                        an encrypted event (algorithm,
--                                        ciphertext, session_id, sender_key,
--                                        device_id) — there is nowhere to put
--                                        a plaintext body. Text, replies and
--                                        photo keys are all inside the ciphertext.
--   e2e_devices                          each device's PUBLIC identity keys
--   e2e_one_time_keys                    PUBLIC one-time/fallback keys, handed
--                                        out once by e2e_claim_keys
--   e2e_to_device                        Olm-encrypted device-to-device mail
--                                        (how conversation keys are shared)
--   user_blocks                          who blocked whom (only the blocker sees it)
--   dm_reports                           reports; evidence is whatever the
--                                        reporter's device chose to reveal
--   storage bucket dm-attachments        private; encrypted photo bytes only
--
-- Private keys never reach the server: they live in each device's local
-- crypto store. Admins have no read path to message content (there is none
-- to read) and no policy here grants them conversation rows.
--
-- Not built here: server-side key backup (so a new device can't read older
-- messages), cross-signing / safety-number verification, group conversations.
-- =============================================================================

-- ----------------------------------------------------------------- helpers

-- Matrix-style user id used inside the crypto protocol for an Amigo user.
create function public.e2e_user_id(p_user uuid) returns text
language sql immutable set search_path = '' as $$
  select '@' || p_user::text || ':amigo.world'
$$;

create function public.e2e_user_from_id(p_mxid text) returns uuid
language plpgsql immutable set search_path = '' as $$
begin
  if p_mxid !~ '^@[0-9a-f-]{36}:amigo\.world$' then return null; end if;
  return substr(p_mxid, 2, 36)::uuid;
end $$;

-- ------------------------------------------------------------------ tables

create table public.dm_conversations (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null default 'direct' check (kind = 'direct'),
  -- "<smaller uuid>:<larger uuid>" so a pair has exactly one direct conversation.
  direct_key       text not null unique,
  created_at       timestamptz not null default now(),
  last_message_at  timestamptz
);

create table public.dm_participants (
  conversation_id    uuid not null references public.dm_conversations (id) on delete cascade,
  user_id            uuid not null references public.profiles (id) on delete cascade,
  joined_at          timestamptz not null default now(),
  last_read_at       timestamptz not null default '-infinity',
  last_delivered_at  timestamptz not null default '-infinity',
  primary key (conversation_id, user_id)
);
create index dm_participants_user on public.dm_participants (user_id);

create table public.dm_messages (
  id                uuid primary key default gen_random_uuid(),
  conversation_id   uuid not null references public.dm_conversations (id) on delete cascade,
  sender_id         uuid not null references public.profiles (id) on delete cascade,
  sender_device_id  text not null check (char_length(sender_device_id) between 1 and 64),
  content           jsonb not null,
  created_at        timestamptz not null default now(),
  -- Only an encrypted Megolm event fits here; no plaintext fields exist.
  constraint dm_messages_ciphertext_only check (
    jsonb_typeof(content) = 'object'
    and content ->> 'algorithm' = 'm.megolm.v1.aes-sha2'
    and jsonb_typeof(content -> 'ciphertext') = 'string'
    and jsonb_typeof(content -> 'session_id') = 'string'
    and (content - array['algorithm', 'ciphertext', 'session_id', 'sender_key', 'device_id']) = '{}'::jsonb
    and pg_column_size(content) <= 65536
  )
);
create index dm_messages_conversation on public.dm_messages (conversation_id, created_at desc);

create table public.e2e_devices (
  user_id       uuid not null references public.profiles (id) on delete cascade,
  device_id     text not null check (device_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  -- Signed public device keys (curve25519 + ed25519), as uploaded by the device.
  device_keys   jsonb not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (user_id, device_id)
);

create table public.e2e_one_time_keys (
  user_id     uuid not null,
  device_id   text not null,
  key_id      text not null,        -- e.g. "signed_curve25519:AAAAAQ"
  key         jsonb not null,       -- public key + signature
  fallback    boolean not null default false,
  -- Fallback keys stay claimable after use; "used" tells the device to rotate it.
  used        boolean not null default false,
  created_at  timestamptz not null default now(),
  primary key (user_id, device_id, key_id),
  foreign key (user_id, device_id) references public.e2e_devices (user_id, device_id) on delete cascade
);

create table public.e2e_to_device (
  id                bigint generated always as identity primary key,
  recipient_id      uuid not null references public.profiles (id) on delete cascade,
  recipient_device  text not null,
  sender_id         uuid not null references public.profiles (id) on delete cascade,
  event_type        text not null,
  content           jsonb not null,
  created_at        timestamptz not null default now()
);
create index e2e_to_device_inbox on public.e2e_to_device (recipient_id, recipient_device, id);

create table public.user_blocks (
  blocker_id  uuid not null references public.profiles (id) on delete cascade,
  blocked_id  uuid not null references public.profiles (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

create table public.dm_reports (
  id               uuid primary key default gen_random_uuid(),
  reporter_id      uuid not null references public.profiles (id) on delete cascade,
  reported_id      uuid not null references public.profiles (id) on delete cascade,
  conversation_id  uuid references public.dm_conversations (id) on delete set null,
  reason           text not null check (reason in ('spam', 'harassment', 'inappropriate', 'other')),
  note             text not null default '' check (char_length(note) <= 500),
  -- Decrypted by the reporter's device and shared by choice: [{id, sender, text, created_at}].
  -- Unverifiable by the server (no message franking yet) — treat as the reporter's account.
  evidence         jsonb not null default '[]' check (jsonb_typeof(evidence) = 'array' and jsonb_array_length(evidence) <= 20),
  status           text not null default 'open' check (status in ('open', 'reviewed')),
  created_at       timestamptz not null default now()
);

comment on table public.dm_messages is 'End-to-end encrypted messages. content is a Megolm ciphertext envelope; the server never sees plaintext.';
comment on table public.e2e_devices is 'Public device identity keys for end-to-end encryption. Private keys never leave devices.';

-- ------------------------------------------------------------------ access

revoke all on public.dm_conversations, public.dm_participants, public.dm_messages, public.e2e_devices,
  public.e2e_one_time_keys, public.e2e_to_device, public.user_blocks, public.dm_reports from anon, authenticated;

-- Reads only; every write goes through the functions below.
grant select on public.dm_conversations, public.dm_participants, public.dm_messages to authenticated;
grant select (user_id, device_id, device_keys, updated_at) on public.e2e_devices to authenticated;
grant select on public.e2e_to_device to authenticated;
grant select on public.user_blocks to authenticated;
-- e2e_one_time_keys and dm_reports: no client access at all.

alter table public.dm_conversations enable row level security;
alter table public.dm_participants enable row level security;
alter table public.dm_messages enable row level security;
alter table public.e2e_devices enable row level security;
alter table public.e2e_one_time_keys enable row level security;
alter table public.e2e_to_device enable row level security;
alter table public.user_blocks enable row level security;
alter table public.dm_reports enable row level security;

-- SECURITY DEFINER so policies can ask "am I in this conversation?" without recursing into RLS.
create function public.dm_is_participant(p_conversation uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.dm_participants
                 where conversation_id = p_conversation and user_id = (select auth.uid()))
$$;

create function public.dm_blocked_between(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.user_blocks
                 where (blocker_id = a and blocked_id = b) or (blocker_id = b and blocked_id = a))
$$;

-- Participants only. Deliberately no admin clause: admins can't list anyone's conversations.
create policy "Participants see their conversations" on public.dm_conversations
  for select to authenticated using (public.dm_is_participant(id));
create policy "Participants see each other's markers" on public.dm_participants
  for select to authenticated using (public.dm_is_participant(conversation_id));
create policy "Participants read the ciphertext" on public.dm_messages
  for select to authenticated using (public.dm_is_participant(conversation_id));
-- Public keys are meant to be public to signed-in users.
create policy "Device public keys are readable" on public.e2e_devices
  for select to authenticated using (true);
create policy "Devices read their own mail" on public.e2e_to_device
  for select to authenticated using (recipient_id = (select auth.uid()));
create policy "You see who you blocked" on public.user_blocks
  for select to authenticated using (blocker_id = (select auth.uid()));

-- --------------------------------------------------------- conversations

-- The direct conversation with someone, created on first use. Error codes:
--   DM001 not signed in · DM002 no such person / yourself · DM003 not a participant
--   DM004 blocked · DM005 invalid message envelope · DM006 invalid key upload
--   DM007 invalid to-device message · DM008 invalid report
create function public.dm_open(p_peer uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  k text;
  cid uuid;
begin
  if uid is null then raise exception 'sign in first' using errcode = 'DM001'; end if;
  if p_peer is null or p_peer = uid or not exists (select 1 from public.profiles where id = p_peer) then
    raise exception 'no such person' using errcode = 'DM002';
  end if;
  k := least(uid::text, p_peer::text) || ':' || greatest(uid::text, p_peer::text);
  select id into cid from public.dm_conversations where direct_key = k;
  if cid is null then
    insert into public.dm_conversations (direct_key) values (k)
    on conflict (direct_key) do nothing
    returning id into cid;
    if cid is null then select id into cid from public.dm_conversations where direct_key = k; end if;
    insert into public.dm_participants (conversation_id, user_id) values (cid, uid), (cid, p_peer)
    on conflict do nothing;
  end if;
  return cid;
end $$;

create function public.dm_require_participant(p_conversation uuid) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'sign in first' using errcode = 'DM001'; end if;
  if not exists (select 1 from public.dm_participants where conversation_id = p_conversation and user_id = uid) then
    raise exception 'not in this conversation' using errcode = 'DM003';
  end if;
  return uid;
end $$;

-- Stores one encrypted message. The envelope must be Megolm ciphertext from one of your devices.
create function public.dm_send(p_conversation uuid, p_device text, p_content jsonb) returns table (id uuid, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.dm_require_participant(p_conversation);
  peer uuid;
  m record;
begin
  select user_id into peer from public.dm_participants where conversation_id = p_conversation and user_id <> uid limit 1;
  if peer is not null and public.dm_blocked_between(uid, peer) then
    raise exception 'blocked' using errcode = 'DM004';
  end if;
  if not exists (select 1 from public.e2e_devices d where d.user_id = uid and d.device_id = p_device) then
    raise exception 'unknown device' using errcode = 'DM005';
  end if;
  begin
    insert into public.dm_messages (conversation_id, sender_id, sender_device_id, content)
    values (p_conversation, uid, p_device, p_content)
    returning dm_messages.id, dm_messages.created_at into m;
  exception when check_violation then
    raise exception 'not an encrypted message' using errcode = 'DM005';
  end;
  update public.dm_conversations set last_message_at = m.created_at where dm_conversations.id = p_conversation;
  -- Sending means you've seen everything before it.
  update public.dm_participants set last_read_at = greatest(last_read_at, m.created_at),
                                    last_delivered_at = greatest(last_delivered_at, m.created_at)
  where conversation_id = p_conversation and user_id = uid;
  return query select m.id, m.created_at;
end $$;

create function public.dm_mark_read(p_conversation uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.dm_require_participant(p_conversation);
begin
  update public.dm_participants set last_read_at = greatest(last_read_at, now()),
                                    last_delivered_at = greatest(last_delivered_at, now())
  where conversation_id = p_conversation and user_id = uid;
end $$;

-- "Everything sent to me so far has reached a device of mine."
create function public.dm_mark_delivered() returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'sign in first' using errcode = 'DM001'; end if;
  update public.dm_participants p set last_delivered_at = now()
  where p.user_id = uid and exists (
    select 1 from public.dm_conversations c where c.id = p.conversation_id and c.last_message_at > p.last_delivered_at);
end $$;

-- Your conversations with their latest (encrypted) message and unread count. RLS decides visibility.
create function public.dm_inbox() returns table (
  conversation_id uuid, peer_id uuid, last_message_at timestamptz,
  last_message_id uuid, last_sender_id uuid, last_sender_device text, last_content jsonb,
  unread_count bigint, my_last_read_at timestamptz, peer_last_read_at timestamptz, peer_last_delivered_at timestamptz,
  blocked_by_me boolean, can_send boolean)
language sql stable security invoker set search_path = '' as $$
  select c.id, peer.user_id, c.last_message_at,
         lm.id, lm.sender_id, lm.sender_device_id, lm.content,
         (select count(*) from public.dm_messages x
           where x.conversation_id = c.id and x.sender_id <> me.user_id and x.created_at > me.last_read_at),
         me.last_read_at, peer.last_read_at, peer.last_delivered_at,
         exists (select 1 from public.user_blocks b where b.blocker_id = me.user_id and b.blocked_id = peer.user_id),
         not public.dm_blocked_between(me.user_id, peer.user_id)
  from public.dm_participants me
  join public.dm_conversations c on c.id = me.conversation_id
  join public.dm_participants peer on peer.conversation_id = c.id and peer.user_id <> me.user_id
  left join lateral (
    select m.id, m.sender_id, m.sender_device_id, m.content from public.dm_messages m
    where m.conversation_id = c.id order by m.created_at desc limit 1) lm on true
  where me.user_id = (select auth.uid()) and c.last_message_at is not null
  order by c.last_message_at desc
  limit 200
$$;

-- ---------------------------------------------------------------- blocking

create function public.dm_block(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'sign in first' using errcode = 'DM001'; end if;
  if p_user is null or p_user = uid or not exists (select 1 from public.profiles where id = p_user) then
    raise exception 'no such person' using errcode = 'DM002';
  end if;
  insert into public.user_blocks (blocker_id, blocked_id) values (uid, p_user) on conflict do nothing;
end $$;

create function public.dm_unblock(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'sign in first' using errcode = 'DM001'; end if;
  delete from public.user_blocks where blocker_id = uid and blocked_id = p_user;
end $$;

-- ----------------------------------------------------------------- reports

create function public.dm_report(p_conversation uuid, p_reason text, p_note text, p_evidence jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.dm_require_participant(p_conversation);
  peer uuid;
  rid uuid;
begin
  select user_id into peer from public.dm_participants where conversation_id = p_conversation and user_id <> uid limit 1;
  if (select count(*) from public.dm_reports where reporter_id = uid and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'too many reports' using errcode = 'DM008';
  end if;
  begin
    insert into public.dm_reports (reporter_id, reported_id, conversation_id, reason, note, evidence)
    values (uid, peer, p_conversation, p_reason, btrim(coalesce(p_note, '')), coalesce(p_evidence, '[]'))
    returning id into rid;
  exception when check_violation then
    raise exception 'invalid report' using errcode = 'DM008';
  end;
  return rid;
end $$;

-- Admins see reports (and only what reporters chose to reveal), never conversations.
create function public.admin_dm_reports() returns table (
  id uuid, reporter_username text, reported_username text, reason text, note text, evidence jsonb, status text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.support_require_admin();
  return query
    select r.id, a.username, b.username, r.reason, r.note, r.evidence, r.status, r.created_at
    from public.dm_reports r
    join public.profiles a on a.id = r.reporter_id
    join public.profiles b on b.id = r.reported_id
    order by r.created_at desc limit 200;
end $$;

-- ------------------------------------------------------------- crypto keys

-- Publishes this device's public keys. Shapes follow the Matrix client-server
-- API that the crypto library speaks (keys/upload). Returns one-time key counts.
create function public.e2e_upload_keys(p_device text, p_device_keys jsonb, p_one_time_keys jsonb, p_fallback_keys jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  k record;
begin
  if uid is null then raise exception 'sign in first' using errcode = 'DM001'; end if;
  if p_device !~ '^[A-Za-z0-9_-]{1,64}$' then raise exception 'bad device id' using errcode = 'DM006'; end if;

  if p_device_keys is not null and p_device_keys <> 'null'::jsonb then
    if p_device_keys ->> 'user_id' is distinct from public.e2e_user_id(uid)
       or p_device_keys ->> 'device_id' is distinct from p_device
       or jsonb_typeof(p_device_keys -> 'keys') <> 'object'
       or pg_column_size(p_device_keys) > 8192 then
      raise exception 'device keys must be for your own device' using errcode = 'DM006';
    end if;
    -- Identity keys can't be swapped under an existing device id (only re-uploaded unchanged).
    if exists (select 1 from public.e2e_devices d where d.user_id = uid and d.device_id = p_device
               and d.device_keys -> 'keys' <> p_device_keys -> 'keys') then
      raise exception 'device keys already set' using errcode = 'DM006';
    end if;
    insert into public.e2e_devices (user_id, device_id, device_keys) values (uid, p_device, p_device_keys)
    on conflict (user_id, device_id) do update set device_keys = excluded.device_keys, updated_at = now();
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

-- keys/query: everyone's device keys for the users asked about (public information).
create function public.e2e_query_keys(p_users text[]) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('device_keys', coalesce(jsonb_object_agg(u.mxid, coalesce(d.devices, '{}'::jsonb)), '{}'::jsonb), 'failures', '{}'::jsonb)
  from (select distinct x as mxid from unnest(p_users[1:100]) x where public.e2e_user_from_id(x) is not null) u
  left join lateral (
    select jsonb_object_agg(device_id, device_keys) as devices from public.e2e_devices
    where user_id = public.e2e_user_from_id(u.mxid)) d on true
  where (select auth.uid()) is not null
$$;

-- keys/claim: hands out (and deletes) one one-time key per requested device; falls back to the fallback key.
create function public.e2e_claim_keys(p_request jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  u record; d record; picked record;
  result jsonb := '{}';
  n int := 0;
begin
  if uid is null then raise exception 'sign in first' using errcode = 'DM001'; end if;
  for u in select key as mxid, value as devices from jsonb_each(coalesce(p_request, '{}')) loop
    for d in select key as device_id from jsonb_each(u.devices) loop
      n := n + 1;
      exit when n > 200;
      select key_id, key, fallback into picked from public.e2e_one_time_keys
      where user_id = public.e2e_user_from_id(u.mxid) and device_id = d.device_id
      order by fallback, created_at limit 1 for update skip locked;
      if picked.key_id is not null then
        if picked.fallback then
          update public.e2e_one_time_keys set used = true
          where user_id = public.e2e_user_from_id(u.mxid) and device_id = d.device_id and key_id = picked.key_id;
        else
          delete from public.e2e_one_time_keys
          where user_id = public.e2e_user_from_id(u.mxid) and device_id = d.device_id and key_id = picked.key_id;
        end if;
        result := jsonb_set(result, array[u.mxid], coalesce(result -> u.mxid, '{}'::jsonb), true);
        result := jsonb_set(result, array[u.mxid, d.device_id], jsonb_build_object(picked.key_id, picked.key), true);
      end if;
    end loop;
  end loop;
  return jsonb_build_object('one_time_keys', result, 'failures', '{}'::jsonb);
end $$;

-- How many one-time keys this device has left, and whether its fallback key is still unused.
create function public.e2e_key_counts(p_device text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'signed_curve25519', count(*) filter (where not fallback),
    'unused_fallback', coalesce(bool_or(fallback and not used), false))
  from public.e2e_one_time_keys
  where user_id = (select auth.uid()) and device_id = p_device
$$;

-- sendToDevice: queue Olm-encrypted mail for devices. You can only mail yourself
-- and people you share a conversation with.
create function public.e2e_send_to_device(p_event_type text, p_messages jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  u record; d record; rid uuid;
  n int := 0;
begin
  if uid is null then raise exception 'sign in first' using errcode = 'DM001'; end if;
  if p_event_type not in ('m.room.encrypted', 'm.room_key.withheld', 'm.room_key_request', 'm.dummy') then
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
      -- Room keys only ever travel Olm-encrypted.
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

-- Deletes this device's mail up to (and including) p_up_to once it has been processed.
create function public.e2e_ack_to_device(p_device text, p_up_to bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'sign in first' using errcode = 'DM001'; end if;
  delete from public.e2e_to_device where recipient_id = uid and recipient_device = p_device and id <= p_up_to;
end $$;

-- Who (you and the people you talk to) added or changed devices since a time — so
-- devices re-check their keys before sharing a conversation key.
create function public.e2e_device_changes(p_since timestamptz) returns table (user_id text, changed_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select public.e2e_user_id(d.user_id), max(d.updated_at)
  from public.e2e_devices d
  where d.updated_at > p_since and (select auth.uid()) is not null
    and (d.user_id = (select auth.uid()) or exists (
      select 1 from public.dm_participants a join public.dm_participants b on b.conversation_id = a.conversation_id
      where a.user_id = (select auth.uid()) and b.user_id = d.user_id))
  group by d.user_id
$$;

-- Signing out a device removes its keys and mail.
create function public.e2e_delete_device(p_device text) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'sign in first' using errcode = 'DM001'; end if;
  delete from public.e2e_to_device where recipient_id = uid and recipient_device = p_device;
  delete from public.e2e_devices where user_id = uid and device_id = p_device;
  -- Others re-query keys after this.
  update public.e2e_devices set updated_at = now() where user_id = uid;
end $$;

-- ---------------------------------------------------------------- storage

-- Encrypted photo bytes, at <conversation id>/<random name>. Private bucket:
-- only the two participants can fetch them, and they're useless without the
-- key, which is inside the encrypted message.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('dm-attachments', 'dm-attachments', false, 10485760, array['application/octet-stream'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy "Participants upload encrypted attachments" on storage.objects for insert to authenticated
  with check (bucket_id = 'dm-attachments' and public.dm_is_participant(((storage.foldername(name))[1])::uuid));
create policy "Participants fetch encrypted attachments" on storage.objects for select to authenticated
  using (bucket_id = 'dm-attachments' and public.dm_is_participant(((storage.foldername(name))[1])::uuid));

-- ------------------------------------------------------------ grants

revoke execute on function
  public.e2e_user_id(uuid), public.e2e_user_from_id(text),
  public.dm_is_participant(uuid), public.dm_blocked_between(uuid, uuid), public.dm_require_participant(uuid),
  public.dm_open(uuid), public.dm_send(uuid, text, jsonb), public.dm_mark_read(uuid), public.dm_mark_delivered(),
  public.dm_inbox(), public.dm_block(uuid), public.dm_unblock(uuid), public.dm_report(uuid, text, text, jsonb),
  public.admin_dm_reports(),
  public.e2e_upload_keys(text, jsonb, jsonb, jsonb), public.e2e_query_keys(text[]), public.e2e_claim_keys(jsonb),
  public.e2e_key_counts(text), public.e2e_send_to_device(text, jsonb), public.e2e_ack_to_device(text, bigint),
  public.e2e_device_changes(timestamptz), public.e2e_delete_device(text)
from public, anon;

grant execute on function
  public.e2e_user_id(uuid), public.e2e_user_from_id(text),
  public.dm_is_participant(uuid), public.dm_blocked_between(uuid, uuid),
  public.dm_open(uuid), public.dm_send(uuid, text, jsonb), public.dm_mark_read(uuid), public.dm_mark_delivered(),
  public.dm_inbox(), public.dm_block(uuid), public.dm_unblock(uuid), public.dm_report(uuid, text, text, jsonb),
  public.admin_dm_reports(),
  public.e2e_upload_keys(text, jsonb, jsonb, jsonb), public.e2e_query_keys(text[]), public.e2e_claim_keys(jsonb),
  public.e2e_key_counts(text), public.e2e_send_to_device(text, jsonb), public.e2e_ack_to_device(text, bigint),
  public.e2e_device_changes(timestamptz), public.e2e_delete_device(text)
to authenticated;
-- dm_require_participant is internal (used by the functions above only).

-- ------------------------------------------------------------ realtime

alter publication supabase_realtime add table public.dm_messages, public.dm_participants, public.e2e_to_device;

-- Typing indicators use Realtime broadcast on the private topic "dm:<conversation id>";
-- nothing is stored. Only participants may join. (realtime.messages exists on
-- hosted Supabase; skipped where Realtime isn't installed, e.g. local tests.)
do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute $p$
      create policy "Participants use the typing channel" on realtime.messages for all to authenticated
      using (realtime.topic() like 'dm:%' and public.dm_is_participant(nullif(substr(realtime.topic(), 4), '')::uuid))
      with check (realtime.topic() like 'dm:%' and public.dm_is_participant(nullif(substr(realtime.topic(), 4), '')::uuid))
    $p$;
  end if;
end $$;
