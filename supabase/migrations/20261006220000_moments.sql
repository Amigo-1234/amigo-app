-- =============================================================================
-- Amigo World — Moments: casual posts that disappear after 24 hours
--
-- Additive. Nothing existing changes.
--
--   moments           photo and/or text (text over photo), a background style,
--                     an audience (everyone | followers), expires_at = +24h.
--   moment_views      who has seen what (the author sees the list)
--   moment_reactions  one quick reaction per person per Moment
--   moment_reports    reports for admins
--   bucket moment-media (private): photos at <author uid>/<random>. Served
--                     through signed URLs to people allowed to see the Moment
--                     — never public, so followers-only photos stay followers-only.
--
-- Visibility (moment_visible): not removed, not expired, and you're the author,
-- or it's for everyone, or you follow the author — and neither of you has
-- blocked the other. Replies to Moments are direct messages (Messages), so
-- they get Messages' privacy (end-to-end encrypted); nothing here stores them.
--
-- Admins: see reported Moments (and their photos) and can remove a Moment
-- (audit-logged). No access to Moment replies.
-- Error codes: MO001 empty · MO002 not found / not visible · MO003 not allowed
--              MO004 too many
-- Expired rows are hidden immediately; purge_expired_moments() deletes them
-- (run on a schedule as the service role; photo files are removed by the same
-- job through the Storage API).
-- =============================================================================

create table public.moments (
  id            uuid primary key default gen_random_uuid(),
  author_id     uuid not null references public.profiles (id) on delete cascade,
  body          text not null default '' check (char_length(body) <= 200),
  background    text not null default 'coral' check (background in ('coral', 'sunset', 'ocean', 'forest', 'night', 'plain')),
  media_path    text check (media_path is null or char_length(media_path) <= 300),
  media_width   int check (media_width is null or media_width between 1 and 10000),
  media_height  int check (media_height is null or media_height between 1 and 10000),
  audience      text not null default 'everyone' check (audience in ('everyone', 'followers')),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '24 hours',
  removed_at    timestamptz,
  removed_by    uuid references public.profiles (id) on delete set null,
  constraint moments_not_empty check (btrim(body) <> '' or media_path is not null)
);
create index moments_live on public.moments (expires_at desc) where removed_at is null;
create index moments_author on public.moments (author_id, created_at);

create table public.moment_views (
  moment_id  uuid not null references public.moments (id) on delete cascade,
  viewer_id  uuid not null references public.profiles (id) on delete cascade,
  viewed_at  timestamptz not null default now(),
  primary key (moment_id, viewer_id)
);

