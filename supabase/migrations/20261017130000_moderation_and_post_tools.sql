-- =============================================================================
-- Moderation and post tools (additive)
--
--   Account suspension   admins suspend/restore accounts (audit-logged). The
--                        database refuses a suspended account's new posts,
--                        replies, likes, follows, messages, Moments, Worlds
--                        and Support Hub activity (AS001). Reading, reporting,
--                        blocking and deleting the account still work.
--   Content reports      posts (incl. replies), profiles and Worlds, with the
--                        same reasons as other reports; admin queue, review,
--                        and post takedown (audit-logged).
--   Bookmarks            private to you.
--   Editing posts        your own posts; marked as edited.
--
-- Admins still have no read path to direct messages (unchanged).
-- Error codes: AS001 suspended · RP001 invalid report · RP002 too many reports
--              PO001 not your post / not found · PO002 invalid edit
-- =============================================================================

-- --------------------------------------------------------------- suspension

create table public.account_suspensions (
  user_id       uuid primary key references public.profiles (id) on delete cascade,
  reason        text not null check (char_length(btrim(reason)) between 3 and 500),
  suspended_by  uuid references public.profiles (id) on delete set null,
  suspended_at  timestamptz not null default now(),
  -- null: until an admin restores the account.
  until         timestamptz
);
revoke all on public.account_suspensions from anon, authenticated;
alter table public.account_suspensions enable row level security;

create function public.is_suspended(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_user is not null and exists (
    select 1 from public.account_suspensions s where s.user_id = p_user and (s.until is null or s.until > now()))
$$;

create function public.refuse_if_suspended() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if public.is_suspended((select auth.uid())) then
    raise exception 'this account is suspended' using errcode = 'AS001';
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['posts', 'post_likes', 'follows', 'dm_messages', 'moments', 'moment_reactions',
                           'worlds', 'world_members', 'world_chat_messages', 'support_requests', 'support_visits'] loop
    execute format('create trigger %I before insert on public.%I for each row execute function public.refuse_if_suspended()',
                   t || '_refuse_suspended', t);
  end loop;
end $$;

-- Your own status (for the banner in the app).
create function public.my_account_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'suspended', public.is_suspended((select auth.uid())),
    'reason', (select s.reason from public.account_suspensions s where s.user_id = (select auth.uid()) and (s.until is null or s.until > now())),
    'until', (select s.until from public.account_suspensions s where s.user_id = (select auth.uid()) and (s.until is null or s.until > now())))
  where (select auth.uid()) is not null
$$;

