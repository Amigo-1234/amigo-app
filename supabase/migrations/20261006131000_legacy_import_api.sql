-- =============================================================================
-- Import API for the one-time Firebase migration.
--
-- The migration script runs where only HTTPS is available, so instead of a raw
-- Postgres connection it calls these functions through the Data API with the
-- service-role key. Each call is one transaction. All are SECURITY DEFINER and
-- executable by service_role ONLY. Drop them together with the legacy schema
-- once the migration period is over (see docs/migration/AUTH.md).
-- =============================================================================

-- Current id maps, so re-runs skip what already exists.
create function public.legacy_state() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'users', coalesce((select jsonb_object_agg(firebase_uid, user_id) from legacy.user_map), '{}'::jsonb),
    'posts', coalesce((select jsonb_object_agg(firebase_path, post_id) from legacy.post_map), '{}'::jsonb),
    'media', coalesce((select jsonb_agg(source_key) from legacy.media_map), '[]'::jsonb)
  );
$$;

create function public.legacy_find_auth_user(p_email text) returns uuid
language sql stable security definer set search_path = '' as $$
  select id from auth.users where lower(email) = lower(p_email) order by created_at limit 1;
$$;

create function public.legacy_map_user(
  p_firebase_uid text, p_user_id uuid, p_link_method text, p_email text, p_created_at timestamptz
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into legacy.user_map (firebase_uid, user_id, link_method, email_at_migration)
  values (p_firebase_uid, p_user_id, p_link_method, p_email)
  on conflict (firebase_uid) do nothing;
  -- Only accounts the migration created take the legacy join date.
  if p_link_method = 'created' and p_created_at is not null then
    update public.profiles set created_at = least(created_at, p_created_at) where id = p_user_id;
  end if;
end $$;

-- Post or reply + its map row, atomically. Returns the (new or existing) post id.
create function public.legacy_import_post(
  p_path text, p_kind text, p_author_id uuid, p_body text, p_parent_id uuid, p_created_at timestamptz, p_raw_meta jsonb
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  existing uuid;
  new_id uuid;
begin
  select post_id into existing from legacy.post_map where firebase_path = p_path;
  if existing is not null then return existing; end if;
  insert into public.posts (author_id, body, parent_id, visibility, created_at, updated_at)
  values (p_author_id, p_body, p_parent_id, 'public', p_created_at, p_created_at)
  returning id into new_id;
  insert into legacy.post_map (firebase_path, post_id, kind, raw_meta) values (p_path, new_id, p_kind, coalesce(p_raw_meta, '{}'::jsonb));
  return new_id;
end $$;

-- Media row + map row, atomically (the Storage object is uploaded first). True if created.
create function public.legacy_import_media(
  p_source_key text, p_post_id uuid, p_owner_id uuid, p_position smallint, p_storage_path text, p_mime_type text,
  p_width integer, p_height integer, p_byte_size bigint, p_created_at timestamptz, p_sha256 text
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  media uuid;
begin
  if exists (select 1 from legacy.media_map where source_key = p_source_key) then return false; end if;
  insert into public.post_media (post_id, owner_id, position, kind, bucket, storage_path, mime_type, width, height, byte_size, created_at)
  values (p_post_id, p_owner_id, p_position, 'image', 'post-media', p_storage_path, p_mime_type, p_width, p_height, p_byte_size, p_created_at)
  on conflict (bucket, storage_path) do update set byte_size = excluded.byte_size
  returning id into media;
  insert into legacy.media_map (source_key, media_id, sha256) values (p_source_key, media, p_sha256);
  return true;
end $$;

-- Batches. Each returns how many rows were newly inserted.
create function public.legacy_import_likes(p_rows jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  insert into public.post_likes (user_id, post_id, created_at)
  select r.user_id, r.post_id, r.created_at
  from jsonb_to_recordset(p_rows) as r(user_id uuid, post_id uuid, created_at timestamptz)
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

create function public.legacy_import_follows(p_rows jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  insert into public.follows (follower_id, followee_id, created_at)
  select r.follower_id, r.followee_id, coalesce(r.created_at, now())
  from jsonb_to_recordset(p_rows) as r(follower_id uuid, followee_id uuid, created_at timestamptz)
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

create function public.legacy_import_archives(p_reactions jsonb, p_saved jsonb, p_chat jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a integer; b integer; c integer;
begin
  insert into legacy.reaction_archive (firebase_post_path, firebase_uid, kind, user_id, post_id)
  select r.post_path, r.uid, r.kind, r.user_id, r.post_id
  from jsonb_to_recordset(p_reactions) as r(post_path text, uid text, kind text, user_id uuid, post_id uuid)
  on conflict do nothing;
  get diagnostics a = row_count;
  insert into legacy.saved_post_archive (firebase_post_path, firebase_uid, user_id, post_id)
  select r.post_path, r.uid, r.user_id, r.post_id
  from jsonb_to_recordset(p_saved) as r(post_path text, uid text, user_id uuid, post_id uuid)
  on conflict do nothing;
  get diagnostics b = row_count;
  insert into legacy.global_chat_archive (firebase_id, firebase_uid, user_id, author_name, body, created_at)
  select r.id, r.uid, r.user_id, r.author_name, r.body, r.created_at
  from jsonb_to_recordset(p_chat) as r(id text, uid text, user_id uuid, author_name text, body text, created_at timestamptz)
  on conflict do nothing;
  get diagnostics c = row_count;
  return jsonb_build_object('reactions', a, 'saved', b, 'chat', c);
end $$;

create function public.legacy_run_start(p_source text, p_extracted_at timestamptz) returns bigint
language sql security definer set search_path = '' as $$
  insert into legacy.migration_runs (snapshot_source, snapshot_extracted_at) values (p_source, p_extracted_at) returning id;
$$;

create function public.legacy_run_finish(p_id bigint, p_summary jsonb) returns void
language sql security definer set search_path = '' as $$
  update legacy.migration_runs set finished_at = now(), summary = p_summary where id = p_id;
$$;

-- Everything the validator needs, in one read-only call.
create function public.legacy_validation_snapshot() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'users', coalesce((select jsonb_agg(jsonb_build_object(
        'firebase_uid', m.firebase_uid, 'user_id', m.user_id, 'link_method', m.link_method,
        'username', p.username, 'display_name', p.display_name))
      from legacy.user_map m left join public.profiles p on p.id = m.user_id), '[]'::jsonb),
    'posts', coalesce((select jsonb_agg(jsonb_build_object(
        'path', pm.firebase_path, 'kind', pm.kind, 'post_id', po.id, 'author_id', po.author_id, 'body', po.body,
        'created_at', po.created_at, 'like_count', po.like_count, 'reply_count', po.reply_count,
        'parent_id', po.parent_id, 'deleted', po.deleted_at is not null,
        'media', (select count(*) from public.post_media x where x.post_id = po.id)))
      from legacy.post_map pm join public.posts po on po.id = pm.post_id), '[]'::jsonb),
    'media', coalesce((select jsonb_agg(jsonb_build_object(
        'source_key', mm.source_key, 'sha256', mm.sha256, 'bucket', x.bucket, 'storage_path', x.storage_path))
      from legacy.media_map mm join public.post_media x on x.id = mm.media_id), '[]'::jsonb),
    'likes_on_migrated_posts', (select count(*) from public.post_likes l join legacy.post_map m on m.post_id = l.post_id where m.kind = 'post'),
    'follows_between_migrated', (select count(*) from public.follows f
        join legacy.user_map a on a.user_id = f.follower_id join legacy.user_map b on b.user_id = f.followee_id),
    'chat_archive', (select count(*) from legacy.global_chat_archive),
    'bad_like_counts', (select count(*) from public.posts p
        where p.like_count <> (select count(*) from public.post_likes l where l.post_id = p.id)),
    'bad_reply_counts', (select count(*) from public.posts p
        where p.reply_count <> (select count(*) from public.posts c where c.parent_id = p.id and c.deleted_at is null)),
    'bad_follow_counts', (select count(*) from public.profiles pr
        where pr.follower_count <> (select count(*) from public.follows f where f.followee_id = pr.id)
           or pr.following_count <> (select count(*) from public.follows f where f.follower_id = pr.id)),
    'duplicate_emails', (select count(*) from (select lower(email) from auth.users where email is not null group by 1 having count(*) > 1) d),
    'missing_profiles', (select count(*) from legacy.user_map m left join public.profiles p on p.id = m.user_id where p.id is null)
  );
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'legacy_state()', 'legacy_find_auth_user(text)', 'legacy_map_user(text, uuid, text, text, timestamptz)',
    'legacy_import_post(text, text, uuid, text, uuid, timestamptz, jsonb)',
    'legacy_import_media(text, uuid, uuid, smallint, text, text, integer, integer, bigint, timestamptz, text)',
    'legacy_import_likes(jsonb)', 'legacy_import_follows(jsonb)', 'legacy_import_archives(jsonb, jsonb, jsonb)',
    'legacy_run_start(text, timestamptz)', 'legacy_run_finish(bigint, jsonb)', 'legacy_validation_snapshot()'
  ] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
