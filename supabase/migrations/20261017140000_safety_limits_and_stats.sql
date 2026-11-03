-- =============================================================================
-- Safety limits, blocking side-effects, warnings and platform stats (additive)
--
--   Rate limits     generous per-person caps that only stop floods and scripts
--                   (RL001): posts+replies 30 / 10 min and 300 / day, likes
--                   300 / hour, follows 100 / hour, messages 60 / minute.
--   Blocking        blocking someone removes follows both ways, and neither
--                   person can follow the other while the block stands.
--                   my_blocked_accounts() lists who you blocked.
--   Warnings        admins can warn an account (audit-logged); the person sees
--                   it until they acknowledge it.
--   Stats           admin_platform_stats(): aggregate counts only — never
--                   message content, never per-person activity.
-- =============================================================================

create index post_likes_user_created on public.post_likes (user_id, created_at desc);
create index follows_follower_created on public.follows (follower_id, created_at desc);
create index dm_messages_sender_created on public.dm_messages (sender_id, created_at desc);

-- ------------------------------------------------------------ rate limits

create function public.rate_limit_check() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  n integer;
begin
  -- Service/admin paths without a signed-in user aren't limited.
  if uid is null then return new; end if;
  if tg_table_name = 'posts' then
    select count(*) into n from public.posts where author_id = uid and created_at > now() - interval '10 minutes';
    if n >= 30 then raise exception 'slow down: too many posts' using errcode = 'RL001'; end if;
    select count(*) into n from public.posts where author_id = uid and created_at > now() - interval '1 day';
    if n >= 300 then raise exception 'daily post limit reached' using errcode = 'RL001'; end if;
  elsif tg_table_name = 'post_likes' then
    select count(*) into n from public.post_likes where user_id = uid and created_at > now() - interval '1 hour';
    if n >= 300 then raise exception 'slow down: too many likes' using errcode = 'RL001'; end if;
  elsif tg_table_name = 'follows' then
    select count(*) into n from public.follows where follower_id = uid and created_at > now() - interval '1 hour';
    if n >= 100 then raise exception 'slow down: too many follows' using errcode = 'RL001'; end if;
  elsif tg_table_name = 'dm_messages' then
    select count(*) into n from public.dm_messages where sender_id = uid and created_at > now() - interval '1 minute';
    if n >= 60 then raise exception 'slow down: too many messages' using errcode = 'RL001'; end if;
  end if;
  return new;
end $$;

create trigger posts_rate_limit before insert on public.posts for each row execute function public.rate_limit_check();
create trigger post_likes_rate_limit before insert on public.post_likes for each row execute function public.rate_limit_check();
create trigger follows_rate_limit before insert on public.follows for each row execute function public.rate_limit_check();
create trigger dm_messages_rate_limit before insert on public.dm_messages for each row execute function public.rate_limit_check();

-- --------------------------------------------------------------- blocking

create function public.blocks_drop_follows() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.follows
   where (follower_id = new.blocker_id and followee_id = new.blocked_id)
      or (follower_id = new.blocked_id and followee_id = new.blocker_id);
  return null;
end $$;
create trigger user_blocks_drop_follows after insert on public.user_blocks
  for each row execute function public.blocks_drop_follows();

create function public.follows_refuse_blocked() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if public.dm_blocked_between(new.follower_id, new.followee_id) then
    raise exception 'can''t follow this account' using errcode = 'BL001';
  end if;
  return new;
end $$;
create trigger follows_refuse_blocked before insert on public.follows
  for each row execute function public.follows_refuse_blocked();

-- Remove follows that existed before this migration between blocked pairs.
delete from public.follows f using public.user_blocks b
 where (f.follower_id = b.blocker_id and f.followee_id = b.blocked_id)
    or (f.follower_id = b.blocked_id and f.followee_id = b.blocker_id);

