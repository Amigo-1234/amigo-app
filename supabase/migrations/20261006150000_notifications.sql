-- =============================================================================
-- Amigo World — notifications
--
-- Additive only: one enum, one table, trigger functions, two RPCs, policies
-- and grants. Nothing existing is altered or dropped.
--
-- Who writes notifications: only the database. AFTER INSERT triggers on
-- follows, post_likes and posts (SECURITY DEFINER) insert rows. Clients have
-- no INSERT/DELETE grant on the table, so notifications cannot be forged.
--
-- The actor is always the signed-in person who performed the action
-- (auth.uid() must equal the follower / liker / author). Writes without a
-- signed-in actor — the service-role legacy import — create no notifications,
-- so migrating history doesn't flood anyone's inbox.
--
-- Kinds today: follow, like, reply, mention. Future kinds (repost, message,
-- moment, system) are added later with `alter type ... add value`, plus a
-- nullable reference column where needed. No rows exist for them yet.
-- =============================================================================

create type public.notification_kind as enum ('follow', 'like', 'reply', 'mention');

create table public.notifications (
  id            uuid primary key default gen_random_uuid(),
  recipient_id  uuid not null references public.profiles (id) on delete cascade,
  actor_id      uuid not null references public.profiles (id) on delete cascade,
  kind          public.notification_kind not null,
  -- like: the liked post. reply: the new reply. mention: the post that mentions. follow: null.
  post_id       uuid references public.posts (id) on delete cascade,
  created_at    timestamptz not null default now(),
  read_at       timestamptz,
  constraint notifications_not_self check (recipient_id <> actor_id),
  constraint notifications_post_matches_kind check ((kind = 'follow') = (post_id is null))
);

-- One row per (recipient, actor, kind, post): like → unlike → like and
-- follow → unfollow → follow never produce a second notification.
create unique index notifications_dedupe_key
  on public.notifications (recipient_id, actor_id, kind, post_id) nulls not distinct;
-- The inbox, newest first.
create index notifications_inbox_idx on public.notifications (recipient_id, created_at desc, id desc);
-- The unread badge.
create index notifications_unread_idx on public.notifications (recipient_id) where read_at is null;
-- Cascading deletes of actors and posts.
create index notifications_actor_idx on public.notifications (actor_id);
create index notifications_post_idx on public.notifications (post_id) where post_id is not null;

comment on table public.notifications is
  'Written only by triggers. A recipient sees a row only while it is still true (the like/follow exists, the post is visible).';

-- ---------------------------------------------------------------- helpers

-- Can p_viewer (not necessarily the current user) see this post? Used by
-- triggers to avoid notifying someone about a post they cannot open.
create function public.profile_can_view_post(p_viewer uuid, p_post_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.posts p
    where p.id = p_post_id
      and p.deleted_at is null
      and (
        p.visibility = 'public'
        or p.author_id = p_viewer
        or exists (select 1 from public.follows f where f.follower_id = p_viewer and f.followee_id = p.author_id)
      )
  );
$$;

-- Inserts one notification unless it's a self-notification or a duplicate.
create function public.notify(p_recipient uuid, p_actor uuid, p_kind public.notification_kind, p_post uuid)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_recipient is null or p_actor is null or p_recipient = p_actor then
    return;
  end if;
  insert into public.notifications (recipient_id, actor_id, kind, post_id)
  values (p_recipient, p_actor, p_kind, p_post)
  on conflict (recipient_id, actor_id, kind, post_id) do nothing;
end $$;

-- Usernames mentioned in a body: @name not preceded by a word character, @ or
-- '.', so email addresses don't count. Lower-cased, distinct, at most 10.
-- The client renders mentions with the same rule (src/features/posts/RichText.tsx).
create function public.mentioned_usernames(p_body text) returns text[]
language sql immutable set search_path = '' as $$
  select coalesce(array_agg(u order by first_at), '{}')
  from (
    select lower(m[1]) as u, min(ord) as first_at
    from regexp_matches(coalesce(p_body, ''), '(?:^|[^A-Za-z0-9_@.])@([A-Za-z0-9_]{3,24})(?![A-Za-z0-9_])', 'g')
      with ordinality as r(m, ord)
    group by lower(m[1])
    order by min(ord)
    limit 10
  ) s;
$$;

-- ---------------------------------------------------------------- triggers

create function public.notify_on_follow() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.follower_id is distinct from (select auth.uid()) then return null; end if;
  perform public.notify(new.followee_id, new.follower_id, 'follow', null);
  return null;
