-- Push notifications for activity: likes (including on replies), replies,
-- mentions, follows and Support Hub support, using the Web Push setup that
-- already delivers direct-message pushes (20261019110000).
--
-- * Support Hub: when someone confirms they supported your request, you get
--   an in-app notification (new kind 'support') like the other activity.
-- * Each notification is pushed at most once (pushed_at). The server claims
--   pending rows with FOR UPDATE SKIP LOCKED, so two flushes running together
--   can't push the same thing twice.
-- * Only what is still true and allowed is pushed: the like or follow still
--   exists, the recipient can still see the post, nobody has blocked anybody,
--   and the recipient hasn't turned off activity pushes (push_social).
-- * Bursts are grouped: several likes on one post become one push ("Ada and
--   3 others liked your post"), and each recipient gets at most one push per
--   post/request/kind a minute (the rest stay in-app).
-- * Payloads (encrypted to the device) carry the kind, a count, the actor's
--   display name and where to open — never post text.
--
-- Additive: one enum value, a preference default, two columns, a rebuilt dedupe index, notify()
-- (same behaviour plus the new column), a trigger, and one server-only function.

alter type public.notification_kind add value if not exists 'support';

-- Activity pushes are on by default, like message and World pushes. Until now
-- there was no way to change this setting in the app, so every stored "off"
-- is the old default, not someone's choice; Settings now has the switch.
alter table public.notification_prefs alter column push_social set default true;
update public.notification_prefs set push_social = true where not push_social;

alter table public.notifications
  add column request_id uuid references public.support_requests (id) on delete cascade,
  add column pushed_at timestamptz;

-- Follows and support aren't about a post; support is about a request.
-- (Compared as text: the new enum value can't be used as a literal in this transaction.)
alter table public.notifications drop constraint notifications_post_matches_kind;
alter table public.notifications add constraint notifications_post_matches_kind
  check ((kind::text in ('follow', 'support')) = (post_id is null) and (kind::text = 'support') = (request_id is not null));

-- Old notifications are never pushed late.
update public.notifications set pushed_at = created_at where pushed_at is null;

create index notifications_push_pending_idx on public.notifications (created_at) where pushed_at is null;
create index notifications_request_idx on public.notifications (request_id) where request_id is not null;

-- Dedupe now also by request (supporting two of someone's requests is two notifications).
drop index public.notifications_dedupe_key;
create unique index notifications_dedupe_key
  on public.notifications (recipient_id, actor_id, kind, post_id, request_id) nulls not distinct;

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
  on conflict (recipient_id, actor_id, kind, post_id, request_id) do nothing;
end $$;

-- "Ada supported your request": when a visit is confirmed (confirm_support).
create function public.notify_on_support() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  creator uuid;
begin
  if new.confirmed_at is null or (tg_op = 'UPDATE' and old.confirmed_at is not null) then
    return null;
  end if;
  select creator_id into creator from public.support_requests where id = new.request_id;
  if creator is null or creator = new.user_id or public.dm_blocked_between(creator, new.user_id) then
    return null;
  end if;
  begin
    insert into public.notifications (recipient_id, actor_id, kind, request_id)
    values (creator, new.user_id, 'support'::text::public.notification_kind, new.request_id)
    on conflict (recipient_id, actor_id, kind, post_id, request_id) do nothing;
  exception when others then
    -- A notification must never stop the support itself from counting.
    null;
  end;
  return null;
end $$;

create trigger support_visits_notify
  after insert or update of confirmed_at on public.support_visits
  for each row execute function public.notify_on_support();

-- The push server's queue: claims un-pushed notifications (once), groups them
-- and returns one row per recipient device and group. Server-only (p_key).
create function public.push_activity_targets(p_key text)
returns table (
  id uuid, endpoint text, p256dh text, auth_secret text,
  kind text, post_id uuid, request_id uuid, on_reply boolean, actor_name text, n integer
)
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  perform public.push_require_server(p_key);
  if uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  return query
    with claimed as (
      update public.notifications x set pushed_at = now()
       where x.id in (
         select q.id from public.notifications q
          where q.pushed_at is null and q.created_at > now() - interval '30 minutes'
          order by q.created_at
          limit 300
          for update skip locked)
      returning x.id, x.recipient_id, x.actor_id, x.kind, x.post_id, x.request_id, x.created_at
    ), still_true as (
      select c.*
        from claimed c
        left join public.notification_prefs np on np.user_id = c.recipient_id
       where coalesce(np.push_social, true)
         and not public.dm_blocked_between(c.recipient_id, c.actor_id)
         and (c.post_id is null or public.profile_can_view_post(c.recipient_id, c.post_id))
         and case c.kind::text
               when 'like' then exists (select 1 from public.post_likes l where l.user_id = c.actor_id and l.post_id = c.post_id)
               when 'follow' then exists (select 1 from public.follows f where f.follower_id = c.actor_id and f.followee_id = c.recipient_id)
               else true
             end
    ), grouped as (
      select s.recipient_id, s.kind::text as kind, s.post_id, s.request_id,
             count(*)::integer as n,
             (array_agg(s.actor_id order by s.created_at desc))[1] as actor_id
        from still_true s
       group by s.recipient_id, s.kind::text, s.post_id, s.request_id
    ), allowed as (
      -- One push per recipient and target a minute; the rest are in the app.
      insert into public.push_rate as r (recipient_id, conversation_id, last_at)
      select g.recipient_id,
             -- A stable per-target key in the shared rate table (no real conversation has this id).
             md5('activity:' || g.kind || ':' || coalesce(g.post_id::text, g.request_id::text, ''))::uuid,
             now()
        from grouped g
      on conflict (recipient_id, conversation_id) do update set last_at = now()
        where r.last_at < now() - interval '1 minute'
      returning r.recipient_id, r.conversation_id
    )
    select s.id, s.endpoint, s.p256dh, s.auth, g.kind, g.post_id, g.request_id,
           coalesce((select p.parent_id is not null from public.posts p where p.id = g.post_id), false),
           left(coalesce(pr.display_name, 'Someone'), 40), g.n
      from grouped g
      join allowed a on a.recipient_id = g.recipient_id
                    and a.conversation_id = md5('activity:' || g.kind || ':' || coalesce(g.post_id::text, g.request_id::text, ''))::uuid
      join public.push_subscriptions s on s.user_id = g.recipient_id and s.failures < 20
      left join public.profiles pr on pr.id = g.actor_id;
end $$;

revoke execute on function public.push_activity_targets(text) from public;
grant execute on function public.push_activity_targets(text) to authenticated;
revoke execute on function public.notify_on_support() from public;