create table public.moment_reactions (
  moment_id   uuid not null references public.moments (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  emoji       text not null check (emoji in ('❤️', '😂', '😮', '😢', '🔥', '👏')),
  created_at  timestamptz not null default now(),
  primary key (moment_id, user_id)
);

create table public.moment_reports (
  id           uuid primary key default gen_random_uuid(),
  moment_id    uuid references public.moments (id) on delete set null,
  reporter_id  uuid not null references public.profiles (id) on delete cascade,
  reason       text not null check (reason in ('spam', 'harassment', 'inappropriate', 'other')),
  note         text not null default '' check (char_length(note) <= 500),
  status       text not null default 'open' check (status in ('open', 'reviewed')),
  created_at   timestamptz not null default now(),
  reviewed_by  uuid references public.profiles (id) on delete set null,
  reviewed_at  timestamptz
);

comment on table public.moments is 'Moments: temporary posts (24h). Visible per moment_visible(). Replies are direct messages, not stored here.';

revoke all on public.moments, public.moment_views, public.moment_reactions, public.moment_reports from anon, authenticated;
grant select (id, author_id, body, background, media_path, media_width, media_height, audience, created_at, expires_at) on public.moments to authenticated;
-- moment_views / moment_reactions / moment_reports: functions only.

alter table public.moments enable row level security;
alter table public.moment_views enable row level security;
alter table public.moment_reactions enable row level security;
alter table public.moment_reports enable row level security;

create function public.moment_visible(p_moment uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.moments m
    where m.id = p_moment and m.removed_at is null and m.expires_at > now()
      and (m.author_id = (select auth.uid())
           or ((m.audience = 'everyone'
                or exists (select 1 from public.follows f where f.follower_id = (select auth.uid()) and f.followee_id = m.author_id))
               and (select auth.uid()) is not null
               and not public.dm_blocked_between((select auth.uid()), m.author_id))))
$$;

create policy "Moments are visible to their audience" on public.moments for select to authenticated
  using (public.moment_visible(id));

create function public.moment_require_visible(p_moment uuid) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'sign in first' using errcode = 'MO003'; end if;
  if not public.moment_visible(p_moment) then raise exception 'no such Moment' using errcode = 'MO002'; end if;
  return uid;
end $$;

-- ------------------------------------------------------------------ writes

create function public.create_moment(p_body text, p_background text, p_media_path text, p_media_width int, p_media_height int, p_audience text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  mid uuid;
begin
  if uid is null then raise exception 'sign in first' using errcode = 'MO003'; end if;
  if p_media_path is not null and split_part(p_media_path, '/', 1) <> uid::text then
    raise exception 'photo must be in your own folder' using errcode = 'MO003';
  end if;
  if (select count(*) from public.moments where author_id = uid and created_at > now() - interval '24 hours') >= 30 then
    raise exception 'too many Moments today' using errcode = 'MO004';
  end if;
  begin
    insert into public.moments (author_id, body, background, media_path, media_width, media_height, audience)
    values (uid, btrim(coalesce(p_body, '')), coalesce(p_background, 'coral'), p_media_path, p_media_width, p_media_height, coalesce(p_audience, 'everyone'))
    returning id into mid;
  exception when check_violation then
    raise exception 'invalid Moment' using errcode = 'MO001';
  end;
  return mid;
end $$;

-- Your own Moment, before it expires. Returns the photo path so the app can delete the file.
create function public.delete_moment(p_moment uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  path text;
begin
  delete from public.moments where id = p_moment and author_id = uid returning media_path into path;
  if not found then raise exception 'not your Moment' using errcode = 'MO003'; end if;
  return path;
end $$;

create function public.mark_moment_seen(p_moment uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.moment_require_visible(p_moment);
begin
  insert into public.moment_views (moment_id, viewer_id)
  select p_moment, uid where not exists (select 1 from public.moments where id = p_moment and author_id = uid)
  on conflict do nothing;
end $$;

create function public.react_to_moment(p_moment uuid, p_emoji text) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.moment_require_visible(p_moment);
begin
  if exists (select 1 from public.moments where id = p_moment and author_id = uid) then
    raise exception 'that''s your own Moment' using errcode = 'MO003';
  end if;
  if p_emoji is null then
    delete from public.moment_reactions where moment_id = p_moment and user_id = uid;
    return;
  end if;
  begin
    insert into public.moment_reactions (moment_id, user_id, emoji) values (p_moment, uid, p_emoji)
    on conflict (moment_id, user_id) do update set emoji = excluded.emoji, created_at = now();
  exception when check_violation then
    raise exception 'not a Moment reaction' using errcode = 'MO001';
  end;
  insert into public.moment_views (moment_id, viewer_id) values (p_moment, uid) on conflict do nothing;
end $$;

create function public.report_moment(p_moment uuid, p_reason text, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.moment_require_visible(p_moment);
begin
  if exists (select 1 from public.moments where id = p_moment and author_id = uid) then
    raise exception 'that''s your own Moment' using errcode = 'MO003';
  end if;
  if (select count(*) from public.moment_reports where reporter_id = uid and created_at > now() - interval '1 hour') >= 20 then
    raise exception 'too many reports' using errcode = 'MO004';
  end if;
  begin
    insert into public.moment_reports (moment_id, reporter_id, reason, note) values (p_moment, uid, p_reason, btrim(coalesce(p_note, '')));
  exception when check_violation then
    raise exception 'invalid report' using errcode = 'MO001';
  end;
end $$;

-- ------------------------------------------------------------------ reads

-- Every Moment you can see, with whether you've seen it, your reaction, and
-- (on your own) how many people have seen it.
create function public.moments_feed() returns table (
  id uuid, author_id uuid, body text, background text, media_path text, media_width int, media_height int,
  audience text, created_at timestamptz, expires_at timestamptz, seen boolean, my_reaction text, view_count int)
language sql stable security definer set search_path = '' as $$
  select m.id, m.author_id, m.body, m.background, m.media_path, m.media_width, m.media_height, m.audience, m.created_at, m.expires_at,
         m.author_id = (select auth.uid()) or exists (select 1 from public.moment_views v where v.moment_id = m.id and v.viewer_id = (select auth.uid())),
         (select r.emoji from public.moment_reactions r where r.moment_id = m.id and r.user_id = (select auth.uid())),
         case when m.author_id = (select auth.uid()) then (select count(*)::int from public.moment_views v where v.moment_id = m.id) end
  from public.moments m
  where m.removed_at is null and m.expires_at > now() and public.moment_visible(m.id)
  order by m.created_at
  limit 1000
$$;

-- Who saw your Moment, and how they reacted. Authors only.
create function public.moment_viewers(p_moment uuid) returns table (viewer_id uuid, viewed_at timestamptz, reaction text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.moments where id = p_moment and author_id = (select auth.uid())) then
    raise exception 'not your Moment' using errcode = 'MO003';
  end if;
  return query
    select v.viewer_id, v.viewed_at, r.emoji
    from public.moment_views v
    left join public.moment_reactions r on r.moment_id = v.moment_id and r.user_id = v.viewer_id
    where v.moment_id = p_moment
    order by v.viewed_at desc
    limit 1000;
end $$;

-- ------------------------------------------------------------------ admin

create function public.admin_moment_reports() returns table (
  id uuid, reporter_id uuid, reporter_username text, reason text, note text, status text, created_at timestamptz,
  moment_id uuid, author_id uuid, body text, background text, media_path text, media_width int, media_height int,
  moment_created_at timestamptz, removed boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.support_require_admin();
  return query
    select r.id, r.reporter_id, p.username, r.reason, r.note, r.status, r.created_at,
           m.id, m.author_id, m.body, m.background, m.media_path, m.media_width, m.media_height, m.created_at, m.removed_at is not null
    from public.moment_reports r
    join public.profiles p on p.id = r.reporter_id
    left join public.moments m on m.id = r.moment_id and (m.removed_at is not null or m.expires_at > now())
    order by (r.status = 'open') desc, r.created_at desc
    limit 200;
end $$;

create function public.admin_remove_moment(p_moment uuid, p_note text default '') returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_admin();
  who text;
begin
  update public.moments set removed_at = now(), removed_by = uid where id = p_moment and removed_at is null
  returning (select username from public.profiles where id = author_id) into who;
  if who is null then raise exception 'no such Moment' using errcode = 'SP005'; end if;
  update public.moment_reports set status = 'reviewed', reviewed_by = uid, reviewed_at = now() where moment_id = p_moment and status = 'open';
  perform public.admin_log('moment.remove', 'moment', p_moment,
    format('removed a Moment by @%s%s', who, coalesce(' — ' || nullif(btrim(p_note), ''), '')));
end $$;

create function public.admin_moment_report_set_status(p_report uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.support_require_admin();
begin
  if p_status not in ('open', 'reviewed') then raise exception 'invalid status' using errcode = 'SP006'; end if;
  update public.moment_reports set status = p_status,
         reviewed_by = case when p_status = 'reviewed' then uid end,
         reviewed_at = case when p_status = 'reviewed' then now() end
  where id = p_report;
  if not found then raise exception 'no such report' using errcode = 'SP005'; end if;
  perform public.admin_log(case when p_status = 'reviewed' then 'moment_report.reviewed' else 'moment_report.reopened' end,
    'moment_report', p_report, case when p_status = 'reviewed' then 'dismissed a Moment report' else 'reopened a Moment report' end);
end $$;

-- Deletes expired Moments (views, reactions go with them). Service role only.
create function public.purge_expired_moments() returns setof text
language sql security definer set search_path = '' as $$
  delete from public.moments where expires_at < now() - interval '1 hour' returning media_path
$$;

-- ---------------------------------------------------------------- storage

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('moment-media', 'moment-media', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy "Upload Moment photos into your own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'moment-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
-- Who may fetch a Moment photo: its author, the Moment's audience, and admins for reported Moments.
-- (SECURITY DEFINER: policies run as the caller, who can't read moment_reports.)
create function public.moment_media_readable(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select split_part(p_name, '/', 1) = (select auth.uid())::text
      or exists (select 1 from public.moments m where m.media_path = p_name and public.moment_visible(m.id))
      or (public.is_admin() and exists (select 1 from public.moment_reports r join public.moments m on m.id = r.moment_id where m.media_path = p_name))
$$;

create policy "Moment photos for the Moment's audience" on storage.objects for select to authenticated
  using (bucket_id = 'moment-media' and public.moment_media_readable(name));
create policy "Delete your own Moment photos" on storage.objects for delete to authenticated
  using (bucket_id = 'moment-media' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ------------------------------------------------------------------ grants

revoke execute on function
  public.moment_visible(uuid), public.moment_require_visible(uuid), public.moment_media_readable(text),
  public.create_moment(text, text, text, int, int, text), public.delete_moment(uuid), public.mark_moment_seen(uuid),
  public.react_to_moment(uuid, text), public.report_moment(uuid, text, text), public.moments_feed(), public.moment_viewers(uuid),
  public.admin_moment_reports(), public.admin_remove_moment(uuid, text), public.admin_moment_report_set_status(uuid, text),
  public.purge_expired_moments()
from public, anon;

grant execute on function
  public.moment_visible(uuid), public.moment_media_readable(text),
  public.create_moment(text, text, text, int, int, text), public.delete_moment(uuid), public.mark_moment_seen(uuid),
  public.react_to_moment(uuid, text), public.report_moment(uuid, text, text), public.moments_feed(), public.moment_viewers(uuid),
  public.admin_moment_reports(), public.admin_remove_moment(uuid, text), public.admin_moment_report_set_status(uuid, text)
to authenticated;
-- moment_require_visible: internal. purge_expired_moments: service role only.

alter publication supabase_realtime add table public.moments;
