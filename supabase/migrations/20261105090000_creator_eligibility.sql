-- =============================================================================
-- Creator Programme eligibility (applied to verify-1029 on 3 Nov 2026; not on Production)
--
-- Seven requirements, all calculated in the database from existing records;
-- nothing a client sends is trusted:
--
--   views_90d         50,000  genuine views (post_views) of the creator's own
--                             non-deleted posts and replies, viewed in the last 90 days
--   supporters            20  unique people with a confirmed support
--                             (support_visits.confirmed_at) on the creator's own
--                             Support Hub requests (not rejected/removed requests),
--                             each with a confirmed email (as creator_engagement counts)
--   posts                 50  the creator's non-deleted top-level posts, excluding
--                             plain reposts (a repost with no text of its own)
--   replies               20  the creator's non-deleted replies to someone else's post
--   email_verified       yes  app_auth.users.email_confirmed_at
--   account_age_days      90  from profiles.created_at (as creator_engagement does)
--   good_standing        yes  no active suspension, no open monetization fraud flag,
--                             creator status not suspended or revoked
--
-- Eligibility only decides who may apply and who may be approved. Approval stays
-- an explicit admin decision. Nothing financial: no earnings, balances or payouts.
-- Support Credits are not touched: no reads or writes of support_ledger or
-- support_settings, and the earning/spending rules are unchanged.
--
-- Additive: one index, four new functions, and new versions of six existing
-- functions (same signatures, so the app keeps working). No table or row changes.
--
-- Undo: drop the four new functions and the index; restore the six functions from
-- 20261017090000_legal_and_monetization.sql and 20261021090000_creator_programme.sql.
-- =============================================================================

-- Rolling-window view totals per post: index-only counts by post and time.
create index post_views_post_time_idx on public.post_views (post_id, viewed_at);

-- ------------------------------------------------------------- the rules

-- The thresholds, in one place. Fixed in code on purpose: changing them is a
-- reviewed migration, not an admin setting.
create function public.creator_eligibility_rules() returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'views_90d', 50000,
    'supporters', 20,
    'posts', 50,
    'replies', 20,
    'account_age_days', 90,
    'window_days', 90)
$$;

