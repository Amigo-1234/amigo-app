-- =============================================================================
-- A tiny blurred preview for each post photo (additive)
--
-- About 24 px wide, a few hundred bytes, stored with the post itself, so a
-- photo's shape and colours show the moment the post does, even on a slow
-- connection, while the real image loads. It is made on the author's device
-- from the same processed photo (no location or camera metadata) and is
-- visible to exactly those who can see the post.
-- =============================================================================

alter table public.post_media add column preview text
  check (preview is null or (char_length(preview) <= 2000 and preview ~ '^data:image/(webp|jpeg|png);base64,[A-Za-z0-9+/=]+$'));

grant insert (preview) on public.post_media to authenticated;

-- create_post / create_world_post: unchanged except that media items may carry "preview".
create or replace function public.create_post(
  p_body text,
  p_parent_id uuid default null,
  p_media jsonb default '[]'::jsonb,
  p_visibility public.post_visibility default 'public',
  p_client_ref uuid default null
) returns public.posts
language plpgsql set search_path = '' as $$
declare
  body text := btrim(coalesce(p_body, ''));
  media_count integer := coalesce(jsonb_array_length(p_media), 0);
  created public.posts;
  item jsonb;
  i integer := 0;
begin
  if (select auth.uid()) is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  -- A retry of a post that was already saved: return it.
  if p_client_ref is not null then
    select * into created from public.posts where author_id = (select auth.uid()) and client_ref = p_client_ref;
    if found then return created; end if;
  end if;
  if body = '' and media_count = 0 then
    raise exception 'a post needs text or media' using errcode = '22023';
  end if;
  if char_length(body) > 500 then
    raise exception 'posts are limited to 500 characters' using errcode = '22001';
  end if;
  if media_count > 4 then
    raise exception 'at most 4 media items per post' using errcode = '22023';
  end if;
  insert into public.posts (author_id, body, parent_id, visibility, client_ref)
  values ((select auth.uid()), body, p_parent_id, p_visibility, p_client_ref)
  returning * into created;
  for item in select value from jsonb_array_elements(coalesce(p_media, '[]'::jsonb)) loop
    insert into public.post_media (post_id, owner_id, position, kind, storage_path, mime_type, width, height, byte_size, alt, preview)
    values (
      created.id, (select auth.uid()), i,
      (item ->> 'kind')::public.media_kind,
      item ->> 'storage_path',
      item ->> 'mime_type',
      (item ->> 'width')::integer,
      (item ->> 'height')::integer,
      (item ->> 'byte_size')::bigint,
      nullif(item ->> 'alt', ''),
      nullif(item ->> 'preview', '')
    );
    i := i + 1;
  end loop;
  return created;
end $$;

create or replace function public.create_world_post(
  p_world_id uuid,
  p_body text,
  p_media jsonb default '[]'::jsonb,
  p_entry boolean default false,
  p_client_ref uuid default null
) returns public.posts
language plpgsql set search_path = '' as $$
declare
  body text := btrim(coalesce(p_body, ''));
  media_count integer := coalesce(jsonb_array_length(p_media), 0);
  created public.posts;
  item jsonb;
  i integer := 0;
begin
  if (select auth.uid()) is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_client_ref is not null then
    select * into created from public.posts where author_id = (select auth.uid()) and client_ref = p_client_ref;
    if found then return created; end if;
  end if;
  if body = '' and media_count = 0 then
    raise exception 'a post needs text or media' using errcode = '22023';
  end if;
  if char_length(body) > 500 then
    raise exception 'posts are limited to 500 characters' using errcode = '22001';
  end if;
  if media_count > 4 then
    raise exception 'at most 4 media items per post' using errcode = '22023';
  end if;
  insert into public.posts (author_id, body, world_id, is_entry, client_ref)
  values ((select auth.uid()), body, p_world_id, coalesce(p_entry, false), p_client_ref)
  returning * into created;
  for item in select value from jsonb_array_elements(coalesce(p_media, '[]'::jsonb)) loop
    insert into public.post_media (post_id, owner_id, position, kind, storage_path, mime_type, width, height, byte_size, alt, preview)
    values (
      created.id, (select auth.uid()), i,
      (item ->> 'kind')::public.media_kind,
      item ->> 'storage_path',
      item ->> 'mime_type',
      (item ->> 'width')::integer,
      (item ->> 'height')::integer,
      (item ->> 'byte_size')::bigint,
      nullif(item ->> 'alt', ''),
      nullif(item ->> 'preview', '')
    );
    i := i + 1;
  end loop;
  return created;
end $$;
