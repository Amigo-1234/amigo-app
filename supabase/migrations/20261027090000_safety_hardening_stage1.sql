-- =============================================================================
-- Safety hardening, stage 1 (additive; no existing rows are changed)
--
-- 1. media_cleanup_take is for the upload function only: it now needs the
--    server secret (push_require_server), so a signed-in person can no longer
--    empty the queue of files waiting to be deleted.
-- 2. Message key backup: creating a backup and writing keys to it need a
--    verified device: one of yours, not removed, carrying a signature from your
--    CURRENT self-signing key (what "approved from another device" or setting up
--    your identity leaves behind). The server can't check the signature's maths,
--    only that it sits under the right key id, so the real protection is that
--    nothing is destroyed any more:
--      - a new backup marks the old one superseded instead of deleting it;
--      - a key copy replaced by a "better" one is kept in e2e_backup_keys_replaced;
--      - e2e_backup_delete is no longer callable by signed-in people (the app
--        never used it). Deleting your account still removes everything.
-- 3. Edits: a change to one of your own messages (an annotation by the
--    message's sender) is refused after 15 minutes. The server can't tell an
--    edit from a reaction (both are encrypted), so this also stops reacting to
--    your own messages after 15 minutes. Reactions to other people's messages
--    are unaffected.
--
-- Error codes: DM012 = this device isn't verified; DM013 = too late to change
-- this message.
-- =============================================================================

-- ------------------------------------------------------ 1. media cleanup

drop function public.media_cleanup_take(integer);

create function public.media_cleanup_take(p_key text, p_limit integer default 5) returns setof text
language plpgsql security definer set search_path = '' as $$
begin
  perform public.push_require_server(p_key);
  return query
    delete from public.media_cleanup_queue q
     where q.id in (select id from public.media_cleanup_queue where bucket = 'r2' order by id
                     limit least(greatest(coalesce(p_limit, 5), 1), 20) for update skip locked)
    returning q.path;
end $$;

-- Callers present the secret through the Data API as a signed-in person (like
-- push_message_targets); without the secret it refuses before touching a row.
revoke execute on function public.media_cleanup_take(text, integer) from public, anon;
grant execute on function public.media_cleanup_take(text, integer) to authenticated;

-- ------------------------------------------------ 2. trusted-device backup

-- Signed in, this device not removed, it exists, and it is signed by your
-- current self-signing key.
create function public.e2e_require_trusted_device(p_device text) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := public.e2e_require_device(p_device);
  dk jsonb;
begin
  select d.device_keys into dk from public.e2e_devices d where d.user_id = uid and d.device_id = p_device;
  if dk is null or not exists (
    select 1
      from public.e2e_cross_signing_keys c, jsonb_object_keys(coalesce(c.key -> 'keys', '{}')) as k(key_id)
     where c.user_id = uid and c.key_type = 'self_signing'
       and k.key_id like 'ed25519:%'
       and jsonb_typeof(dk -> 'signatures' -> public.e2e_user_id(uid) -> k.key_id) = 'string') then
    raise exception 'approve this device from another of your devices first' using errcode = 'DM012';
  end if;
  return uid;
end $$;

alter table public.e2e_backup_versions add column superseded_at timestamptz;

-- Copies a backup write displaced. Never read by the app; kept so a bad write
-- can't silently destroy a working key copy. Removed with its backup version.
create table public.e2e_backup_keys_replaced (
  id                   bigint generated always as identity primary key,
  version              bigint not null references public.e2e_backup_versions (version) on delete cascade,
  room_id              text not null,
  session_id           text not null,
  first_message_index  int not null,
  forwarded_count      int not null,
  is_verified          boolean not null,
  session_data         jsonb not null,
  updated_at           timestamptz not null,
  replaced_at          timestamptz not null default now(),
  replaced_by_device   text not null
);
create index e2e_backup_keys_replaced_key on public.e2e_backup_keys_replaced (version, room_id, session_id);
revoke all on public.e2e_backup_keys_replaced from anon, authenticated;
alter table public.e2e_backup_keys_replaced enable row level security;

drop function public.e2e_backup_create(text, jsonb);
drop function public.e2e_backup_put(text, jsonb);

-- Starts a new backup. The previous one is kept (marked superseded), not deleted.
create function public.e2e_backup_create(p_device text, p_algorithm text, p_auth_data jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.e2e_require_trusted_device(p_device);
  v bigint;
begin
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

-- room_keys/keys PUT. Keeps the better copy of each key (earlier first index,
-- verified, fewer forwards), as the Matrix spec describes; the copy it replaces
-- is archived.
create function public.e2e_backup_put(p_device text, p_version text, p_rooms jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.e2e_require_trusted_device(p_device);
  v bigint;
  r record; s record;
  n int := 0;
  fmi int; fwd int; ver boolean;
begin
  select version into v from public.e2e_backup_versions where user_id = uid order by version desc limit 1;
  if v is null or v::text <> p_version then raise exception 'backup version changed' using errcode = 'DM010'; end if;
  for r in select key as room_id, value as room from jsonb_each(coalesce(p_rooms, '{}')) loop
    for s in select key as session_id, value as k from jsonb_each(coalesce(r.room -> 'sessions', '{}')) loop
      n := n + 1;
      if n > 1000 then raise exception 'too many keys at once' using errcode = 'DM011'; end if;
      fmi := coalesce((s.k ->> 'first_message_index')::int, 0);
      fwd := coalesce((s.k ->> 'forwarded_count')::int, 0);
      ver := coalesce((s.k ->> 'is_verified')::boolean, false);
      -- Archive the copy this write is about to replace (same rule as the upsert below).
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

revoke execute on function
  public.e2e_require_trusted_device(text),
  public.e2e_backup_create(text, text, jsonb), public.e2e_backup_put(text, text, jsonb)
from public, anon;
grant execute on function
  public.e2e_backup_create(text, text, jsonb), public.e2e_backup_put(text, text, jsonb)
to authenticated;
revoke execute on function public.e2e_backup_delete() from authenticated;
-- e2e_require_trusted_device: internal only.

-- ------------------------------------------------- 3. 15-minute edit limit

create function public.dm_annotation_window() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.relates_to is not null and exists (
    select 1 from public.dm_messages t
     where t.id = new.relates_to and t.sender_id = new.sender_id
       and t.created_at < now() - interval '15 minutes') then
    raise exception 'too late to change this message' using errcode = 'DM013';
  end if;
  return new;
end $$;
revoke execute on function public.dm_annotation_window() from public, anon, authenticated;
create trigger dm_messages_annotation_window before insert on public.dm_messages
  for each row when (new.relates_to is not null) execute function public.dm_annotation_window();