-- Progress on every requirement for one person, worked out now from the records.
-- Internal: not callable by the app (see my_/admin_creator_eligibility).
create function public.creator_eligibility(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  r jsonb := public.creator_eligibility_rules();
  since timestamptz := now() - make_interval(days => (r->>'window_days')::int);
  n_views bigint;
  n_supporters bigint;
  n_posts bigint;
  n_replies bigint;
  is_verified boolean;
  n_age_days int;
  is_susp boolean;
  n_flags bigint;
  cstatus text;
  standing text[] := '{}';
  reqs jsonb;
begin
  if not exists (select 1 from public.profiles where id = p_user) then return null; end if;

  select count(*) into n_views
    from public.posts p
    join public.post_views v on v.post_id = p.id
   where p.author_id = p_user and p.deleted_at is null and v.viewed_at > since;

  select count(distinct v.user_id) into n_supporters
    from public.support_requests q
    join public.support_visits v on v.request_id = q.id
    join auth.users u on u.id = v.user_id
   where q.creator_id = p_user and q.status not in ('rejected', 'removed')
     and v.confirmed_at is not null and v.user_id <> p_user and u.email_confirmed_at is not null;

  select count(*) into n_posts
    from public.posts p
   where p.author_id = p_user and p.parent_id is null and p.deleted_at is null
     and (p.repost_of_id is null or btrim(p.body) <> '');

  select count(*) into n_replies
    from public.posts p
    join public.posts parent on parent.id = p.parent_id
   where p.author_id = p_user and p.deleted_at is null
     and parent.author_id is distinct from p_user;

  select u.email_confirmed_at is not null into is_verified from auth.users u where u.id = p_user;
  select greatest(0, floor(extract(epoch from now() - created_at) / 86400))::int into n_age_days from public.profiles where id = p_user;

  is_susp := public.is_suspended(p_user);
  select count(*) into n_flags from public.monetization_fraud_flags where user_id = p_user and resolved_at is null;
  select status into cstatus from public.creator_monetization_status where user_id = p_user;
  if is_susp then standing := array_append(standing, 'account_suspended'); end if;
  if n_flags > 0 then standing := array_append(standing, 'under_review'); end if;
  if cstatus in ('suspended', 'revoked') then standing := array_append(standing, 'creator_' || cstatus); end if;

  reqs := jsonb_build_array(
    jsonb_build_object('key', 'views_90d', 'value', n_views, 'required', (r->>'views_90d')::int, 'met', n_views >= (r->>'views_90d')::int),
    jsonb_build_object('key', 'supporters', 'value', n_supporters, 'required', (r->>'supporters')::int, 'met', n_supporters >= (r->>'supporters')::int),
    jsonb_build_object('key', 'posts', 'value', n_posts, 'required', (r->>'posts')::int, 'met', n_posts >= (r->>'posts')::int),
    jsonb_build_object('key', 'replies', 'value', n_replies, 'required', (r->>'replies')::int, 'met', n_replies >= (r->>'replies')::int),
    jsonb_build_object('key', 'email_verified', 'value', coalesce(is_verified, false), 'required', true, 'met', coalesce(is_verified, false)),
    jsonb_build_object('key', 'account_age_days', 'value', n_age_days, 'required', (r->>'account_age_days')::int, 'met', n_age_days >= (r->>'account_age_days')::int),
    jsonb_build_object('key', 'good_standing', 'value', cardinality(standing) = 0, 'required', true, 'met', cardinality(standing) = 0,
                       'reasons', to_jsonb(standing)));

  return jsonb_build_object(
    'eligible', not exists (select 1 from jsonb_array_elements(reqs) x where not (x->>'met')::boolean),
    'requirements', reqs,
    'window_days', (r->>'window_days')::int,
    'checked_at', now());
end $$;

-- The signed-in person's own progress.
create function public.my_creator_eligibility() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  return public.creator_eligibility(public.support_require_user());
end $$;

-- Any person's progress, for admins.
create function public.admin_creator_eligibility(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.support_require_admin();
  return public.creator_eligibility(p_user);
end $$;

-- ------------------------------------------------- applying (both paths)

create or replace function public.creator_apply(p_category text, p_description text, p_reason text, p_links jsonb, p_extra text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_user();
  s public.monetization_settings;
  f jsonb := public.creator_application_fields(p_category, p_description, p_reason, p_links, p_extra);
  st text := (select status from public.creator_monetization_status where user_id = uid);
  e jsonb;
  app_id uuid;
begin
  select * into s from public.monetization_settings m where m.id;
  if not s.applications_open then raise exception 'applications are not open' using errcode = 'MN001'; end if;
  if st in ('suspended', 'revoked') then raise exception 'creator access is suspended for this account' using errcode = 'MN002'; end if;
  if st = 'eligible' then raise exception 'you are already in the Creator Programme' using errcode = 'MN004'; end if;
  if exists (select 1 from public.account_suspensions where user_id = uid and (until is null or until > now())) then
    raise exception 'your account is suspended' using errcode = 'MN002';
  end if;
  e := public.creator_eligibility(uid);
  if not (e->>'eligible')::boolean then raise exception 'not eligible yet' using errcode = 'MN007'; end if;
  if (select count(*) from public.creator_applications where user_id = uid and submitted_at > now() - interval '30 days') >= 3 then
    raise exception 'too many applications this month — try again later' using errcode = 'MN005';
  end if;
  begin
    insert into public.creator_applications (user_id, snapshot, category, description, reason, links, extra)
    values (uid, public.creator_engagement(uid) || jsonb_build_object('eligibility', e),
            f->>'category', f->>'description', f->>'reason', f->'links', f->>'extra')
    returning creator_applications.id into app_id;
  exception when unique_violation then
    raise exception 'an application is already waiting for review' using errcode = 'MN003';
  end;
  return app_id;
end $$;

create or replace function public.creator_application_update(p_application uuid, p_category text, p_description text, p_reason text, p_links jsonb, p_extra text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_user();
  f jsonb := public.creator_application_fields(p_category, p_description, p_reason, p_links, p_extra);
begin
  update public.creator_applications
     set category = f->>'category', description = f->>'description', reason = f->>'reason', links = f->'links', extra = f->>'extra',
         status = 'pending', snapshot = public.creator_engagement(uid) || jsonb_build_object('eligibility', public.creator_eligibility(uid)),
         updated_at = now()
   where id = p_application and user_id = uid and status in ('pending', 'info_requested');
  if not found then raise exception 'no open application' using errcode = 'MN006'; end if;
end $$;

-- The original one-tap path: same eligibility rule, so it can't be used to get round it.
create or replace function public.apply_for_monetization() returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  s public.monetization_settings;
  e jsonb;
  app_id uuid;
begin
  if uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  select * into s from public.monetization_settings m where m.id;
  if not s.applications_open then raise exception 'applications are not open' using errcode = 'MN001'; end if;
  if exists (select 1 from public.creator_monetization_status where user_id = uid and status in ('suspended', 'revoked')) then
    raise exception 'monetization is suspended for this account' using errcode = 'MN002';
  end if;
  e := public.creator_eligibility(uid);
  if not (e->>'eligible')::boolean then raise exception 'not eligible yet' using errcode = 'MN007'; end if;
  begin
    insert into public.creator_applications (user_id, snapshot)
    values (uid, public.creator_engagement(uid) || jsonb_build_object('eligibility', e)) returning creator_applications.id into app_id;
  exception when unique_violation then
    raise exception 'an application is already pending' using errcode = 'MN003';
  end;
  return app_id;
end $$;

-- ------------------------------------------- admin decisions (all paths)

-- Approval needs the creator to be eligible at the moment of approval; rejecting
-- or asking for more information doesn't.
create or replace function public.admin_creator_application_decide(p_application uuid, p_decision text, p_note text) returns void
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
  if p_decision = 'approved' and not (public.creator_eligibility(app.user_id)->>'eligible')::boolean then
    raise exception 'this creator does not meet every requirement' using errcode = 'MN008';
  end if;
  if p_decision = 'info_requested' then
    update public.creator_applications set status = 'info_requested', info_request = note, updated_at = now(),
           reviewed_by = uid, reviewed_at = now()
     where id = p_application;
  else
    update public.creator_applications set status = p_decision, reviewed_by = uid, reviewed_at = now(), review_note = note, updated_at = now()
     where id = p_application;
  end if;
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

-- The original review path: same rule.
create or replace function public.admin_creator_application_review(p_application uuid, p_decision text, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_admin();
  app public.creator_applications;
  handle text;
begin
  if p_decision not in ('approved', 'rejected') then raise exception 'bad decision' using errcode = 'SP006'; end if;
  select * into app from public.creator_applications where id = p_application for update;
  if app.id is null or app.status <> 'pending' then raise exception 'no pending application' using errcode = 'SP005'; end if;
  if p_decision = 'approved' and not (public.creator_eligibility(app.user_id)->>'eligible')::boolean then
    raise exception 'this creator does not meet every requirement' using errcode = 'MN008';
  end if;
  update public.creator_applications set status = p_decision, reviewed_by = uid, reviewed_at = now(),
         review_note = left(btrim(coalesce(p_note, '')), 500)
   where id = p_application;
  if p_decision = 'approved' then
    insert into public.creator_monetization_status (user_id, status, reason, updated_by)
    values (app.user_id, 'eligible', 'application approved', uid)
    on conflict (user_id) do update set status = 'eligible', reason = excluded.reason, updated_by = uid, updated_at = now();
  end if;
  select username into handle from public.profiles where id = app.user_id;
  perform public.admin_log('monetization.application', 'profile', app.user_id,
    format('%s monetization application from @%s', p_decision, handle), jsonb_build_object('application', p_application));
end $$;

-- Setting someone straight to "eligible" by hand follows the same rule (suspending,
-- revoking and resetting don't need it).
create or replace function public.admin_monetization_status_set(p_user uuid, p_status text, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_admin();
  handle text := (select username from public.profiles where id = p_user);
begin
  if handle is null then raise exception 'no such user' using errcode = 'SP005'; end if;
  if p_status not in ('not_eligible', 'eligible', 'suspended', 'revoked') then raise exception 'bad status' using errcode = 'SP006'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'add a reason' using errcode = 'SP006'; end if;
  if p_status = 'eligible' and not (public.creator_eligibility(p_user)->>'eligible')::boolean then
    raise exception 'this creator does not meet every requirement' using errcode = 'MN008';
  end if;
  insert into public.creator_monetization_status (user_id, status, reason, updated_by)
  values (p_user, p_status, left(btrim(p_reason), 500), uid)
  on conflict (user_id) do update set status = excluded.status, reason = excluded.reason, updated_by = uid, updated_at = now();
  perform public.admin_log('monetization.status', 'profile', p_user, format('monetization status of @%s → %s — %s', handle, p_status, btrim(p_reason)));
end $$;

-- ------------------------------------------- what the screens read

-- The creator's screen now carries their eligibility too.
create or replace function public.my_creator_programme() returns jsonb
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
    'stats', case when st.status = 'eligible' then public.creator_stats(uid) end,
    'eligibility', public.creator_eligibility(uid)
  );
end $$;

-- The admin list's "current" figures now include eligibility (same columns).
create or replace function public.admin_creator_applications_v2(p_status text default 'pending', p_query text default '')
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
           a.snapshot, public.creator_engagement(a.user_id) || jsonb_build_object('eligibility', public.creator_eligibility(a.user_id)),
           coalesce(cs.status, 'not_eligible'),
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

-- ---------------------------------------------------------------- grants

revoke execute on function
  public.creator_eligibility_rules(), public.creator_eligibility(uuid),
  public.my_creator_eligibility(), public.admin_creator_eligibility(uuid)
from public, anon, authenticated;
grant execute on function public.my_creator_eligibility(), public.admin_creator_eligibility(uuid) to authenticated;