end $$;

create trigger follows_notify after insert on public.follows
  for each row execute function public.notify_on_follow();

create function public.notify_on_like() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  owner uuid;
begin
  if new.user_id is distinct from (select auth.uid()) then return null; end if;
  select author_id into owner from public.posts where id = new.post_id and deleted_at is null;
  perform public.notify(owner, new.user_id, 'like', new.post_id);
  return null;
end $$;

create trigger post_likes_notify after insert on public.post_likes
  for each row execute function public.notify_on_like();

-- A new post or reply: the parent's author gets "replied"; everyone mentioned
-- who can see the post gets "mentioned" (unless they already got the reply).
create function public.notify_on_post() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  parent_author uuid;
  mentioned uuid;
begin
  if new.author_id is distinct from (select auth.uid()) or new.deleted_at is not null then return null; end if;

  if new.parent_id is not null then
    select author_id into parent_author from public.posts where id = new.parent_id;
    if public.profile_can_view_post(parent_author, new.id) then
      perform public.notify(parent_author, new.author_id, 'reply', new.id);
    end if;
  end if;

  for mentioned in
    select pr.id from public.profiles pr
    where pr.username = any (public.mentioned_usernames(new.body))
  loop
    if mentioned is distinct from parent_author and public.profile_can_view_post(mentioned, new.id) then
      perform public.notify(mentioned, new.author_id, 'mention', new.id);
    end if;
  end loop;
  return null;
end $$;

create trigger posts_notify after insert on public.posts
  for each row execute function public.notify_on_post();

-- ---------------------------------------------------------------- security

revoke all on public.notifications from anon, authenticated;
grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;

alter table public.notifications enable row level security;

-- Your own notifications only, and only while they are still true: a like or
-- follow that was undone, or a post that was deleted or is no longer visible
-- to you, hides the notification (and removes it from the unread count).
create policy "People read their own live notifications"
  on public.notifications for select
  to authenticated
  using (
    recipient_id = (select auth.uid())
    and case kind
      when 'like' then exists (
        select 1 from public.post_likes l where l.user_id = actor_id and l.post_id = notifications.post_id)
      when 'follow' then exists (
        select 1 from public.follows f where f.follower_id = actor_id and f.followee_id = recipient_id)
      else true
    end
    and (post_id is null or public.can_view_post(post_id))
  );

create policy "People mark their own notifications read"
  on public.notifications for update
  to authenticated
  using (recipient_id = (select auth.uid()))
  with check (recipient_id = (select auth.uid()));

-- No insert/delete policies or grants: only the triggers above write.

-- Marks the given notifications (or, with null, all of yours) as read.
-- SECURITY INVOKER: RLS limits it to your own rows. Returns how many changed.
create function public.mark_notifications_read(p_ids uuid[] default null) returns integer
language plpgsql security invoker set search_path = '' as $$
declare
  n integer;
begin
  if (select auth.uid()) is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  update public.notifications
     set read_at = now()
   where recipient_id = (select auth.uid())
     and read_at is null
     and (p_ids is null or id = any (p_ids));
  get diagnostics n = row_count;
  return n;
end $$;

-- Unread badge: a number, never the rows.
create function public.unread_notification_count() returns integer
language sql stable security invoker set search_path = '' as $$
  select count(*)::integer from public.notifications
  where recipient_id = (select auth.uid()) and read_at is null;
$$;

-- Explicit grants only (see 20261006140000_revoke_public_function_execute.sql).
revoke execute on function public.profile_can_view_post(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.notify(uuid, uuid, public.notification_kind, uuid) from public, anon, authenticated;
revoke execute on function public.mentioned_usernames(text) from public, anon, authenticated;
revoke execute on function public.notify_on_follow() from public, anon, authenticated;
revoke execute on function public.notify_on_like() from public, anon, authenticated;
revoke execute on function public.notify_on_post() from public, anon, authenticated;
revoke execute on function public.mark_notifications_read(uuid[]) from public, anon;
revoke execute on function public.unread_notification_count() from public, anon;
grant execute on function public.mark_notifications_read(uuid[]) to authenticated;
grant execute on function public.unread_notification_count() to authenticated;

-- =============================================================================
-- Realtime: new notifications reach the recipient's open tabs. Realtime
-- applies the SELECT policy above, so each person only receives their own.
-- =============================================================================
alter publication supabase_realtime add table public.notifications;
