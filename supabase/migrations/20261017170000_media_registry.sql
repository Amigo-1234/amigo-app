-- =============================================================================
-- Media registry for object storage outside Postgres (Cloudflare R2 on Neon)
--
-- Files live in a private R2 bucket. Postgres decides everything:
--   * media_begin_upload()  who may upload what: purpose, type, size, daily
--     quota, conversation membership. It picks the object key itself
--     ("<owner>/<purpose>/<random>"), so nobody chooses or guesses paths.
--     The upload function then signs a PUT for exactly that key, type and size.
--   * media_can_read()      the same visibility as the content it belongs to:
--     post visibility, Moment audience and expiry, conversation membership.
--     The read function asks this (as the viewer) before every signed link.
--   * Attaching: a post, Moment or avatar can only use your own, unused upload
--     of the right purpose (triggers below).
--   * Deleting a Moment, an avatar or an account queues the files in
--     media_cleanup_queue; the upload function deletes a few per call.
-- Direct-message files are end-to-end encrypted on the device first; the
-- bucket only ever holds ciphertext for them.
-- Error codes: MD001 not allowed · MD002 bad type/size · MD003 quota
-- =============================================================================

create table public.media_objects (
  path             text primary key check (char_length(path) <= 200),
  owner_id         uuid not null references public.profiles (id) on delete cascade,
  purpose          text not null check (purpose in ('avatar', 'post', 'moment', 'dm')),
  conversation_id  uuid references public.dm_conversations (id) on delete cascade,
  mime             text not null check (char_length(mime) <= 100),
  byte_size        bigint not null check (byte_size > 0),
  status           text not null default 'pending' check (status in ('pending', 'attached')),
  created_at       timestamptz not null default now(),
  check ((purpose = 'dm') = (conversation_id is not null))
);
create index media_objects_owner_recent on public.media_objects (owner_id, created_at desc);
revoke all on public.media_objects from anon, authenticated;
alter table public.media_objects enable row level security;

create trigger media_objects_refuse_suspended before insert on public.media_objects
  for each row execute function public.refuse_if_suspended();

-- Removing a registry row (account deletion, Moment deletion, replaced
-- avatar) queues the file for deletion from the bucket.
create function public.media_queue_cleanup() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.media_cleanup_queue (bucket, path, reason) values ('r2', old.path, 'media removed');
  return null;
end $$;
create trigger media_objects_cleanup after delete on public.media_objects
  for each row execute function public.media_queue_cleanup();

create function public.media_begin_upload(p_purpose text, p_mime text, p_size bigint, p_conversation uuid default null)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  max_bytes bigint;
  ext text;
  key text;
begin
  if uid is null then raise exception 'sign in first' using errcode = 'MD001'; end if;
  if p_purpose = 'dm' then
    -- Ciphertext only; the real type is inside the encrypted message.
    if p_mime <> 'application/octet-stream' then raise exception 'encrypted uploads only' using errcode = 'MD002'; end if;
    max_bytes := 50 * 1024 * 1024;
    perform public.dm_require_participant(p_conversation);
    if exists (select 1 from public.dm_participants p where p.conversation_id = p_conversation and p.user_id <> uid
                 and public.dm_blocked_between(uid, p.user_id)) then
      raise exception 'blocked' using errcode = 'MD001';
    end if;
    ext := 'bin';
  elsif p_purpose in ('avatar', 'post', 'moment') then
    if p_conversation is not null then raise exception 'not allowed' using errcode = 'MD001'; end if;
    case
      when p_mime in ('image/jpeg', 'image/png', 'image/webp', 'image/gif') then
        max_bytes := case when p_purpose = 'avatar' then 5 else 10 end * 1024 * 1024;
        ext := case p_mime when 'image/jpeg' then 'jpg' when 'image/png' then 'png' when 'image/webp' then 'webp' else 'gif' end;
      when p_mime in ('video/mp4', 'video/webm', 'video/quicktime') and p_purpose in ('post', 'moment') then
        max_bytes := 50 * 1024 * 1024;
        ext := case p_mime when 'video/mp4' then 'mp4' when 'video/webm' then 'webm' else 'mov' end;
      else raise exception 'unsupported file type' using errcode = 'MD002';
    end case;
  else
    raise exception 'unknown purpose' using errcode = 'MD002';
  end if;
  if p_size is null or p_size <= 0 or p_size > max_bytes then raise exception 'file too large' using errcode = 'MD002'; end if;
  if (select count(*) from public.media_objects where owner_id = uid and created_at > now() - interval '1 hour') >= 60 then
    raise exception 'upload limit reached, try later' using errcode = 'MD003';
  end if;
  if (select coalesce(sum(byte_size), 0) from public.media_objects where owner_id = uid and created_at > now() - interval '1 day') + p_size
     > 1024::bigint * 1024 * 1024 then
    raise exception 'daily upload limit reached' using errcode = 'MD003';
  end if;
  -- Stale pending uploads (never attached within a day) are dropped and queued for deletion.
  delete from public.media_objects where owner_id = uid and status = 'pending' and purpose <> 'dm' and created_at < now() - interval '1 day';
  key := uid::text || '/' || p_purpose || '/' || coalesce(p_conversation::text || '/', '') || replace(gen_random_uuid()::text, '-', '') || '.' || ext;
  insert into public.media_objects (path, owner_id, purpose, conversation_id, mime, byte_size)
  values (key, uid, p_purpose, p_conversation, p_mime, p_size);
  return key;
