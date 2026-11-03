-- Creator Programme (early access): application details, "more information
-- requested", revocation, a creator dashboard from real engagement data, and
-- private creator feedback with admin responses. Nothing financial: no
-- earnings, balances, payouts or payment providers.
--
-- Additive: new columns (with defaults) on creator_applications, two extra
-- allowed status values, a new table and new functions. No existing rows change
-- (the live table is empty). The original apply_for_monetization() keeps
-- working for the current app. Applications stay closed until an admin opens
-- them (monetization_settings.applications_open).
--
-- Undo: drop the functions below and table creator_feedback; drop the added
-- columns; restore the two check constraints and the original pending index.

-- ------------------------------------------------------- applications

alter table public.creator_applications
  add column category    text not null default '' check (category in ('', 'music', 'video', 'art', 'photography', 'writing', 'education', 'gaming', 'comedy', 'tech', 'lifestyle', 'other')),
  add column description text not null default '' check (char_length(description) <= 600),
  add column reason      text not null default '' check (char_length(reason) <= 600),
  add column links       jsonb not null default '[]'::jsonb check (jsonb_typeof(links) = 'array' and jsonb_array_length(links) <= 5 and pg_column_size(links) <= 2048),
  add column extra       text not null default '' check (char_length(extra) <= 600),
  -- What the reviewer asked for (status info_requested); kept for the record.
  add column info_request text not null default '' check (char_length(info_request) <= 500),
  add column updated_at  timestamptz not null default now();

alter table public.creator_applications drop constraint creator_applications_status_check;
alter table public.creator_applications add constraint creator_applications_status_check
  check (status in ('pending', 'info_requested', 'approved', 'rejected', 'withdrawn'));

