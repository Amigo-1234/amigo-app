-- =============================================================================
-- Worlds: admin management, cancellation, notices, server time (additive)
--
-- * Admins create, edit and cancel Worlds in the app (until now: SQL only).
--   Every change is checked here and audit-logged. Fairness rules: once a
--   World has started its scoring, entry rules and start time are fixed; its
--   end (and entry close) can still move, but never into the past. A finished
--   World can't be changed.
-- * Cancelled Worlds: no joining, posting, entries or chat; members are told.
-- * Amigo picks (the host bonus) and removing chat messages are admin actions.
-- * State still comes from the server's clock alone (starts_at / ends_at /
--   cancelled_at); server_now() lets phones correct their own clock so
--   countdowns are accurate.
-- * world_notices: "a World you joined is live" / "was cancelled", shown in
--   Notifications and counted in the badge. worlds_tick() creates the live
--   notices for Worlds that have started (no admin or scheduler needs to be
--   present: any signed-in app asks the server to run it every few minutes,
--   and the server also pushes them to members who allow World notifications).
-- =============================================================================

alter table public.worlds
  add column cancelled_at timestamptz,
  add column cancel_reason text check (cancel_reason is null or char_length(cancel_reason) <= 280),
  add column live_notified_at timestamptz;

create function public.server_now() returns timestamptz
language sql stable set search_path = '' as $$ select now() $$;

-- ------------------------------------------------------------------ cancelled Worlds are closed

drop policy "People join Worlds that haven't ended" on public.world_members;
create policy "People join Worlds that haven't ended" on public.world_members for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.worlds w where w.id = world_id and w.ends_at > now() and w.cancelled_at is null));

drop policy "Members chat while a World is live" on public.world_chat_messages;
create policy "Members chat while a World is live" on public.world_chat_messages for insert
  to authenticated
  with check (
    author_id = (select auth.uid())
    and exists (select 1 from public.world_members m where m.world_id = world_chat_messages.world_id and m.user_id = (select auth.uid()))
    and exists (select 1 from public.worlds w where w.id = world_chat_messages.world_id
                  and now() >= w.starts_at and now() < w.ends_at and w.cancelled_at is null));

create or replace function public.posts_world_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  w public.worlds;
begin
  if new.parent_id is not null then
    select world_id into new.world_id from public.posts where id = new.parent_id;
    new.is_entry := false;
    return new;
  end if;
  if new.world_id is null then
    return new;
  end if;

  select * into w from public.worlds where id = new.world_id;
  if w.id is null then
    raise exception 'no such World' using errcode = '23503';
  end if;
  if w.cancelled_at is not null then
    raise exception 'this World was cancelled' using errcode = 'AW006';
  end if;
  if now() < w.starts_at or now() >= w.ends_at then
    raise exception 'this World is not live' using errcode = 'AW001';
  end if;
  if not exists (select 1 from public.world_members m where m.world_id = w.id and m.user_id = new.author_id) then
    raise exception 'join the World first' using errcode = 'AW002';
  end if;
  new.visibility := 'public';

  if new.is_entry then
    if not w.competition then
      raise exception 'this World has no competition' using errcode = 'AW005';
    end if;
    if now() >= w.entries_close_at then
      raise exception 'entries are closed' using errcode = 'AW003';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(w.id::text || new.author_id::text, 0));
    if (select count(*) from public.posts p
        where p.world_id = w.id and p.author_id = new.author_id and p.is_entry and p.deleted_at is null) >= w.entry_limit then
      raise exception 'entry limit reached' using errcode = 'AW004';
    end if;
  end if;
  return new;
end $$;

-- ------------------------------------------------------------------ notices