end $$;

create function public.media_can_read(p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is not null and exists (
    select 1 from public.media_objects o
     where o.path = p_path
       and (o.owner_id = (select auth.uid())
            or (o.purpose = 'avatar' and o.status = 'attached')
            or (o.purpose = 'post' and exists (
                  select 1 from public.post_media pm join public.posts p on p.id = pm.post_id
                   where pm.storage_path = o.path and p.deleted_at is null and public.can_view_post(p.id)))
            or (o.purpose = 'moment' and public.moment_media_readable(o.path))
            or (o.purpose = 'dm' and exists (
                  select 1 from public.dm_participants dp
                   where dp.conversation_id = o.conversation_id and dp.user_id = (select auth.uid())))))
$$;

-- Neon (files in R2) uses this registry; the Supabase deployment keeps using
-- Supabase Storage and its policies, so the attach rules apply on Neon only.
create function public.media_registry_required() returns boolean
language sql stable set search_path = '' as $$
  select to_regnamespace('neon_auth') is not null
$$;

-- Only your own unused upload of the right purpose can be attached.
create function public.media_attach(p_path text, p_purpose text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.media_objects set status = 'attached'
   where path = p_path and owner_id = (select auth.uid()) and purpose = p_purpose and status = 'pending';
  if not found then raise exception 'not your upload' using errcode = 'MD001'; end if;
end $$;

create function public.post_media_require_upload() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if public.media_registry_required() then perform public.media_attach(new.storage_path, 'post'); end if;
  return new;
end $$;
create trigger post_media_require_upload before insert on public.post_media
  for each row execute function public.post_media_require_upload();

create function public.moments_require_upload() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.media_path is not null and public.media_registry_required() then perform public.media_attach(new.media_path, 'moment'); end if;
  return new;
end $$;
create trigger moments_require_upload before insert on public.moments
  for each row execute function public.moments_require_upload();

-- A deleted Moment's file goes too (its registry row; the trigger above queues the file).
create function public.moments_release_upload() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.media_path is not null then delete from public.media_objects where path = old.media_path; end if;
  return null;
end $$;
create trigger moments_release_upload after delete on public.moments
  for each row execute function public.moments_release_upload();

-- Avatars: "/api/media/<key>" pointing at your own avatar upload; the old one is released.
alter table public.profiles drop constraint profiles_avatar_url_https;
alter table public.profiles add constraint profiles_avatar_url_https
  check (avatar_url is null or avatar_url ~ '^https://' or avatar_url ~ '^/api/media/[A-Za-z0-9/._-]+$');

create function public.profiles_avatar_upload() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.avatar_url is distinct from old.avatar_url then
    if new.avatar_url like '/api/media/%' then
      perform public.media_attach(substr(new.avatar_url, 12), 'avatar');
    end if;
    if old.avatar_url like '/api/media/%' then
      delete from public.media_objects where path = substr(old.avatar_url, 12) and purpose = 'avatar';
    end if;
  end if;
  return new;
end $$;
create trigger profiles_avatar_upload before update of avatar_url on public.profiles
  for each row execute function public.profiles_avatar_upload();

-- For the upload function: a few queued deletions at a time. Returns only
-- keys of files already removed from the app (random, no personal data).
create function public.media_cleanup_take(p_limit integer default 5) returns setof text
language sql security definer set search_path = '' as $$
  delete from public.media_cleanup_queue q
   where q.id in (select id from public.media_cleanup_queue where bucket = 'r2' order by id
                   limit least(greatest(coalesce(p_limit, 5), 1), 20) for update skip locked)
  returning q.path
$$;

revoke execute on function
  public.media_registry_required(), public.media_queue_cleanup(), public.media_begin_upload(text, text, bigint, uuid), public.media_can_read(text),
  public.media_attach(text, text), public.post_media_require_upload(), public.moments_require_upload(),
  public.moments_release_upload(), public.profiles_avatar_upload(), public.media_cleanup_take(integer)
from public, anon, authenticated;
grant execute on function
  public.media_begin_upload(text, text, bigint, uuid), public.media_can_read(text), public.media_cleanup_take(integer)
to authenticated;