create function public.my_blocked_accounts() returns table (
  user_id uuid, username text, display_name text, avatar_url text, blocked_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select p.id, p.username, p.display_name, p.avatar_url, b.created_at
    from public.user_blocks b join public.profiles p on p.id = b.blocked_id
   where b.blocker_id = (select auth.uid())
   order by b.created_at desc
   limit 1000
$$;

-- --------------------------------------------------------------- warnings

create table public.account_warnings (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles (id) on delete cascade,
  message          text not null check (char_length(btrim(message)) between 3 and 500),
  issued_by        uuid references public.profiles (id) on delete set null,
  issued_at        timestamptz not null default now(),
  acknowledged_at  timestamptz
);
create index account_warnings_user on public.account_warnings (user_id, issued_at desc);
revoke all on public.account_warnings from anon, authenticated;
alter table public.account_warnings enable row level security;

create function public.admin_warn_user(p_user uuid, p_message text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_admin();
  handle text := (select username from public.profiles where id = p_user);
begin
  if handle is null then raise exception 'no such user' using errcode = 'SP005'; end if;
  if char_length(btrim(coalesce(p_message, ''))) < 3 then raise exception 'add a message' using errcode = 'SP006'; end if;
  insert into public.account_warnings (user_id, message, issued_by) values (p_user, left(btrim(p_message), 500), uid);
  perform public.admin_log('account.warn', 'profile', p_user, format('warned @%s — %s', handle, btrim(p_message)));
end $$;

create function public.my_warnings() returns table (id uuid, message text, issued_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select w.id, w.message, w.issued_at from public.account_warnings w
   where w.user_id = (select auth.uid()) and w.acknowledged_at is null
   order by w.issued_at desc limit 5
$$;

create function public.acknowledge_warning(p_warning uuid) returns void
language sql security definer set search_path = '' as $$
  update public.account_warnings set acknowledged_at = now()
   where id = p_warning and user_id = (select auth.uid()) and acknowledged_at is null
$$;

-- ------------------------------------------------------------------ stats

create function public.admin_platform_stats() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.support_require_admin();
  return jsonb_build_object(
    'users', (select count(*) from public.profiles),
    'users_verified_email', (select count(*) from app_auth.users where email_confirmed_at is not null),
    'new_users_24h', (select count(*) from public.profiles where created_at > now() - interval '1 day'),
    'new_users_7d', (select count(*) from public.profiles where created_at > now() - interval '7 days'),
    -- "Active": did something that writes (posted, liked, followed, messaged) — a lower bound.
    'active_24h', (select count(distinct u) from (
        select author_id u from public.posts where created_at > now() - interval '1 day'
        union all select user_id from public.post_likes where created_at > now() - interval '1 day'
        union all select follower_id from public.follows where created_at > now() - interval '1 day'
        union all select sender_id from public.dm_messages where created_at > now() - interval '1 day') a),
    'posts_24h', (select count(*) from public.posts where parent_id is null and created_at > now() - interval '1 day'),
    'replies_24h', (select count(*) from public.posts where parent_id is not null and created_at > now() - interval '1 day'),
    'messages_24h', (select count(*) from public.dm_messages where relates_to is null and created_at > now() - interval '1 day'),
    'world_joins_7d', (select count(*) from public.world_members where joined_at > now() - interval '7 days'),
    'support_submissions_7d', (select count(*) from public.support_requests where created_at > now() - interval '7 days'),
    'open_reports', (select count(*) from public.content_reports where status = 'open')
                  + (select count(*) from public.dm_reports where status = 'open')
                  + (select count(*) from public.moment_reports where status = 'open'),
    'suspended', (select count(*) from public.account_suspensions where until is null or until > now())
  );
end $$;

revoke execute on function
  public.rate_limit_check(), public.blocks_drop_follows(), public.follows_refuse_blocked(),
  public.my_blocked_accounts(), public.admin_warn_user(uuid, text), public.my_warnings(),
  public.acknowledge_warning(uuid), public.admin_platform_stats()
from public, anon, authenticated;
grant execute on function
  public.my_blocked_accounts(), public.admin_warn_user(uuid, text), public.my_warnings(),
  public.acknowledge_warning(uuid), public.admin_platform_stats()
to authenticated;
