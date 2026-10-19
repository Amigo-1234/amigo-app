-- Admin control centre: real platform metrics, user search and detail, and
-- moderation notes. Additive only (new functions; no table or data changes).
-- Every function checks admin rights on the server (support_require_admin).
-- Nothing here reads message content, encrypted payloads or email addresses.
--
-- Undo: drop function public.admin_insights(), public.admin_user_search(text, int),
--       public.admin_user_detail(uuid), public.admin_add_note(text, uuid, text),
--       public.admin_target_history(uuid);

-- "Active" = signed-in people who did something that leaves a record: posted or
-- replied, liked, followed, sent a message, posted / viewed / reacted to a
-- Moment, joined a World or opened a Support Hub request. Reading the feed alone
-- leaves no record, so these are lower bounds.
create function public.admin_active_users(p_since timestamptz) returns bigint
language sql stable security definer set search_path = '' as $$
  select count(distinct u) from (
    select author_id u from public.posts where created_at > p_since
    union all select user_id from public.post_likes where created_at > p_since
    union all select follower_id from public.follows where created_at > p_since
    union all select sender_id from public.dm_messages where created_at > p_since
    union all select author_id from public.moments where created_at > p_since
    union all select viewer_id from public.moment_views where viewed_at > p_since
    union all select user_id from public.moment_reactions where created_at > p_since
    union all select user_id from public.world_members where joined_at > p_since
    union all select creator_id from public.support_requests where created_at > p_since) a
$$;