create table public.world_notices (
  id            uuid primary key default gen_random_uuid(),
  recipient_id  uuid not null references public.profiles (id) on delete cascade,
  world_id      uuid not null references public.worlds (id) on delete cascade,
  kind          text not null check (kind in ('live', 'cancelled')),
  created_at    timestamptz not null default now(),
  read_at       timestamptz,
  pushed_at     timestamptz,
  unique (recipient_id, world_id, kind)
);
create index world_notices_inbox on public.world_notices (recipient_id, created_at desc);
alter table public.world_notices enable row level security;
revoke all on public.world_notices from anon, authenticated;
grant select on public.world_notices to authenticated;
create policy world_notices_own on public.world_notices for select to authenticated using (recipient_id = (select auth.uid()));

-- The badge counts unread World notices too.
create or replace function public.unread_notification_count() returns integer
language sql stable security invoker set search_path = '' as $$
  select (select count(*)::integer from public.notifications where recipient_id = (select auth.uid()) and read_at is null)
       + (select count(*)::integer from public.world_notices where recipient_id = (select auth.uid()) and read_at is null);
$$;

create function public.mark_world_notices_read() returns void
language sql security definer set search_path = '' as $$
  update public.world_notices set read_at = now() where recipient_id = (select auth.uid()) and read_at is null;
$$;

-- Worlds that have started since the last run: one "live" notice per member.
-- Returns them (once) so the caller can push. Cheap when nothing is due.
create function public.worlds_mark_live() returns table (world_id uuid)
language plpgsql security definer set search_path = '' as $$
begin
  return query
    with due as (
      update public.worlds w set live_notified_at = now()
       where w.live_notified_at is null and w.cancelled_at is null
         and w.starts_at <= now() and w.ends_at > now()
      returning w.id
    ), ins as (
      insert into public.world_notices (recipient_id, world_id, kind)
      select m.user_id, due.id, 'live' from due join public.world_members m on m.world_id = due.id
      on conflict do nothing
    )
    select id from due;
end $$;

-- For the push server (secret required): notices not pushed yet (each is
-- pushed at most once, and only while fresh), with the members' devices.
create function public.world_push_targets(p_key text)
returns table (world_id uuid, slug text, title text, kind text, id uuid, endpoint text, p256dh text, auth_secret text)
language plpgsql security definer set search_path = '' as $$
begin
  perform public.push_require_server(p_key);
  return query
    with due as (
      update public.world_notices n set pushed_at = now()
       where n.pushed_at is null and n.read_at is null and n.created_at > now() - interval '1 hour'
      returning n.recipient_id, n.world_id, n.kind
    )
    select due.world_id, w.slug, w.title, due.kind, s.id, s.endpoint, s.p256dh, s.auth
      from due
      join public.worlds w on w.id = due.world_id
      join public.push_subscriptions s on s.user_id = due.recipient_id
      left join public.notification_prefs np on np.user_id = due.recipient_id
     where coalesce(np.push_worlds, true) and s.failures < 20;
end $$;

