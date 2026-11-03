-- One small read that tells an open app what changed for the signed-in person,
-- so screens refresh within seconds instead of waiting for their own polls
-- (Neon has no Realtime). Additive: a new read-only function, nothing else.
--
--   n   unread notifications + World notices, and the newest of each
--   f   the person's own follower / following counts
--   p   the newest public top-level post (the feed then checks what's new)
--   mo  the newest public Moment
--
-- Only the caller's own counts and timestamps of public content: nothing a
-- signed-in person couldn't already read.

create function public.app_pulse() returns jsonb
language sql stable security definer set search_path = '' as $$
select case when (select auth.uid()) is null then null else jsonb_build_object(
  'n', jsonb_build_array(
    (select count(*) from public.notifications where recipient_id = (select auth.uid()) and read_at is null)
      + (select count(*) from public.world_notices where recipient_id = (select auth.uid()) and read_at is null),
    (select max(created_at) from public.notifications where recipient_id = (select auth.uid())),
    (select max(created_at) from public.world_notices where recipient_id = (select auth.uid()))),
  'f', (select jsonb_build_array(follower_count, following_count) from public.profiles where id = (select auth.uid())),
  'p', (select max(created_at) from public.posts where deleted_at is null and parent_id is null and visibility = 'public'),
  'mo', (select max(created_at) from public.moments where removed_at is null and audience = 'everyone' and expires_at > now())
) end
$$;

revoke all on function public.app_pulse() from public, anon;
grant execute on function public.app_pulse() to authenticated;
