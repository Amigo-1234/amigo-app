-- Blocking applies everywhere, not just in messages and follows.
--
-- Until now a block stopped direct messages and follows only: the blocked
-- person's posts, replies and likes still showed up, they could still reply
-- to, like or mention the person who blocked them, and those actions still
-- produced notifications. A block now works both ways across posts:
--   * neither side sees the other's posts or replies (feeds, profiles, threads,
--     search: everything that reads posts goes through the posts policy or
--     can_view_post);
--   * neither side can reply to, like, repost or bookmark the other's posts
--     (those writes already require can_view_post);
--   * neither side is notified about the other (new notifications are not
--     written, and existing ones are hidden while the block lasts);
--   * likes by a blocked person aren't listed on your posts.
-- Unblocking restores everything (nothing is deleted). Your own posts always
-- stay visible to you. Signed-out reads are unaffected (there is no viewer).
--
-- Additive: one new helper, replaces two helpers, notify(), and three policies.

-- Has the current viewer blocked this person, or been blocked by them?
-- Always false when signed out (there is no viewer) and for yourself. Readable
-- by signed-out visitors too, because the posts policy calls it for them.
create function public.viewer_blocked_with(p_other uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select auth.uid()) is not null
      and p_other is distinct from (select auth.uid())
      and public.dm_blocked_between((select auth.uid()), p_other),
    false);
$$;
revoke execute on function public.viewer_blocked_with(uuid) from public;
grant execute on function public.viewer_blocked_with(uuid) to anon, authenticated;

create or replace function public.can_view_post(p_post_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.posts p
    where p.id = p_post_id
      and p.deleted_at is null
      and (
        p.visibility = 'public'
        or p.author_id = (select auth.uid())
        or (p.visibility = 'followers' and public.viewer_follows(p.author_id))
      )
      and not public.viewer_blocked_with(p.author_id)
  );
$$;

-- Same rule for a given viewer (used by notification triggers).
create or replace function public.profile_can_view_post(p_viewer uuid, p_post_id uuid) returns boolean
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
      and (p.author_id = p_viewer or not public.dm_blocked_between(p_viewer, p.author_id))
  );
$$;

-- No notifications between people where either has blocked the other.
create or replace function public.notify(p_recipient uuid, p_actor uuid, p_kind public.notification_kind, p_post uuid)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_recipient is null or p_actor is null or p_recipient = p_actor then
    return;
  end if;
  if public.dm_blocked_between(p_recipient, p_actor) then
    return;
  end if;
  insert into public.notifications (recipient_id, actor_id, kind, post_id)
  values (p_recipient, p_actor, p_kind, p_post)
  on conflict (recipient_id, actor_id, kind, post_id) do nothing;
end $$;

drop policy "Visible posts can be read" on public.posts;
create policy "Visible posts can be read" on public.posts
  for select
  to anon, authenticated
  using (
    deleted_at is null
    and (
      visibility = 'public'
      or author_id = (select auth.uid())
      or (visibility = 'followers' and public.viewer_follows(author_id))
    )
    and not public.viewer_blocked_with(author_id)
  );

drop policy "Likes on visible posts can be read" on public.post_likes;
create policy "Likes on visible posts can be read" on public.post_likes
  for select
  to authenticated
  using (
    user_id = (select auth.uid())
    or (public.can_view_post(post_id) and not public.viewer_blocked_with(user_id))
  );

-- Notifications from someone you've blocked (or who blocked you) stay hidden,
-- including ones from before the block, and drop out of the unread count.
drop policy "People read their own live notifications" on public.notifications;
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
    and not public.dm_blocked_between(recipient_id, actor_id)
  );