-- Any signed-in app may ask for this every few minutes (it's idempotent).
create function public.worlds_tick() returns uuid[]
language sql security definer set search_path = '' as $$
  select coalesce(array_agg(world_id), '{}') from public.worlds_mark_live()
$$;

-- ------------------------------------------------------------------ admin

-- p: { slug, title, tagline, description, coverUrl, startsAt, endsAt, competition, entriesCloseAt,
--      entryLimit, pointsReaction, pointsReply, pointsHostPick, prize }
create function public.admin_create_world(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_admin();
  wid uuid;
  comp boolean := coalesce((p ->> 'competition')::boolean, false);
begin
  if (p ->> 'endsAt')::timestamptz <= now() then raise exception 'the end must be in the future' using errcode = '22023'; end if;
  begin
    insert into public.worlds (slug, title, tagline, description, cover_url, starts_at, ends_at, competition, entries_close_at,
                               entry_limit, points_reaction, points_reply, points_host_pick, prize, created_by)
    values (lower(btrim(p ->> 'slug')), btrim(p ->> 'title'), coalesce(p ->> 'tagline', ''), coalesce(p ->> 'description', ''),
            nullif(p ->> 'coverUrl', ''), (p ->> 'startsAt')::timestamptz, (p ->> 'endsAt')::timestamptz, comp,
            case when comp then (p ->> 'entriesCloseAt')::timestamptz end,
            coalesce((p ->> 'entryLimit')::smallint, 1), coalesce((p ->> 'pointsReaction')::integer, 1),
            coalesce((p ->> 'pointsReply')::integer, 2), coalesce((p ->> 'pointsHostPick')::integer, 0),
            nullif(btrim(coalesce(p ->> 'prize', '')), ''), uid)
    returning id into wid;
  exception
    when unique_violation then raise exception 'that link (slug) is already used' using errcode = 'AW010';
    when check_violation or not_null_violation or invalid_text_representation or invalid_datetime_format then
      raise exception 'check the World details: %', sqlerrm using errcode = 'AW011';
  end;
  perform public.admin_log('world.create', 'world', wid, 'Created World ' || (p ->> 'title'), p);
  return wid;
end $$;

create function public.admin_update_world(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_admin();
  w public.worlds;
  started boolean;
begin
  select * into w from public.worlds where id = p_id for update;
  if w.id is null then raise exception 'no such World' using errcode = 'AW012'; end if;
  if w.ends_at <= now() or w.cancelled_at is not null then raise exception 'finished or cancelled Worlds can''t be changed' using errcode = 'AW013'; end if;
  started := w.starts_at <= now();
  if started and (p ? 'startsAt' or p ? 'competition' or p ? 'entryLimit' or p ? 'pointsReaction' or p ? 'pointsReply' or p ? 'pointsHostPick' or p ? 'slug')
     and (coalesce((p ->> 'startsAt')::timestamptz, w.starts_at) <> w.starts_at
          or coalesce((p ->> 'competition')::boolean, w.competition) <> w.competition
          or coalesce((p ->> 'entryLimit')::smallint, w.entry_limit) <> w.entry_limit
          or coalesce((p ->> 'pointsReaction')::integer, w.points_reaction) <> w.points_reaction
          or coalesce((p ->> 'pointsReply')::integer, w.points_reply) <> w.points_reply
          or coalesce((p ->> 'pointsHostPick')::integer, w.points_host_pick) <> w.points_host_pick
          or coalesce(lower(p ->> 'slug'), w.slug) <> w.slug) then
    raise exception 'the start, link and competition rules are fixed once a World has started' using errcode = 'AW014';
  end if;
  if (p ? 'endsAt' and (p ->> 'endsAt')::timestamptz <= now())
     or (p ? 'entriesCloseAt' and started and (p ->> 'entriesCloseAt')::timestamptz <= now()) then
    raise exception 'times can''t be moved into the past' using errcode = 'AW015';
  end if;
  begin
    update public.worlds set
      slug = coalesce(lower(btrim(p ->> 'slug')), slug),
      title = coalesce(btrim(p ->> 'title'), title),
      tagline = coalesce(p ->> 'tagline', tagline),
      description = coalesce(p ->> 'description', description),
      cover_url = case when p ? 'coverUrl' then nullif(p ->> 'coverUrl', '') else cover_url end,
      starts_at = coalesce((p ->> 'startsAt')::timestamptz, starts_at),
      ends_at = coalesce((p ->> 'endsAt')::timestamptz, ends_at),
      competition = coalesce((p ->> 'competition')::boolean, competition),
      entries_close_at = case when coalesce((p ->> 'competition')::boolean, competition)
                              then coalesce((p ->> 'entriesCloseAt')::timestamptz, entries_close_at) end,
      entry_limit = coalesce((p ->> 'entryLimit')::smallint, entry_limit),
      points_reaction = coalesce((p ->> 'pointsReaction')::integer, points_reaction),
      points_reply = coalesce((p ->> 'pointsReply')::integer, points_reply),
      points_host_pick = coalesce((p ->> 'pointsHostPick')::integer, points_host_pick),
      prize = case when p ? 'prize' then nullif(btrim(p ->> 'prize'), '') else prize end,
      -- A new start time means a new "it's live" notice.
      live_notified_at = case when (p ->> 'startsAt')::timestamptz is distinct from null
                                   and (p ->> 'startsAt')::timestamptz <> starts_at then null else live_notified_at end
    where id = p_id;
  exception
    when unique_violation then raise exception 'that link (slug) is already used' using errcode = 'AW010';
    when check_violation or not_null_violation or invalid_text_representation or invalid_datetime_format then
      raise exception 'check the World details: %', sqlerrm using errcode = 'AW011';
  end;
  perform public.admin_log('world.update', 'world', p_id, 'Edited World ' || w.title, p);
end $$;

create function public.admin_cancel_world(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_admin();
  w public.worlds;
begin
  select * into w from public.worlds where id = p_id for update;
  if w.id is null then raise exception 'no such World' using errcode = 'AW012'; end if;
  if w.cancelled_at is not null or w.ends_at <= now() then raise exception 'already finished or cancelled' using errcode = 'AW013'; end if;
  update public.worlds set cancelled_at = now(), cancel_reason = nullif(btrim(coalesce(p_reason, '')), '') where id = p_id;
  insert into public.world_notices (recipient_id, world_id, kind)
  select m.user_id, p_id, 'cancelled' from public.world_members m where m.world_id = p_id
  on conflict do nothing;
  perform public.admin_log('world.cancel', 'world', p_id, 'Cancelled World ' || w.title, jsonb_build_object('reason', p_reason));
end $$;

-- The Amigo pick bonus on a competition entry (until the World ends).
create function public.admin_set_host_pick(p_world uuid, p_post uuid, p_picked boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_admin();
  w public.worlds;
begin
  select * into w from public.worlds where id = p_world;
  if w.id is null or not w.competition then raise exception 'not a competition World' using errcode = 'AW005'; end if;
  if w.ends_at <= now() or w.cancelled_at is not null then raise exception 'the World is over' using errcode = 'AW013'; end if;
  if not exists (select 1 from public.posts where id = p_post and world_id = p_world and is_entry and deleted_at is null) then
    raise exception 'not an entry in this World' using errcode = 'AW016';
  end if;
  if p_picked then
    insert into public.world_host_picks (world_id, post_id) values (p_world, p_post) on conflict do nothing;
  else
    delete from public.world_host_picks where world_id = p_world and post_id = p_post;
  end if;
  perform public.admin_log(case when p_picked then 'world.pick' else 'world.unpick' end, 'post', p_post, 'Amigo pick in ' || w.title, '{}'::jsonb);
end $$;

create function public.admin_remove_world_chat(p_message uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_admin();
  m public.world_chat_messages;
begin
  delete from public.world_chat_messages where id = p_message returning * into m;
  if m.id is null then raise exception 'no such message' using errcode = 'AW012'; end if;
  perform public.admin_log('world.chat.remove', 'world', m.world_id, 'Removed a World chat message', jsonb_build_object('author', m.author_id));
end $$;

revoke execute on function
  public.server_now(), public.mark_world_notices_read(), public.worlds_mark_live(), public.world_push_targets(text),
  public.worlds_tick(), public.admin_create_world(jsonb), public.admin_update_world(uuid, jsonb),
  public.admin_cancel_world(uuid, text), public.admin_set_host_pick(uuid, uuid, boolean), public.admin_remove_world_chat(uuid)
from public, anon, authenticated;
grant execute on function public.server_now() to anon, authenticated;
grant execute on function
  public.mark_world_notices_read(), public.world_push_targets(text), public.worlds_tick(),
  public.admin_create_world(jsonb), public.admin_update_world(uuid, jsonb), public.admin_cancel_world(uuid, text),
  public.admin_set_host_pick(uuid, uuid, boolean), public.admin_remove_world_chat(uuid)
to authenticated;