create function public.admin_suspend_user(p_user uuid, p_reason text, p_until timestamptz default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_admin();
  handle text := (select username from public.profiles where id = p_user);
begin
  if handle is null then raise exception 'no such user' using errcode = 'SP005'; end if;
  if p_user = uid or exists (select 1 from public.app_admins a where a.user_id = p_user) then
    raise exception 'admins can''t be suspended here' using errcode = 'SP006';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'add a reason' using errcode = 'SP006'; end if;
  if p_until is not null and p_until <= now() then raise exception 'end date must be in the future' using errcode = 'SP006'; end if;
  insert into public.account_suspensions (user_id, reason, suspended_by, until)
  values (p_user, left(btrim(p_reason), 500), uid, p_until)
  on conflict (user_id) do update set reason = excluded.reason, suspended_by = uid, suspended_at = now(), until = excluded.until;
  perform public.admin_log('account.suspend', 'profile', p_user,
    format('suspended @%s%s — %s', handle, coalesce(' until ' || to_char(p_until, 'YYYY-MM-DD HH24:MI'), ''), btrim(p_reason)));
end $$;

create function public.admin_unsuspend_user(p_user uuid, p_note text default '') returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_admin();
  handle text := (select username from public.profiles where id = p_user);
begin
  delete from public.account_suspensions where user_id = p_user;
  if not found then raise exception 'not suspended' using errcode = 'SP005'; end if;
  perform public.admin_log('account.unsuspend', 'profile', p_user,
    format('restored @%s%s', handle, coalesce(' — ' || nullif(btrim(p_note), ''), '')));
end $$;

create function public.admin_suspensions() returns table (
  user_id uuid, username text, display_name text, reason text, suspended_at timestamptz, until timestamptz, suspended_by_username text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.support_require_admin();
  return query
    select s.user_id, p.username, p.display_name, s.reason, s.suspended_at, s.until, b.username
      from public.account_suspensions s
      join public.profiles p on p.id = s.user_id
      left join public.profiles b on b.id = s.suspended_by
     where s.until is null or s.until > now()
     order by s.suspended_at desc
     limit 500;
end $$;

-- ---------------------------------------------------------- content reports

create table public.content_reports (
  id           uuid primary key default gen_random_uuid(),
  reporter_id  uuid not null references public.profiles (id) on delete cascade,
  target_type  text not null check (target_type in ('post', 'profile', 'world')),
  target_id    uuid not null,
  reason       text not null check (reason in ('spam', 'harassment', 'inappropriate', 'other')),
  note         text not null default '' check (char_length(note) <= 500),
  status       text not null default 'open' check (status in ('open', 'reviewed')),
  created_at   timestamptz not null default now(),
  reviewed_by  uuid references public.profiles (id) on delete set null,
  reviewed_at  timestamptz
);
create index content_reports_open on public.content_reports (status, created_at desc);
create unique index content_reports_once on public.content_reports (reporter_id, target_type, target_id) where status = 'open';
revoke all on public.content_reports from anon, authenticated;
alter table public.content_reports enable row level security;

create function public.report_content(p_type text, p_target uuid, p_reason text, p_note text default '') returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  if p_type = 'post' then
    if not exists (select 1 from public.posts p where p.id = p_target and p.deleted_at is null and p.author_id <> uid)
       or not public.can_view_post(p_target) then
      raise exception 'nothing to report' using errcode = 'RP001';
    end if;
  elsif p_type = 'profile' then
    if p_target = uid or not exists (select 1 from public.profiles where id = p_target) then
      raise exception 'nothing to report' using errcode = 'RP001';
    end if;
  elsif p_type = 'world' then
    if not exists (select 1 from public.worlds where id = p_target) then
      raise exception 'nothing to report' using errcode = 'RP001';
    end if;
  else
    raise exception 'nothing to report' using errcode = 'RP001';
  end if;
  if (select count(*) from public.content_reports where reporter_id = uid and created_at > now() - interval '1 hour') >= 20 then
    raise exception 'too many reports' using errcode = 'RP002';
  end if;
  begin
    insert into public.content_reports (reporter_id, target_type, target_id, reason, note)
    values (uid, p_type, p_target, p_reason, btrim(coalesce(p_note, '')));
  exception
    when check_violation then raise exception 'invalid report' using errcode = 'RP001';
    -- Already reported and still open: nothing more to do.
    when unique_violation then null;
  end;
end $$;

create function public.admin_content_reports(p_status text default 'open') returns table (
  id uuid, reporter_username text, target_type text, target_id uuid, reason text, note text, status text, created_at timestamptz,
  target_label text, target_text text, target_author_id uuid, target_author_username text, target_removed boolean, report_count bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.support_require_admin();
  return query
    select r.id, rp.username, r.target_type, r.target_id, r.reason, r.note, r.status, r.created_at,
           case r.target_type
             when 'post' then case when po.parent_id is null then 'Post' else 'Reply' end
             when 'profile' then 'Profile'
             else 'World' end,
           case r.target_type
             when 'post' then left(po.body, 500)
             when 'profile' then left(coalesce(pr.display_name, '') || ' — ' || coalesce(pr.bio, ''), 500)
             else left(coalesce(w.title, '') || ' — ' || coalesce(w.description, ''), 500) end,
           coalesce(po.author_id, pr.id),
           coalesce(pa.username, pr.username),
           case r.target_type when 'post' then po.id is null or po.deleted_at is not null else false end,
           (select count(*) from public.content_reports x where x.target_type = r.target_type and x.target_id = r.target_id and x.status = 'open')
      from public.content_reports r
      join public.profiles rp on rp.id = r.reporter_id
      left join public.posts po on r.target_type = 'post' and po.id = r.target_id
      left join public.profiles pa on pa.id = po.author_id
      left join public.profiles pr on r.target_type = 'profile' and pr.id = r.target_id
      left join public.worlds w on r.target_type = 'world' and w.id = r.target_id
     where p_status = 'all' or r.status = p_status
     order by r.created_at desc
     limit 300;
end $$;

create function public.admin_content_report_set_status(p_report uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.support_require_admin();
begin
  if p_status not in ('open', 'reviewed') then raise exception 'invalid status' using errcode = 'SP006'; end if;
  update public.content_reports set status = p_status,
         reviewed_by = case when p_status = 'reviewed' then uid end,
         reviewed_at = case when p_status = 'reviewed' then now() end
   where id = p_report;
  if not found then raise exception 'no such report' using errcode = 'SP005'; end if;
  perform public.admin_log(case when p_status = 'reviewed' then 'content_report.reviewed' else 'content_report.reopened' end,
    'content_report', p_report, case when p_status = 'reviewed' then 'dismissed a content report' else 'reopened a content report' end);
end $$;

-- Takes a post (or reply) down for everyone; its open reports are closed.
create function public.admin_remove_post(p_post uuid, p_note text default '') returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_admin();
  who text;
begin
  update public.posts set deleted_at = now() where id = p_post and deleted_at is null
  returning (select username from public.profiles where id = author_id) into who;
  if who is null then raise exception 'no such post' using errcode = 'SP005'; end if;
  update public.content_reports set status = 'reviewed', reviewed_by = uid, reviewed_at = now()
   where target_type = 'post' and target_id = p_post and status = 'open';
  perform public.admin_log('post.remove', 'post', p_post,
    format('removed a post by @%s%s', who, coalesce(' — ' || nullif(btrim(p_note), ''), '')));
end $$;

-- ----------------------------------------------------------------- bookmarks

create table public.post_bookmarks (
  user_id     uuid not null references public.profiles (id) on delete cascade,
  post_id     uuid not null references public.posts (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, post_id)
);
create index post_bookmarks_recent on public.post_bookmarks (user_id, created_at desc);
revoke all on public.post_bookmarks from anon, authenticated;
-- anon too, so feeds can embed it for signed-out visitors (RLS gives them no rows).
grant select on public.post_bookmarks to anon, authenticated;
alter table public.post_bookmarks enable row level security;
create policy "Your own bookmarks" on public.post_bookmarks for select to authenticated using (user_id = (select auth.uid()));

create function public.set_post_bookmark(p_post uuid, p_saved boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  if p_saved then
    if not public.can_view_post(p_post) then raise exception 'post not found' using errcode = 'PO001'; end if;
    insert into public.post_bookmarks (user_id, post_id) values (uid, p_post) on conflict do nothing;
  else
    delete from public.post_bookmarks where user_id = uid and post_id = p_post;
  end if;
end $$;

-- --------------------------------------------------------------- post edits

alter table public.posts add column edited_at timestamptz;

create function public.edit_post(p_post uuid, p_body text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  new_body text := btrim(coalesce(p_body, ''));
begin
  if uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  if public.is_suspended(uid) then raise exception 'this account is suspended' using errcode = 'AS001'; end if;
  if char_length(new_body) > 2000 then raise exception 'too long' using errcode = 'PO002'; end if;
  update public.posts p set body = new_body, edited_at = now(), updated_at = now()
   where p.id = p_post and p.author_id = uid and p.deleted_at is null and p.repost_of_id is null
     -- A post must keep some content: text, or its media.
     and (new_body <> '' or exists (select 1 from public.post_media m where m.post_id = p.id));
  if not found then raise exception 'not your post' using errcode = 'PO001'; end if;
end $$;

-- ------------------------------------------------------------------- grants

revoke execute on function
  public.is_suspended(uuid), public.refuse_if_suspended(), public.my_account_status(),
  public.admin_suspend_user(uuid, text, timestamptz), public.admin_unsuspend_user(uuid, text), public.admin_suspensions(),
  public.report_content(text, uuid, text, text), public.admin_content_reports(text), public.admin_content_report_set_status(uuid, text),
  public.admin_remove_post(uuid, text), public.set_post_bookmark(uuid, boolean), public.edit_post(uuid, text)
from public, anon, authenticated;

grant execute on function
  public.my_account_status(),
  public.admin_suspend_user(uuid, text, timestamptz), public.admin_unsuspend_user(uuid, text), public.admin_suspensions(),
  public.report_content(text, uuid, text, text), public.admin_content_reports(text), public.admin_content_report_set_status(uuid, text),
  public.admin_remove_post(uuid, text), public.set_post_bookmark(uuid, boolean), public.edit_post(uuid, text)
to authenticated;
-- is_suspended, refuse_if_suspended: internal.
