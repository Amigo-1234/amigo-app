-- =============================================================================
-- Smaller copies of photos, and checking many files in one call (additive)
--
-- * A post or Moment photo can have one smaller copy ("<original>-sm.<ext>",
--   about 1080 px) that feeds and grids show instead of the full photo. It is
--   uploaded by the same person right after the original and is readable
--   exactly when the original is: every check resolves a copy to its original
--   first. Removing the original removes the copy (and queues both files for
--   deletion from the bucket).
-- * media_sign_set(paths) answers, for up to 60 files at once, which ones the
--   caller may see and whether a smaller copy exists, so a feed page needs one
--   check instead of one per image. Same rules as media_can_read.
-- =============================================================================

alter table public.media_objects add column variant_of text references public.media_objects (path) on delete cascade;
create unique index media_objects_one_variant on public.media_objects (variant_of) where variant_of is not null;

-- The original visibility rules, for an original file.
create function public.media_readable(p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is not null and exists (
    select 1 from public.media_objects o
     where o.path = p_path and o.variant_of is null
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

-- A smaller copy is readable exactly when its original is.
create or replace function public.media_can_read(p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.media_readable(coalesce((select v.variant_of from public.media_objects v where v.path = p_path), p_path))
$$;

create function public.media_sign_set(p_paths text[]) returns table (path text, small text)
language sql stable security definer set search_path = '' as $$
  select x.p, (select v.path from public.media_objects v where v.variant_of = x.p)
    from (select distinct p from unnest(p_paths[1:60]) as t(p)) x
   where public.media_readable(x.p)
$$;

-- The smaller copy of your own photo upload (post or Moment), made right after the original.
create function public.media_begin_variant(p_original text, p_mime text, p_size bigint) returns text
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  o public.media_objects;
  key text;
begin
  if uid is null then raise exception 'sign in first' using errcode = 'MD001'; end if;
  select * into o from public.media_objects where path = p_original;
  if o.path is null or o.owner_id <> uid or o.variant_of is not null or o.purpose not in ('post', 'moment')
     or o.mime not in ('image/jpeg', 'image/png', 'image/webp') then
    raise exception 'not your upload' using errcode = 'MD001';
  end if;
  if p_mime not in ('image/jpeg', 'image/webp') then raise exception 'unsupported file type' using errcode = 'MD002'; end if;
  if p_size is null or p_size <= 0 or p_size > 2 * 1024 * 1024 then raise exception 'file too large' using errcode = 'MD002'; end if;
  if exists (select 1 from public.media_objects where variant_of = p_original) then
    raise exception 'already has a smaller copy' using errcode = 'MD001';
  end if;
  key := regexp_replace(p_original, '\.[a-z0-9]+$', '') || '-sm.' || case p_mime when 'image/webp' then 'webp' else 'jpg' end;
  -- Attached from the start: it lives and goes with its original.
  insert into public.media_objects (path, owner_id, purpose, mime, byte_size, status, variant_of)
  values (key, uid, o.purpose, p_mime, p_size, 'attached', p_original);
  return key;
end $$;

-- Smaller copies don't count against the 60-uploads-an-hour limit (they still count towards daily bytes).
create or replace function public.media_begin_upload(p_purpose text, p_mime text, p_size bigint, p_conversation uuid default null)
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
  if (select count(*) from public.media_objects where owner_id = uid and variant_of is null and created_at > now() - interval '1 hour') >= 60 then
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

revoke execute on function public.media_readable(text), public.media_sign_set(text[]), public.media_begin_variant(text, text, bigint)
  from public, anon, authenticated;
grant execute on function public.media_sign_set(text[]), public.media_begin_variant(text, text, bigint) to authenticated;
-- media_can_read and media_begin_upload were replaced in place; re-assert their grants.
revoke execute on function public.media_can_read(text), public.media_begin_upload(text, text, bigint, uuid) from public, anon;
grant execute on function public.media_can_read(text), public.media_begin_upload(text, text, bigint, uuid) to authenticated;
