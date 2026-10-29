-- =============================================================================
-- Media release (additive; on top of 20261028090000 safety hardening 1b)
--
-- Files leave the bucket only through media_cleanup_queue (trigger
-- media_objects_cleanup: removing a registry row queues its file). This closes
-- the gaps where a file was no longer used but never released:
--
-- 1. Deleted posts: delete_post() releases the post's photos (their smaller
--    copies follow through variant_of ... on delete cascade).
-- 2. Admin takedowns keep the photos for review: admin_remove_post() records
--    taken_down_at and releases nothing. Admins can still see those photos
--    (media_readable). They're released by the daily clean-up once
--    media_takedown_retention() has passed, unless a report on the post is open
--    or an admin has put a hold on it (admin_set_removed_media_hold, audit-logged).
--    Deleting the author's account still removes everything at once.
-- 3. Unsending a message: dm_unsend(p_id, p_media) also releases the photos the
--    sender names, but only their own uploads in that conversation (at most 10).
--    The server can't see which file a message holds (it's encrypted); the app
--    sends the paths it decrypted. Older apps leave p_media out.
-- 4. Expired Moments: moments_sweep() no longer writes 'moment-media' queue rows.
--    Since the media registry, deleting a Moment already queues its file as 'r2'
--    (moments_release_upload), and nothing processes 'moment-media'. Old rows are
--    left as they are; media_requeue_legacy_moment_media() moves the ones that
--    are R2 Moment keys no longer in use to 'r2', when an operator runs it.
-- 5. Unused uploads (never attached within a day) are released for everyone by
--    the daily clean-up, not only when the same person uploads again.
-- 6. The daily clean-up (api/media-cleanup.ts, Vercel Cron) connects as the
--    login-less role media_janitor (an operator gives it a login). That role may
--    run media_janitor_release/_take/_done and nothing else; signed-in and
--    signed-out users can't run those. Leasing is shared with the upload route's
--    media_cleanup_take/_done (server secret), so the two never take the same file.
-- =============================================================================

-- ------------------------------------------------------- 1, 2. posts

alter table public.posts
  add column taken_down_at timestamptz,
  add column media_hold_note text check (media_hold_note is null or char_length(media_hold_note) between 1 and 300);

-- How long a taken-down post's photos are kept for review.
create function public.media_takedown_retention() returns interval
language sql immutable set search_path = '' as $$ select interval '30 days' $$;