-- One active application per person (waiting for review or for the applicant's answer).
drop index public.creator_applications_one_pending;
create unique index creator_applications_one_active on public.creator_applications (user_id) where status in ('pending', 'info_requested');
create index creator_applications_user_idx on public.creator_applications (user_id, submitted_at desc);

-- Approved creators can later be suspended (temporary) or revoked (approval withdrawn).
alter table public.creator_monetization_status drop constraint creator_monetization_status_status_check;
alter table public.creator_monetization_status add constraint creator_monetization_status_status_check
  check (status in ('not_eligible', 'eligible', 'suspended', 'revoked'));

-- Validates and normalises an application's fields; raises CP0xx on bad input.
create function public.creator_application_fields(p_category text, p_description text, p_reason text, p_links jsonb, p_extra text)
returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  links jsonb := '[]'::jsonb;
  l jsonb;
  u text;
begin
  if coalesce(p_category, '') not in ('music', 'video', 'art', 'photography', 'writing', 'education', 'gaming', 'comedy', 'tech', 'lifestyle', 'other') then
    raise exception 'choose a category' using errcode = 'CP001';
  end if;
  if char_length(btrim(coalesce(p_description, ''))) not between 20 and 600 then
    raise exception 'describe your content in 20 to 600 characters' using errcode = 'CP002';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) not between 20 and 600 then
    raise exception 'tell us why you want to join in 20 to 600 characters' using errcode = 'CP003';
  end if;
  if char_length(btrim(coalesce(p_extra, ''))) > 600 then
    raise exception 'additional information is limited to 600 characters' using errcode = 'CP004';
  end if;
  if p_links is not null and jsonb_typeof(p_links) <> 'array' then raise exception 'links must be a list' using errcode = 'CP005'; end if;
  for l in select * from jsonb_array_elements(coalesce(p_links, '[]'::jsonb)) loop
    u := btrim(coalesce(l #>> '{}', ''));
    if u = '' then continue; end if;
    if char_length(u) > 300 or u !~* '^https://[^\s/$.?#][^\s]*$' then
      raise exception 'links must start with https:// (up to 300 characters)' using errcode = 'CP005';
    end if;
    links := links || to_jsonb(u);
  end loop;
  if jsonb_array_length(links) > 5 then raise exception 'up to 5 links' using errcode = 'CP005'; end if;
  return jsonb_build_object('category', p_category, 'description', btrim(p_description), 'reason', btrim(p_reason),
                            'links', links, 'extra', btrim(coalesce(p_extra, '')));
end $$;

create function public.creator_apply(p_category text, p_description text, p_reason text, p_links jsonb, p_extra text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_user();
  s public.monetization_settings;
  f jsonb := public.creator_application_fields(p_category, p_description, p_reason, p_links, p_extra);
  st text := (select status from public.creator_monetization_status where user_id = uid);
  app_id uuid;
begin
  select * into s from public.monetization_settings m where m.id;
  if not s.applications_open then raise exception 'applications are not open' using errcode = 'MN001'; end if;
  if st in ('suspended', 'revoked') then raise exception 'creator access is suspended for this account' using errcode = 'MN002'; end if;
  if st = 'eligible' then raise exception 'you are already in the Creator Programme' using errcode = 'MN004'; end if;
  if exists (select 1 from public.account_suspensions where user_id = uid and (until is null or until > now())) then
    raise exception 'your account is suspended' using errcode = 'MN002';
  end if;
  -- Rate limit: a handful of applications a month (each rejection allows a new try).
  if (select count(*) from public.creator_applications where user_id = uid and submitted_at > now() - interval '30 days') >= 3 then
    raise exception 'too many applications this month — try again later' using errcode = 'MN005';
  end if;
  begin
    insert into public.creator_applications (user_id, snapshot, category, description, reason, links, extra)
    values (uid, public.creator_engagement(uid), f->>'category', f->>'description', f->>'reason', f->'links', f->>'extra')
    returning creator_applications.id into app_id;
  exception when unique_violation then
    raise exception 'an application is already waiting for review' using errcode = 'MN003';
  end;
  return app_id;
end $$;

-- The applicant answers a request for more information (edits and resubmits).
create function public.creator_application_update(p_application uuid, p_category text, p_description text, p_reason text, p_links jsonb, p_extra text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_user();
  f jsonb := public.creator_application_fields(p_category, p_description, p_reason, p_links, p_extra);
begin
  update public.creator_applications
     set category = f->>'category', description = f->>'description', reason = f->>'reason', links = f->'links', extra = f->>'extra',
         status = 'pending', snapshot = public.creator_engagement(uid), updated_at = now()
   where id = p_application and user_id = uid and status in ('pending', 'info_requested');
  if not found then raise exception 'no open application' using errcode = 'MN006'; end if;
end $$;

create function public.creator_application_withdraw(p_application uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.support_require_user();
begin
  update public.creator_applications set status = 'withdrawn', updated_at = now()
   where id = p_application and user_id = uid and status in ('pending', 'info_requested');
  if not found then raise exception 'no open application' using errcode = 'MN006'; end if;
end $$;

-- ------------------------------------------------------- creator dashboard

-- Real, countable engagement for one creator. Bounded: own posts only (author
-- index), likes/replies in the last 8 weeks for the trend, newest 10 posts.
-- No impressions, reach or views: those aren't tracked.
create function public.creator_stats(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with mine as (
    select id, body, like_count, reply_count, created_at
      from public.posts where author_id = p_user and parent_id is null and deleted_at is null
  ), weeks as (
    select generate_series(date_trunc('week', now()) - interval '7 weeks', date_trunc('week', now()), interval '1 week') w
  )
  select jsonb_build_object(
    'posts', (select count(*) from mine),
    'likes_received', (select coalesce(sum(like_count), 0) from mine),
    'replies_received', (select coalesce(sum(reply_count), 0) from mine),
    'followers', (select follower_count from public.profiles where id = p_user),
    'verified_followers', (select count(*) from public.follows f join auth.users u on u.id = f.follower_id
                            where f.followee_id = p_user and u.email_confirmed_at is not null),
    'recent_posts', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'body', left(body, 140), 'likes', like_count, 'replies', reply_count, 'created_at', created_at)
                                               order by created_at desc), '[]')
                       from (select * from mine order by created_at desc limit 10) r),
    'weekly', (select jsonb_agg(jsonb_build_object(
                  'week', w::date,
                  'posts', (select count(*) from mine m where m.created_at >= w and m.created_at < w + interval '1 week'),
                  'likes', (select count(*) from public.post_likes l join mine m on m.id = l.post_id
                             where l.created_at >= w and l.created_at < w + interval '1 week'),
                  'replies', (select count(*) from public.posts r join mine m on m.id = r.parent_id
                               where r.deleted_at is null and r.author_id <> p_user and r.created_at >= w and r.created_at < w + interval '1 week'))
                order by w) from weeks)
  )
$$;

-- Everything the Creator Programme screen needs, for the signed-in person.
create function public.my_creator_programme() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_user();
  s public.monetization_settings;
  st public.creator_monetization_status;
  app public.creator_applications;
begin
  select * into s from public.monetization_settings where id;
  select * into st from public.creator_monetization_status where user_id = uid;
  select * into app from public.creator_applications where user_id = uid order by submitted_at desc limit 1;
  return jsonb_build_object(
    'applications_open', s.applications_open,
    'public_note', s.public_note,
    'creator_status', coalesce(st.status, 'not_eligible'),
    'creator_reason', case when st.status in ('suspended', 'revoked') then st.reason else '' end,
    'account_suspended', exists (select 1 from public.account_suspensions where user_id = uid and (until is null or until > now())),
    'applications_this_month', (select count(*) from public.creator_applications where user_id = uid and submitted_at > now() - interval '30 days'),
    'application', case when app.id is null then null else jsonb_build_object(
      'id', app.id, 'status', app.status, 'category', app.category, 'description', app.description, 'reason', app.reason,
      'links', app.links, 'extra', app.extra, 'submitted_at', app.submitted_at, 'updated_at', app.updated_at, 'reviewed_at', app.reviewed_at,
      'info_request', case when app.status = 'info_requested' then app.info_request else '' end,
      'review_note', case when app.status in ('approved', 'rejected') then app.review_note else '' end) end,
    'stats', case when st.status = 'eligible' then public.creator_stats(uid) end
  );
end $$;

-- ------------------------------------------------------- admin review

create function public.admin_creator_applications_v2(p_status text default 'pending', p_query text default '')
returns table (id uuid, user_id uuid, username text, display_name text, avatar_url text, status text,
               category text, description text, reason text, links jsonb, extra text, info_request text,
               snapshot jsonb, current jsonb, creator_status text, submitted_at timestamptz, updated_at timestamptz,
               reviewed_at timestamptz, reviewed_by_username text, review_note text)
language plpgsql stable security definer set search_path = '' as $$
declare q text := lower(btrim(coalesce(p_query, ''), ' @'));
begin
  perform public.support_require_admin();
  q := replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_');
  return query
    select a.id, a.user_id, p.username, p.display_name, p.avatar_url, a.status,
           a.category, a.description, a.reason, a.links, a.extra, a.info_request,
           a.snapshot, public.creator_engagement(a.user_id), coalesce(cs.status, 'not_eligible'),
           a.submitted_at, a.updated_at, a.reviewed_at, r.username, a.review_note
      from public.creator_applications a
      join public.profiles p on p.id = a.user_id
      left join public.profiles r on r.id = a.reviewed_by
      left join public.creator_monetization_status cs on cs.user_id = a.user_id
     where (coalesce(p_status, 'all') = 'all' or a.status = p_status)
       and (q = '' or lower(p.username) like q || '%' or lower(p.display_name) like '%' || q || '%')
     order by a.updated_at desc
     limit 200;
end $$;

-- approved / rejected / info_requested. A reason is required to reject or ask for more.
create function public.admin_creator_application_decide(p_application uuid, p_decision text, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_admin();
  app public.creator_applications;
  note text := left(btrim(coalesce(p_note, '')), 500);
  handle text;
begin
  if p_decision not in ('approved', 'rejected', 'info_requested') then raise exception 'bad decision' using errcode = 'SP006'; end if;
  if p_decision <> 'approved' and char_length(note) < 3 then raise exception 'add a short explanation' using errcode = 'SP006'; end if;
  select * into app from public.creator_applications where id = p_application for update;
  if app.id is null or app.status not in ('pending', 'info_requested') then raise exception 'no open application' using errcode = 'SP005'; end if;
  if p_decision = 'info_requested' then
    update public.creator_applications set status = 'info_requested', info_request = note, updated_at = now(),
           reviewed_by = uid, reviewed_at = now()
     where id = p_application;
  else
    update public.creator_applications set status = p_decision, reviewed_by = uid, reviewed_at = now(), review_note = note, updated_at = now()
     where id = p_application;
  end if;
  -- Approval admits the creator to the programme; it enables nothing financial.
  if p_decision = 'approved' then
    insert into public.creator_monetization_status (user_id, status, reason, updated_by)
    values (app.user_id, 'eligible', 'application approved', uid)
    on conflict (user_id) do update set status = 'eligible', reason = excluded.reason, updated_by = uid, updated_at = now();
  end if;
  select username into handle from public.profiles where id = app.user_id;
  perform public.admin_log('creator.application', 'profile', app.user_id,
    format('%s creator application from @%s%s', replace(p_decision, '_', ' '), handle, coalesce(' — ' || nullif(note, ''), '')),
    jsonb_build_object('application', p_application, 'decision', p_decision));
end $$;

-- Same as before plus 'revoked'.
create or replace function public.admin_monetization_status_set(p_user uuid, p_status text, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_admin();
  handle text := (select username from public.profiles where id = p_user);
begin
  if handle is null then raise exception 'no such user' using errcode = 'SP005'; end if;
  if p_status not in ('not_eligible', 'eligible', 'suspended', 'revoked') then raise exception 'bad status' using errcode = 'SP006'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'add a reason' using errcode = 'SP006'; end if;
  insert into public.creator_monetization_status (user_id, status, reason, updated_by)
  values (p_user, p_status, left(btrim(p_reason), 500), uid)
  on conflict (user_id) do update set status = excluded.status, reason = excluded.reason, updated_by = uid, updated_at = now();
  perform public.admin_log('monetization.status', 'profile', p_user, format('monetization status of @%s → %s — %s', handle, p_status, btrim(p_reason)));
end $$;

-- Approved creators' figures, for the admin view of one creator.
create function public.admin_creator_stats(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.support_require_admin();
  return public.creator_stats(p_user);
end $$;

-- ------------------------------------------------------- creator feedback

-- Private between the creator and admins: no direct table access at all.
create table public.creator_feedback (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  category       text not null check (category in ('programme', 'features', 'bug', 'support', 'other')),
  rating         smallint check (rating between 1 and 5),
  body           text not null check (char_length(body) between 10 and 2000),
  status         text not null default 'open' check (status in ('open', 'reviewed', 'resolved')),
  admin_response text not null default '' check (char_length(admin_response) <= 2000),
  responded_by   uuid references public.profiles (id) on delete set null,
  responded_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index creator_feedback_user_idx on public.creator_feedback (user_id, created_at desc);
create index creator_feedback_status_idx on public.creator_feedback (status, created_at desc);
revoke all on public.creator_feedback from anon, authenticated;
alter table public.creator_feedback enable row level security;

-- Approved creators (and applicants with an application on file) can send feedback.
create function public.creator_feedback_submit(p_category text, p_rating int, p_body text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_user();
  fid uuid;
begin
  if not exists (select 1 from public.creator_monetization_status where user_id = uid and status = 'eligible')
     and not exists (select 1 from public.creator_applications where user_id = uid and status <> 'withdrawn') then
    raise exception 'feedback is for Creator Programme members and applicants' using errcode = 'CP010';
  end if;
  if (select count(*) from public.creator_feedback where user_id = uid and created_at > now() - interval '1 day') >= 10 then
    raise exception 'too much feedback today — try again tomorrow' using errcode = 'CP011';
  end if;
  begin
    insert into public.creator_feedback (user_id, category, rating, body)
    values (uid, p_category, p_rating, btrim(coalesce(p_body, '')))
    returning id into fid;
  exception when check_violation then
    raise exception 'choose a category, a rating of 1 to 5 (optional) and write 10 to 2000 characters' using errcode = 'CP012';
  end;
  return fid;
end $$;

create function public.my_creator_feedback()
returns table (id uuid, category text, rating smallint, body text, status text, admin_response text, responded_at timestamptz, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select f.id, f.category, f.rating, f.body, f.status, f.admin_response, f.responded_at, f.created_at
    from public.creator_feedback f
   where f.user_id = (select auth.uid())
   order by f.created_at desc
   limit 50
$$;

create function public.admin_creator_feedback(p_status text default 'open')
returns table (id uuid, user_id uuid, username text, display_name text, avatar_url text, category text, rating smallint, body text,
               status text, admin_response text, responded_by_username text, responded_at timestamptz, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.support_require_admin();
  return query
    select f.id, f.user_id, p.username, p.display_name, p.avatar_url, f.category, f.rating, f.body,
           f.status, f.admin_response, r.username, f.responded_at, f.created_at
      from public.creator_feedback f
      join public.profiles p on p.id = f.user_id
      left join public.profiles r on r.id = f.responded_by
     where coalesce(p_status, 'all') = 'all' or f.status = p_status
     order by f.created_at desc
     limit 200;
end $$;

-- Respond and/or change status (reviewed / resolved). Audit-logged without the text of the feedback.
create function public.admin_creator_feedback_update(p_feedback uuid, p_status text, p_response text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_admin();
  f public.creator_feedback;
  resp text := btrim(coalesce(p_response, ''));
begin
  if p_status not in ('open', 'reviewed', 'resolved') then raise exception 'bad status' using errcode = 'SP006'; end if;
  if char_length(resp) > 2000 then raise exception 'responses are limited to 2000 characters' using errcode = 'SP006'; end if;
  update public.creator_feedback
     set status = p_status,
         admin_response = case when resp <> '' then resp else admin_response end,
         responded_by = case when resp <> '' then uid else responded_by end,
         responded_at = case when resp <> '' then now() else responded_at end,
         updated_at = now()
   where id = p_feedback
  returning * into f;
  if f.id is null then raise exception 'no such feedback' using errcode = 'SP005'; end if;
  perform public.admin_log('creator.feedback', 'creator_feedback', p_feedback,
    format('%s creator feedback%s', p_status, case when resp <> '' then ' (responded)' else '' end));
end $$;

-- ------------------------------------------------------- grants

revoke execute on function
  public.creator_application_fields(text, text, text, jsonb, text), public.creator_stats(uuid),
  public.creator_apply(text, text, text, jsonb, text), public.creator_application_update(uuid, text, text, text, jsonb, text),
  public.creator_application_withdraw(uuid), public.my_creator_programme(),
  public.admin_creator_applications_v2(text, text), public.admin_creator_application_decide(uuid, text, text),
  public.admin_monetization_status_set(uuid, text, text), public.admin_creator_stats(uuid),
  public.creator_feedback_submit(text, int, text), public.my_creator_feedback(),
  public.admin_creator_feedback(text), public.admin_creator_feedback_update(uuid, text, text)
from public, anon, authenticated;
grant execute on function
  public.creator_apply(text, text, text, jsonb, text), public.creator_application_update(uuid, text, text, text, jsonb, text),
  public.creator_application_withdraw(uuid), public.my_creator_programme(),
  public.admin_creator_applications_v2(text, text), public.admin_creator_application_decide(uuid, text, text),
  public.admin_monetization_status_set(uuid, text, text), public.admin_creator_stats(uuid),
  public.creator_feedback_submit(text, int, text), public.my_creator_feedback(),
  public.admin_creator_feedback(text), public.admin_creator_feedback_update(uuid, text, text)
to authenticated;