create function public.admin_insights() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.support_require_admin();
  return jsonb_build_object(
    'generated_at', now(),
    'users', (select count(*) from public.profiles),
    'users_verified_email', (select count(*) from auth.users where email_confirmed_at is not null),
    'new_users_today', (select count(*) from public.profiles where created_at >= date_trunc('day', now())),
    'new_users_7d', (select count(*) from public.profiles where created_at > now() - interval '7 days'),
    'dau', public.admin_active_users(now() - interval '1 day'),
    'wau', public.admin_active_users(now() - interval '7 days'),
    'mau', public.admin_active_users(now() - interval '30 days'),
    'posts', (select count(*) from public.posts where parent_id is null and deleted_at is null),
    'replies', (select count(*) from public.posts where parent_id is not null and deleted_at is null),
    'posts_7d', (select count(*) from public.posts where parent_id is null and deleted_at is null and created_at > now() - interval '7 days'),
    'moments_live', (select count(*) from public.moments where removed_at is null and expires_at > now()),
    'moments_7d', (select count(*) from public.moments where created_at > now() - interval '7 days'),
    'worlds', (select count(*) from public.worlds where cancelled_at is null),
    'worlds_live', (select count(*) from public.worlds where cancelled_at is null and starts_at <= now() and ends_at > now()),
    'worlds_upcoming', (select count(*) from public.worlds where cancelled_at is null and starts_at > now()),
    'support_requests', (select count(*) from public.support_requests),
    'support_open', (select count(*) from public.support_requests where status in ('pending', 'active')),
    'reports_open', (select count(*) from public.content_reports where status = 'open')
                  + (select count(*) from public.dm_reports where status = 'open')
                  + (select count(*) from public.moment_reports where status = 'open'),
    'moderation_actions_7d', (select count(*) from public.admin_audit_log where created_at > now() - interval '7 days'),
    'suspended', (select count(*) from public.account_suspensions where until is null or until > now()),
    'admins', (select count(*) from public.app_admins),
    -- One row per day for the last 14 days (UTC), oldest first.
    'daily', (select jsonb_agg(jsonb_build_object(
                 'day', d::date,
                 'signups', (select count(*) from public.profiles where created_at >= d and created_at < d + interval '1 day'),
                 'posts', (select count(*) from public.posts where parent_id is null and created_at >= d and created_at < d + interval '1 day'),
                 'active', (select count(distinct u) from (
                    select author_id u from public.posts where created_at >= d and created_at < d + interval '1 day'
                    union all select user_id from public.post_likes where created_at >= d and created_at < d + interval '1 day'
                    union all select follower_id from public.follows where created_at >= d and created_at < d + interval '1 day'
                    union all select sender_id from public.dm_messages where created_at >= d and created_at < d + interval '1 day'
                    union all select author_id from public.moments where created_at >= d and created_at < d + interval '1 day'
                    union all select viewer_id from public.moment_views where viewed_at >= d and viewed_at < d + interval '1 day'
                    union all select user_id from public.moment_reactions where created_at >= d and created_at < d + interval '1 day'
                    union all select user_id from public.world_members where joined_at >= d and joined_at < d + interval '1 day'
                    union all select creator_id from public.support_requests where created_at >= d and created_at < d + interval '1 day') a))
               order by d)
              from generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') d),
    'recent_users', (select coalesce(jsonb_agg(r), '[]') from (
        select id, username, display_name, avatar_url, created_at from public.profiles order by created_at desc limit 8) r)
  );
end $$;

-- Search people by handle or name (empty query: newest first).
create function public.admin_user_search(p_query text, p_limit int default 20)
returns table (id uuid, username text, display_name text, avatar_url text, created_at timestamptz,
               post_count int, follower_count int, email_verified boolean, is_admin boolean,
               suspended boolean, suspended_until timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare q text := lower(btrim(coalesce(p_query, ''), ' @'));
begin
  perform public.support_require_admin();
  q := replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_');
  return query
    select p.id, p.username, p.display_name, p.avatar_url, p.created_at, p.post_count, p.follower_count,
           u.email_confirmed_at is not null,
           exists (select 1 from public.app_admins a where a.user_id = p.id),
           s.user_id is not null, s.until
      from public.profiles p
      left join auth.users u on u.id = p.id
      left join public.account_suspensions s on s.user_id = p.id and (s.until is null or s.until > now())
     where q = '' or lower(p.username) like q || '%' or lower(p.display_name) like '%' || q || '%'
     order by (lower(p.username) = q) desc, p.created_at desc
     limit least(greatest(coalesce(p_limit, 20), 1), 50);
end $$;

-- One person's account at a glance: activity counts, standing, reports and admin history.
create function public.admin_user_detail(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare p public.profiles;
begin
  perform public.support_require_admin();
  select * into p from public.profiles where id = p_user;
  if p.id is null then raise exception 'no such account' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'id', p.id, 'username', p.username, 'display_name', p.display_name, 'avatar_url', p.avatar_url,
    'bio', p.bio, 'created_at', p.created_at,
    'email_verified', exists (select 1 from auth.users u where u.id = p.id and u.email_confirmed_at is not null),
    'is_admin', exists (select 1 from public.app_admins a where a.user_id = p.id),
    'posts', (select count(*) from public.posts where author_id = p.id and parent_id is null and deleted_at is null),
    'replies', (select count(*) from public.posts where author_id = p.id and parent_id is not null and deleted_at is null),
    'followers', p.follower_count, 'following', p.following_count,
    'likes_given', (select count(*) from public.post_likes where user_id = p.id),
    'moments_30d', (select count(*) from public.moments where author_id = p.id and created_at > now() - interval '30 days'),
    'last_active', (select max(t) from (
        select max(created_at) t from public.posts where author_id = p.id
        union all select max(created_at) from public.post_likes where user_id = p.id
        union all select max(created_at) from public.dm_messages where sender_id = p.id
        union all select max(created_at) from public.moments where author_id = p.id
        union all select max(viewed_at) from public.moment_views where viewer_id = p.id) a),
    'suspension', (select jsonb_build_object('reason', s.reason, 'since', s.suspended_at, 'until', s.until)
                     from public.account_suspensions s where s.user_id = p.id and (s.until is null or s.until > now())),
    'warnings', (select coalesce(jsonb_agg(jsonb_build_object('message', w.message, 'at', w.issued_at, 'acknowledged', w.acknowledged_at is not null) order by w.issued_at desc), '[]')
                   from public.account_warnings w where w.user_id = p.id),
    'reports_against', jsonb_build_object(
        'posts', (select count(*) from public.content_reports r join public.posts x on x.id = r.target_id where r.target_type = 'post' and x.author_id = p.id),
        'profile', (select count(*) from public.content_reports r where r.target_type in ('profile', 'user') and r.target_id = p.id),
        'messages', (select count(*) from public.dm_reports r where r.reported_id = p.id),
        'moments', (select count(*) from public.moment_reports r join public.moments m on m.id = r.moment_id where m.author_id = p.id),
        'open', (select count(*) from public.content_reports r left join public.posts x on x.id = r.target_id
                  where r.status = 'open' and ((r.target_type = 'post' and x.author_id = p.id) or (r.target_type in ('profile', 'user') and r.target_id = p.id)))
              + (select count(*) from public.dm_reports r where r.status = 'open' and r.reported_id = p.id)
              + (select count(*) from public.moment_reports r join public.moments m on m.id = r.moment_id where r.status = 'open' and m.author_id = p.id)),
    'reports_made', (select count(*) from public.content_reports where reporter_id = p.id)
                  + (select count(*) from public.dm_reports where reporter_id = p.id)
                  + (select count(*) from public.moment_reports where reporter_id = p.id)
  );
end $$;

-- A moderation note on a person, a report or a piece of content (kept in the audit log).
create function public.admin_add_note(p_target_type text, p_target uuid, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.support_require_admin();
  if p_target_type not in ('user', 'post', 'moment', 'post_report', 'dm_report', 'moment_report', 'support_request', 'world') then
    raise exception 'unknown target' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_note, ''))) not between 1 and 1000 then
    raise exception 'a note needs 1 to 1000 characters' using errcode = '22023';
  end if;
  perform public.admin_log('note', p_target_type, p_target, btrim(p_note));
end $$;

-- Everything admins did to or noted about one target, newest first.
create function public.admin_target_history(p_target uuid)
returns table (id uuid, admin_username text, action text, target_type text, summary text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.support_require_admin();
  return query
    select l.id, a.username, l.action, l.target_type, l.summary, l.created_at
      from public.admin_audit_log l left join public.profiles a on a.id = l.admin_id
     where l.target_id = p_target
     order by l.created_at desc
     limit 100;
end $$;

revoke execute on function
  public.admin_active_users(timestamptz), public.admin_insights(), public.admin_user_search(text, int),
  public.admin_user_detail(uuid), public.admin_add_note(text, uuid, text), public.admin_target_history(uuid)
from public, anon, authenticated;
grant execute on function
  public.admin_insights(), public.admin_user_search(text, int), public.admin_user_detail(uuid),
  public.admin_add_note(text, uuid, text), public.admin_target_history(uuid)
to authenticated;