-- Releases a post's photos (originals; their smaller copies cascade). Internal.
create function public.media_release_post(p_post uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  delete from public.media_objects o
   using public.post_media pm
   where pm.post_id = p_post and o.path = pm.storage_path and o.purpose = 'post' and o.variant_of is null;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.delete_post(p_post_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.posts
     set deleted_at = now()
   where id = p_post_id
     and author_id = (select auth.uid())
     and deleted_at is null;
  if not found then
    raise exception 'post not found' using errcode = 'P0002';
  end if;
  perform public.media_release_post(p_post_id);
end $$;

-- Takes a post (or reply) down for everyone; its open reports are closed. Its photos are kept for review.
create or replace function public.admin_remove_post(p_post uuid, p_note text default '') returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_admin();
  who text;
begin
  update public.posts set deleted_at = now(), taken_down_at = now() where id = p_post and deleted_at is null
  returning (select username from public.profiles where id = author_id) into who;
  if who is null then raise exception 'no such post' using errcode = 'SP005'; end if;
  update public.content_reports set status = 'reviewed', reviewed_by = uid, reviewed_at = now()
   where target_type = 'post' and target_id = p_post and status = 'open';
  perform public.admin_log('post.remove', 'post', p_post,
    format('removed a post by @%s%s', who, coalesce(' — ' || nullif(btrim(p_note), ''), '')));
end $$;

-- Keeps a taken-down post's photos past the retention period (a note, e.g. "appeal" or "legal request"),
-- or lets them go again (empty note). Admins only, audit-logged.
create function public.admin_set_removed_media_hold(p_post uuid, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  perform public.support_require_admin();
  if char_length(note) > 300 then raise exception 'note too long' using errcode = 'SP006'; end if;
  update public.posts set media_hold_note = note where id = p_post and taken_down_at is not null;
  if not found then raise exception 'not a taken-down post' using errcode = 'SP005'; end if;
  perform public.admin_log(case when note is null then 'post.media_hold_released' else 'post.media_hold' end, 'post', p_post,
    case when note is null then 'released the hold on a removed post''s photos' else format('held a removed post''s photos — %s', note) end);
end $$;

-- Admins can also see a taken-down post's photos (while they're kept). Otherwise unchanged.
create or replace function public.media_readable(p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is not null and exists (
    select 1 from public.media_objects o
     where o.path = p_path and o.variant_of is null
       and (o.owner_id = (select auth.uid())
            or (o.purpose = 'avatar' and o.status = 'attached')
            or (o.purpose = 'post' and exists (
                  select 1 from public.post_media pm join public.posts p on p.id = pm.post_id
                   where pm.storage_path = o.path and p.deleted_at is null and public.can_view_post(p.id)))
            or (o.purpose = 'post' and public.is_admin() and exists (
                  select 1 from public.post_media pm join public.posts p on p.id = pm.post_id
                   where pm.storage_path = o.path and p.taken_down_at is not null))
            or (o.purpose = 'moment' and public.moment_media_readable(o.path))
            or (o.purpose = 'dm' and exists (
                  select 1 from public.dm_participants dp
                   where dp.conversation_id = o.conversation_id and dp.user_id = (select auth.uid())))))
$$;

-- ------------------------------------------------------- 3. unsend

drop function public.dm_unsend(uuid);
create function public.dm_unsend(p_id uuid, p_media text[] default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  conv uuid;
begin
  if uid is null then raise exception 'sign in first' using errcode = 'DM001'; end if;
  delete from public.dm_messages m where m.id = p_id and m.sender_id = uid returning m.conversation_id into conv;
  if conv is null then raise exception 'no such message' using errcode = 'DM006'; end if;
  insert into public.dm_tombstones (message_id, conversation_id) values (p_id, conv) on conflict do nothing;
  update public.dm_conversations c
     set changed_at = now(),
         last_message_at = (select max(x.created_at) from public.dm_messages x where x.conversation_id = conv and x.relates_to is null)
   where c.id = conv;
  -- The message's photos: only your own uploads, in this conversation.
  if p_media is not null then
    delete from public.media_objects o
     where o.path = any (p_media[1:10]) and o.owner_id = uid and o.purpose = 'dm' and o.conversation_id = conv;
  end if;
end $$;
revoke execute on function public.dm_unsend(uuid, text[]) from public, anon;
grant execute on function public.dm_unsend(uuid, text[]) to authenticated;

-- ------------------------------------------------------- 4. expired Moments

create or replace function public.moments_sweep() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  -- Their files are queued by moments_release_upload (one 'r2' row each).
  delete from public.moments where expires_at < now() - interval '1 hour';
  get diagnostics n = row_count;
  return n;
end $$;

-- Moves old 'moment-media' rows that are R2 Moment keys no longer in use to 'r2'. Others are left alone.
-- Run once by an operator; answers how many moved and how many were left.
create function public.media_requeue_legacy_moment_media() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare moved integer; left_over integer;
begin
  update public.media_cleanup_queue q
     set bucket = 'r2', reason = 'expired Moment (requeued)', claimed_at = null, claim_token = null, attempts = 0
   where q.bucket = 'moment-media'
     and q.path ~ '^[0-9a-f-]{36}/moment/[0-9a-f]{32}\.[a-z]+$'
     and not exists (select 1 from public.media_objects o where o.path = q.path);
  get diagnostics moved = row_count;
  select count(*) into left_over from public.media_cleanup_queue where bucket = 'moment-media';
  return jsonb_build_object('moved', moved, 'left', left_over);
end $$;

-- ------------------------------------------------------- 5. due releases

-- Taken-down photos past retention (no hold, no open report) and unused uploads over a day old. Internal.
create function public.media_release_due(p_limit integer default 50) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  lim integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  r record;
  takedown integer := 0;
  stale integer;
begin
  for r in
    select p.id from public.posts p
     where p.taken_down_at < now() - public.media_takedown_retention()
       and p.media_hold_note is null
       and not exists (select 1 from public.content_reports c where c.target_type = 'post' and c.target_id = p.id and c.status = 'open')
       and exists (select 1 from public.post_media pm join public.media_objects o on o.path = pm.storage_path where pm.post_id = p.id)
     order by p.taken_down_at
     limit lim
  loop
    takedown := takedown + public.media_release_post(r.id);
  end loop;
  delete from public.media_objects o
   where o.path in (select s.path from public.media_objects s
                     where s.status = 'pending' and s.purpose <> 'dm' and s.variant_of is null
                       and s.created_at < now() - interval '1 day'
                     order by s.created_at limit lim
                     for update skip locked);
  get diagnostics stale = row_count;
  return jsonb_build_object('takedown', takedown, 'stale', stale);
end $$;

-- ------------------------------------------------------- 6. leasing, shared

-- The leasing rules of 1b's media_cleanup_take / _done, moved here unchanged so the
-- upload route (server secret) and the daily clean-up (media_janitor) share them.
create function public.media_cleanup_lease(p_limit integer default 5)
returns table (item_id bigint, item_path text, claim uuid)
language plpgsql security definer set search_path = '' as $$
declare
  t uuid := gen_random_uuid();
begin
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

create function public.media_cleanup_confirm(p_items jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  n integer;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 20 then
    raise exception 'invalid items' using errcode = '22023';
  end if;
  delete from public.media_cleanup_queue q
   using jsonb_to_recordset(p_items) as i(id bigint, claim uuid)
   where q.id = i.id and q.claim_token = i.claim;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.media_cleanup_take(p_key text, p_limit integer default 5)
returns table (item_id bigint, item_path text, claim uuid)
language plpgsql security definer set search_path = '' as $$
begin
  perform public.push_require_server(p_key);
  return query select * from public.media_cleanup_lease(p_limit);
end $$;

create or replace function public.media_cleanup_done(p_key text, p_items jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
begin
  perform public.push_require_server(p_key);
  return public.media_cleanup_confirm(p_items);
end $$;

-- The daily clean-up's role: these three functions and nothing else.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'media_janitor') then
    create role media_janitor nologin;
  end if;
end $$;
grant usage on schema public to media_janitor;

create function public.media_janitor_release() returns jsonb
language sql security definer set search_path = '' as $$ select public.media_release_due(50) $$;

create function public.media_janitor_take(p_limit integer default 20)
returns table (item_id bigint, item_path text, claim uuid)
language sql security definer set search_path = '' as $$ select * from public.media_cleanup_lease(p_limit) $$;

create function public.media_janitor_done(p_items jsonb) returns integer
language sql security definer set search_path = '' as $$ select public.media_cleanup_confirm(p_items) $$;

revoke execute on function
  public.media_takedown_retention(), public.media_release_post(uuid), public.media_requeue_legacy_moment_media(),
  public.media_release_due(integer), public.media_cleanup_lease(integer), public.media_cleanup_confirm(jsonb),
  public.media_janitor_release(), public.media_janitor_take(integer), public.media_janitor_done(jsonb),
  public.admin_set_removed_media_hold(uuid, text)
from public, anon, authenticated;
grant execute on function public.admin_set_removed_media_hold(uuid, text) to authenticated;
grant execute on function public.media_janitor_release(), public.media_janitor_take(integer), public.media_janitor_done(jsonb) to media_janitor;
-- media_cleanup_take / _done keep their grants (create or replace).
