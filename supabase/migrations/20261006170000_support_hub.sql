-- =============================================================================
-- Amigo World — Support Hub + admin foundation
--
-- Additive only: new tables, functions and policies. No existing table,
-- column, function or policy is changed.
--
--   app_admins             who is an Amigo admin (managed with SQL / service role only)
--   admin_audit_log        every admin action, for all current and future admin modules
--   support_settings       one row: costs, rewards, targets, moderation (no client writes)
--   support_requests       what people ask support for
--   support_visits         one row per (request, person): opened → confirmed → feedback
--   support_reports        reports on requests
--   support_ledger         every credit/reputation change; balances are sums of it
--
-- Clients never write these tables directly. Every write goes through a
-- SECURITY DEFINER function that checks auth.uid() and the rules, and every
-- admin function checks is_admin() itself — hiding /admin in the UI is only
-- cosmetic. Errors use codes SP001–SP008 (mapped to SupportError in the app).
-- No money: credits are internal points. Room is left for paid placement /
-- campaigns / plans (e.g. extra ledger reasons, a placements table) later.
-- =============================================================================

-- ------------------------------------------------------------------ admins

create table public.app_admins (
  user_id     uuid primary key references public.profiles (id) on delete cascade,
  granted_at  timestamptz not null default now(),
  note        text
);
comment on table public.app_admins is 'Amigo admins. Grant with SQL as the service role: insert into public.app_admins (user_id, note) values (...).';

create function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_admins where user_id = (select auth.uid()));
$$;

create table public.admin_audit_log (
  id           uuid primary key default gen_random_uuid(),
  admin_id     uuid references public.profiles (id) on delete set null,
  action       text not null,
  target_type  text not null,
  target_id    uuid,
  summary      text not null,
  details      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index admin_audit_recent_idx on public.admin_audit_log (created_at desc);

-- ---------------------------------------------------------------- settings

create table public.support_settings (
  id                     boolean primary key default true check (id),
  request_cost           integer not null default 5 check (request_cost between 0 and 1000),
  starter_credits        integer not null default 5 check (starter_credits between 0 and 1000),
  support_credits        integer not null default 1 check (support_credits between 0 and 100),
  support_reputation     integer not null default 2 check (support_reputation between 0 and 100),
  feedback_credits       integer not null default 1 check (feedback_credits between 0 and 100),
  feedback_reputation    integer not null default 1 check (feedback_reputation between 0 and 100),
  default_target         integer not null default 10,
  min_target             integer not null default 3,
  max_target             integer not null default 50,
  moderation             boolean not null default true,
  min_visit_seconds      integer not null default 5 check (min_visit_seconds between 0 and 3600),
  quick_confirm_seconds  integer not null default 20,
  updated_at             timestamptz not null default now(),
  constraint support_settings_targets check (min_target >= 1 and min_target <= default_target and default_target <= max_target and max_target <= 1000)
);
insert into public.support_settings default values;

-- ---------------------------------------------------------------- requests

create table public.support_requests (
  id              uuid primary key default gen_random_uuid(),
  creator_id      uuid not null references public.profiles (id) on delete cascade,
  title           text not null,
  description     text not null,
  url             text not null,
  category        text not null,
  ask             text not null,
  target          integer not null,
  supporter_count integer not null default 0,
  status          text not null default 'pending',
  featured        boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  completed_at    timestamptz,
  reviewed_by     uuid references public.profiles (id) on delete set null,
  reviewed_at     timestamptz,
  constraint support_requests_title check (char_length(btrim(title)) between 4 and 80),
  constraint support_requests_description check (char_length(btrim(description)) between 10 and 280),
  -- http(s) with a dotted host; no credentials in the URL. The app normalises before sending.
  constraint support_requests_url check (
    char_length(url) <= 500 and url ~* '^https?://[a-z0-9-]+(\.[a-z0-9-]+)+(:[0-9]+)?([/?#]|$)' and url !~ '\s'),
  constraint support_requests_category check (category in ('music', 'video', 'app', 'business', 'design', 'social', 'other')),
  constraint support_requests_ask check (ask in ('listen', 'watch', 'try', 'visit', 'read')),
  constraint support_requests_target check (target between 1 and 1000),
  constraint support_requests_status check (status in ('pending', 'active', 'completed', 'closed', 'rejected', 'removed'))
);
create index support_requests_status_idx on public.support_requests (status, created_at desc);
create index support_requests_creator_idx on public.support_requests (creator_id, created_at desc);
create index support_requests_category_idx on public.support_requests (category, status);
create trigger support_requests_touch before update on public.support_requests
  for each row execute function public.touch_updated_at();

create table public.support_visits (
  request_id    uuid not null references public.support_requests (id) on delete cascade,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  opened_at     timestamptz not null default now(),
  confirmed_at  timestamptz,
  reaction      text,
  feedback      text not null default '',
  feedback_at   timestamptz,
  primary key (request_id, user_id),
  constraint support_visits_reaction check (reaction is null or reaction in ('loved', 'useful', 'nice', 'keep_going')),
  constraint support_visits_feedback check (char_length(feedback) <= 280),
  constraint support_visits_order check (confirmed_at is null or confirmed_at >= opened_at)
);
create index support_visits_user_idx on public.support_visits (user_id, confirmed_at desc);

create table public.support_reports (
  id           uuid primary key default gen_random_uuid(),
  request_id   uuid not null references public.support_requests (id) on delete cascade,
  reporter_id  uuid not null references public.profiles (id) on delete cascade,
  reason       text not null check (char_length(btrim(reason)) between 1 and 280),
  status       text not null default 'open' check (status in ('open', 'dismissed', 'actioned')),
  created_at   timestamptz not null default now(),
  resolved_by  uuid references public.profiles (id) on delete set null,
  resolved_at  timestamptz,
  unique (request_id, reporter_id)
);
create index support_reports_open_idx on public.support_reports (status, created_at desc);

create table public.support_ledger (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  credits     integer not null default 0,
  -- Reputation is permanent: entries can only add to it.
  reputation  integer not null default 0 check (reputation >= 0),
  reason      text not null check (reason in ('starter', 'request', 'refund', 'support', 'feedback', 'admin')),
  request_id  uuid references public.support_requests (id) on delete set null,
  actor_id    uuid references public.profiles (id) on delete set null,
  note        text,
  created_at  timestamptz not null default now()
);
create index support_ledger_user_idx on public.support_ledger (user_id);
-- Each reward can only be earned once.
create unique index support_ledger_one_starter on public.support_ledger (user_id) where reason = 'starter';
create unique index support_ledger_one_support on public.support_ledger (user_id, request_id) where reason = 'support';
create unique index support_ledger_one_feedback on public.support_ledger (user_id, request_id) where reason = 'feedback';

-- ----------------------------------------------------------------- helpers

create function public.support_config() returns public.support_settings
language sql stable security definer set search_path = '' as $$
  select * from public.support_settings where id;
$$;

-- Starter credits are granted the first time someone touches Support Hub
-- (works for brand-new and migrated accounts alike).
create function public.support_ensure_starter(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.support_ledger (user_id, credits, reason)
  select p_user, s.starter_credits, 'starter' from public.support_settings s where s.id
  on conflict do nothing;
end $$;

create function public.support_credits_of(p_user uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(credits), 0)::integer from public.support_ledger where user_id = p_user;
$$;

-- Public number (shown on profiles), so it may be read for anyone.
create function public.support_reputation_of(p_user uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(reputation), 0)::integer from public.support_ledger where user_id = p_user;
$$;

create function public.support_require_user() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'not signed in' using errcode = '42501'; end if;
  return uid;
end $$;

create function public.support_require_admin() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare uid uuid := public.support_require_user();
begin
  if not public.is_admin() then raise exception 'admins only' using errcode = '42501'; end if;
  return uid;
end $$;

-- ------------------------------------------------------------- member API

create function public.support_wallet()
returns table (credits integer, reputation integer, helped integer, active_requests integer)
language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.support_require_user();
begin
  perform public.support_ensure_starter(uid);
  return query select
    public.support_credits_of(uid),
    public.support_reputation_of(uid),
    (select count(*)::integer from public.support_visits v where v.user_id = uid and v.confirmed_at is not null),
    (select count(*)::integer from public.support_requests r where r.creator_id = uid and r.status in ('active', 'pending'));
end $$;

create function public.support_profile_stats(p_profile uuid)
returns table (helped integer, reputation integer, active_requests integer)
language sql stable security definer set search_path = '' as $$
  select
    (select count(*)::integer from public.support_visits v where v.user_id = p_profile and v.confirmed_at is not null),
    public.support_reputation_of(p_profile),
    (select count(*)::integer from public.support_requests r where r.creator_id = p_profile and r.status = 'active');
$$;

create function public.create_support_request(
  p_title text, p_description text, p_url text, p_category text, p_ask text, p_target integer
) returns public.support_requests
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_user();
  cfg public.support_settings := public.support_config();
  created public.support_requests;
begin
  if p_target is null or p_target < cfg.min_target or p_target > cfg.max_target then
    raise exception 'target must be between % and %', cfg.min_target, cfg.max_target using errcode = 'SP006';
  end if;
  -- One spend at a time per person, so two parallel submits can't overdraw.
  perform pg_advisory_xact_lock(hashtextextended('support-credits:' || uid::text, 0));
  perform public.support_ensure_starter(uid);
  if public.support_credits_of(uid) < cfg.request_cost then
    raise exception 'not enough Support Credits' using errcode = 'SP008';
  end if;
  begin
    insert into public.support_requests (creator_id, title, description, url, category, ask, target, status)
    values (uid, btrim(p_title), btrim(p_description), btrim(p_url), p_category, p_ask, p_target,
            case when cfg.moderation and not public.is_admin() then 'pending' else 'active' end)
    returning * into created;
  exception when check_violation then
    raise exception 'invalid request: %', sqlerrm using errcode = 'SP006';
  end;
  insert into public.support_ledger (user_id, credits, reason, request_id) values (uid, -cfg.request_cost, 'request', created.id);
  return created;
end $$;

create function public.open_support(p_request uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_user();
  r public.support_requests;
begin
  select * into r from public.support_requests where id = p_request;
  if r.id is null then raise exception 'no such request' using errcode = 'SP005'; end if;
  if r.creator_id = uid then raise exception 'cannot support your own request' using errcode = 'SP001'; end if;
  if r.status <> 'active' then raise exception 'request is not open' using errcode = 'SP005'; end if;
  insert into public.support_visits (request_id, user_id) values (p_request, uid) on conflict do nothing;
end $$;

create function public.confirm_support(p_request uuid)
returns table (credits integer, reputation integer)
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_user();
  cfg public.support_settings := public.support_config();
  r public.support_requests;
  v public.support_visits;
begin
  select * into r from public.support_requests where id = p_request for update;
  if r.id is null then raise exception 'no such request' using errcode = 'SP005'; end if;
  if r.creator_id = uid then raise exception 'cannot support your own request' using errcode = 'SP001'; end if;
  select * into v from public.support_visits where request_id = p_request and user_id = uid for update;
  if v.request_id is null then raise exception 'open the link first' using errcode = 'SP002'; end if;
  if v.confirmed_at is not null then raise exception 'already supported' using errcode = 'SP003'; end if;
  if r.status <> 'active' then raise exception 'request is not open' using errcode = 'SP005'; end if;
  if now() - v.opened_at < make_interval(secs => cfg.min_visit_seconds) then
    raise exception 'too fast' using errcode = 'SP004';
  end if;

  perform public.support_ensure_starter(uid);
  update public.support_visits set confirmed_at = now() where request_id = p_request and user_id = uid;
  insert into public.support_ledger (user_id, credits, reputation, reason, request_id)
  values (uid, cfg.support_credits, cfg.support_reputation, 'support', p_request);
  update public.support_requests
     set supporter_count = supporter_count + 1,
         status = case when supporter_count + 1 >= target then 'completed' else status end,
         completed_at = case when supporter_count + 1 >= target then now() else completed_at end
   where id = p_request;
  return query select cfg.support_credits, cfg.support_reputation;
end $$;

create function public.leave_support_feedback(p_request uuid, p_reaction text, p_text text)
returns table (credits integer, reputation integer)
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_user();
  cfg public.support_settings := public.support_config();
  v public.support_visits;
  body text := btrim(coalesce(p_text, ''));
begin
  select * into v from public.support_visits where request_id = p_request and user_id = uid for update;
  if v.confirmed_at is null then raise exception 'support it first' using errcode = 'SP002'; end if;
  if v.feedback_at is not null then raise exception 'feedback already sent' using errcode = 'SP003'; end if;
  if p_reaction is null and body = '' then raise exception 'empty feedback' using errcode = 'SP006'; end if;
  begin
    update public.support_visits set reaction = p_reaction, feedback = body, feedback_at = now()
     where request_id = p_request and user_id = uid;
  exception when check_violation then
    raise exception 'invalid feedback' using errcode = 'SP006';
  end;
  -- Written feedback (10+ characters) earns the bonus; a reaction alone is free.
  if char_length(body) >= 10 then
    insert into public.support_ledger (user_id, credits, reputation, reason, request_id)
    values (uid, cfg.feedback_credits, cfg.feedback_reputation, 'feedback', p_request);
    return query select cfg.feedback_credits, cfg.feedback_reputation;
  else
    return query select 0, 0;
  end if;
end $$;

-- Feedback is private to the request's creator (and admins).
create function public.support_feedback(p_request uuid)
returns table (user_id uuid, username text, display_name text, avatar_url text, reaction text, feedback text, feedback_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select v.user_id, p.username, p.display_name, p.avatar_url, v.reaction, v.feedback, v.feedback_at
  from public.support_visits v
  join public.profiles p on p.id = v.user_id
  join public.support_requests r on r.id = v.request_id
  where v.request_id = p_request and v.feedback_at is not null
    and (r.creator_id = (select auth.uid()) or public.is_admin())
  order by v.feedback_at desc;
$$;

create function public.report_support_request(p_request uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.support_require_user();
begin
  if not exists (select 1 from public.support_requests where id = p_request) then
    raise exception 'no such request' using errcode = 'SP005';
  end if;
  insert into public.support_reports (request_id, reporter_id, reason)
  values (p_request, uid, left(coalesce(nullif(btrim(p_reason), ''), 'No reason given'), 280));
exception when unique_violation then
  raise exception 'already reported' using errcode = 'SP007';
end $$;

-- Discovery. SECURITY INVOKER: RLS decides which requests the viewer can see.
-- "for_you" ranks by freshness, remaining need, the viewer's own category
-- history, whether they've opened it, creator reputation, Amigo featuring and a
-- daily per-viewer jitter — never follower counts. Same weights as
-- src/data/supportRules.ts.
create function public.support_discover(
  p_section text default 'for_you', p_category text default null, p_query text default null, p_limit integer default 20
) returns setof public.support_requests
language sql stable security invoker set search_path = '' as $$
  with me as (select (select auth.uid()) as uid),
  mine_cats as (
    select distinct r.category from public.support_visits v join public.support_requests r on r.id = v.request_id, me
    where v.user_id = me.uid and v.confirmed_at is not null
  ),
  pool as (
    select r.*,
      exists (select 1 from public.support_visits v, me where v.request_id = r.id and v.user_id = me.uid) as seen,
      exists (select 1 from public.support_visits v, me where v.request_id = r.id and v.user_id = me.uid and v.confirmed_at is not null) as supported
    from public.support_requests r, me
    where (p_category is null or r.category = p_category)
      and (coalesce(btrim(p_query), '') = ''
           or r.title ilike '%' || replace(replace(replace(btrim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%'
           or r.description ilike '%' || replace(replace(replace(btrim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%')
  ),
  ranked as (
    select p.*,
      case p_section
        when 'for_you' then
          (case when p.featured then 3 else 0 end)
          + 2 * exp(-extract(epoch from now() - p.created_at) / 3600.0 / 48)
          + 2 * greatest(0, 1 - p.supporter_count::numeric / p.target)
          + (case when p.category in (select category from mine_cats) then 1 else 0 end)
          + (case when p.seen then 0 else 1 end)
          + least(ln(1 + greatest(public.support_reputation_of(p.creator_id), 0)) / ln(101), 1)
          + 0.75 * ((hashtext(p.id::text || coalesce((select uid::text from me), '') || current_date::text)::bigint & 2147483647) % 10000) / 10000.0
        when 'needs' then (p.target - p.supporter_count)::numeric * 1000000 - extract(epoch from p.created_at) / 1000000
        when 'completed' then extract(epoch from coalesce(p.completed_at, p.created_at))
        else extract(epoch from p.created_at)
      end as score
    from pool p, me
    where case p_section
      when 'mine' then p.creator_id = me.uid
      when 'completed' then p.status = 'completed'
      when 'new' then p.status = 'active'
      when 'needs' then p.status = 'active' and p.creator_id is distinct from me.uid
      else p.status = 'active' and p.creator_id is distinct from me.uid and not p.supported
    end
  )
  select id, creator_id, title, description, url, category, ask, target, supporter_count, status, featured,
         created_at, updated_at, completed_at, reviewed_by, reviewed_at
  from ranked
  order by score desc, created_at desc, id
  limit least(greatest(coalesce(p_limit, 20), 1), 100);
$$;

-- -------------------------------------------------------------- admin API

create function public.admin_log(p_action text, p_target_type text, p_target uuid, p_summary text, p_details jsonb default '{}'::jsonb)
returns void
language sql security definer set search_path = '' as $$
  insert into public.admin_audit_log (admin_id, action, target_type, target_id, summary, details)
  values ((select auth.uid()), p_action, p_target_type, p_target, p_summary, p_details);
$$;

create function public.admin_support_moderate(p_request uuid, p_action text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_admin();
  cfg public.support_settings := public.support_config();
  r public.support_requests;
  next_status text;
begin
  select * into r from public.support_requests where id = p_request for update;
  if r.id is null then raise exception 'no such request' using errcode = 'SP005'; end if;
  if not (
    (p_action = 'approve' and r.status in ('pending', 'rejected')) or
    (p_action = 'reject' and r.status = 'pending') or
    (p_action = 'remove' and r.status in ('pending', 'active', 'completed', 'closed')) or
    (p_action = 'close' and r.status = 'active') or
    (p_action = 'reopen' and r.status in ('closed', 'removed')) or
    (p_action = 'feature' and r.status in ('active', 'pending', 'completed', 'closed')) or
    (p_action = 'unfeature')
  ) then
    raise exception 'cannot % a % request', p_action, r.status using errcode = 'SP006';
  end if;

  if p_action in ('feature', 'unfeature') then
    update public.support_requests set featured = (p_action = 'feature') where id = p_request;
    next_status := r.status;
  else
    next_status := case p_action
      when 'approve' then case when r.supporter_count >= r.target then 'completed' else 'active' end
      when 'reopen' then case when r.supporter_count >= r.target then 'completed' else 'active' end
      when 'reject' then 'rejected'
      when 'remove' then 'removed'
      when 'close' then 'closed'
    end;
    update public.support_requests
       set status = next_status, reviewed_by = uid, reviewed_at = now(),
           featured = case when p_action in ('remove', 'reject') then false else featured end
     where id = p_request;
    -- A rejected request gets its credits back; a removed (spam) one does not.
    if p_action = 'reject' then
      insert into public.support_ledger (user_id, credits, reason, request_id, actor_id, note)
      values (r.creator_id, cfg.request_cost, 'refund', r.id, uid, p_note);
    end if;
  end if;
  perform public.admin_log('support.' || p_action, 'support_request', r.id,
    format('%s “%s” (%s → %s)%s', p_action, r.title, r.status, next_status, coalesce(' — ' || nullif(btrim(p_note), ''), '')),
    jsonb_build_object('from', r.status, 'to', next_status, 'note', p_note));
end $$;

create function public.admin_support_reports(p_status text default 'open')
returns table (id uuid, request_id uuid, request_title text, request_status text, reporter_id uuid, reporter_username text,
               reporter_display_name text, reporter_avatar_url text, reason text, status text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.support_require_admin();
  return query
    select x.id, r.id, r.title, r.status, p.id, p.username, p.display_name, p.avatar_url, x.reason, x.status, x.created_at
    from public.support_reports x
    join public.support_requests r on r.id = x.request_id
    join public.profiles p on p.id = x.reporter_id
    where p_status = 'all' or x.status = 'open'
    order by x.created_at desc
    limit 200;
end $$;

create function public.admin_support_resolve_report(p_report uuid, p_outcome text) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.support_require_admin(); t text;
begin
  if p_outcome not in ('dismissed', 'actioned') then raise exception 'bad outcome' using errcode = 'SP006'; end if;
  update public.support_reports set status = p_outcome, resolved_by = uid, resolved_at = now() where id = p_report
  returning (select title from public.support_requests where id = request_id) into t;
  if not found then raise exception 'no such report' using errcode = 'SP005'; end if;
  perform public.admin_log('support.report', 'support_report', p_report, format('%s report on “%s”', p_outcome, t));
end $$;

-- Patterns worth a human look, from real timestamps only.
create function public.admin_support_suspicious()
returns table (kind text, user_id uuid, username text, display_name text, avatar_url text, detail text, request_id uuid, at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare cfg public.support_settings := public.support_config();
begin
  perform public.support_require_admin();
  return query
    select 'quick-confirm', p.id, p.username, p.display_name, p.avatar_url,
           format('Confirmed “%s” %ss after opening it', r.title, round(extract(epoch from v.confirmed_at - v.opened_at))),
           r.id, v.confirmed_at
    from public.support_visits v
    join public.profiles p on p.id = v.user_id
    join public.support_requests r on r.id = v.request_id
    where v.confirmed_at is not null and v.confirmed_at - v.opened_at < make_interval(secs => cfg.quick_confirm_seconds)
    union all
    select 'burst', p.id, p.username, p.display_name, p.avatar_url, '5+ supports within 10 minutes', null::uuid, b.at
    from (
      select v.user_id, max(v.confirmed_at) as at
      from public.support_visits v
      where v.confirmed_at is not null
        and (select count(*) from public.support_visits w
             where w.user_id = v.user_id and w.confirmed_at between v.confirmed_at and v.confirmed_at + interval '10 minutes') >= 5
      group by v.user_id
    ) b join public.profiles p on p.id = b.user_id
    order by 8 desc
    limit 200;
end $$;

create function public.admin_support_supporters(p_request uuid)
returns table (user_id uuid, username text, display_name text, avatar_url text, opened_at timestamptz, confirmed_at timestamptz, seconds integer)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.support_require_admin();
  return query
    select p.id, p.username, p.display_name, p.avatar_url, v.opened_at, v.confirmed_at,
           round(extract(epoch from v.confirmed_at - v.opened_at))::integer
    from public.support_visits v join public.profiles p on p.id = v.user_id
    where v.request_id = p_request
    order by v.opened_at desc;
end $$;

create function public.admin_support_find_user(p_handle text)
returns table (id uuid, username text, display_name text, avatar_url text, credits integer, reputation integer, helped integer, active_requests integer)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.support_require_admin();
  return query
    select p.id, p.username, p.display_name, p.avatar_url,
           public.support_credits_of(p.id), public.support_reputation_of(p.id),
           (select count(*)::integer from public.support_visits v where v.user_id = p.id and v.confirmed_at is not null),
           (select count(*)::integer from public.support_requests r where r.creator_id = p.id and r.status in ('active', 'pending'))
    from public.profiles p
    where p.username = lower(ltrim(btrim(p_handle), '@'));
end $$;

create function public.admin_support_adjust_credits(p_user uuid, p_delta integer, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.support_require_admin(); handle text;
begin
  if p_delta is null or p_delta = 0 or abs(p_delta) > 1000 then raise exception 'delta must be between -1000 and 1000' using errcode = 'SP006'; end if;
  if char_length(btrim(coalesce(p_note, ''))) < 3 then raise exception 'add a reason' using errcode = 'SP006'; end if;
  select username into handle from public.profiles where id = p_user;
  if handle is null then raise exception 'no such user' using errcode = 'SP005'; end if;
  perform pg_advisory_xact_lock(hashtextextended('support-credits:' || p_user::text, 0));
  perform public.support_ensure_starter(p_user);
  if public.support_credits_of(p_user) + p_delta < 0 then raise exception 'balance cannot go below zero' using errcode = 'SP006'; end if;
  insert into public.support_ledger (user_id, credits, reason, actor_id, note) values (p_user, p_delta, 'admin', uid, btrim(p_note));
  perform public.admin_log('support.credits', 'profile', p_user,
    format('%s%s credits for @%s — %s', case when p_delta > 0 then '+' else '' end, p_delta, handle, btrim(p_note)),
    jsonb_build_object('delta', p_delta));
end $$;

create function public.admin_audit(p_limit integer default 50)
returns table (id uuid, admin_id uuid, username text, display_name text, avatar_url text, action text, summary text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.support_require_admin();
  return query
    select a.id, a.admin_id, p.username, p.display_name, p.avatar_url, a.action, a.summary, a.created_at
    from public.admin_audit_log a left join public.profiles p on p.id = a.admin_id
    order by a.created_at desc
    limit least(greatest(coalesce(p_limit, 50), 1), 500);
end $$;

-- ---------------------------------------------------------------- security

revoke all on public.app_admins, public.admin_audit_log, public.support_settings, public.support_requests,
  public.support_visits, public.support_reports, public.support_ledger from anon, authenticated;

grant select on public.support_settings to anon, authenticated;
grant select on public.support_requests to anon, authenticated;
grant select on public.support_visits, public.support_ledger to authenticated;

alter table public.app_admins       enable row level security;
alter table public.admin_audit_log  enable row level security;
alter table public.support_settings enable row level security;
alter table public.support_requests enable row level security;
alter table public.support_visits   enable row level security;
alter table public.support_reports  enable row level security;
alter table public.support_ledger   enable row level security;

create policy "Support settings are public" on public.support_settings for select to anon, authenticated using (true);

-- Open and completed requests are public; pending/rejected/removed/closed only for their creator and admins.
create policy "Visible support requests" on public.support_requests for select to anon, authenticated
  using (status in ('active', 'completed') or creator_id = (select auth.uid()) or public.is_admin());

create policy "Own support visits" on public.support_visits for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

create policy "Own ledger" on public.support_ledger for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

-- app_admins, admin_audit_log and support_reports: no policies, no grants — admin RPCs only.

-- Explicit execute grants only (see 20261006140000_revoke_public_function_execute.sql).
do $$
declare f text;
begin
  foreach f in array array[
    'public.is_admin()', 'public.support_config()', 'public.support_ensure_starter(uuid)', 'public.support_credits_of(uuid)',
    'public.support_reputation_of(uuid)', 'public.support_require_user()', 'public.support_require_admin()',
    'public.support_wallet()', 'public.support_profile_stats(uuid)',
    'public.create_support_request(text, text, text, text, text, integer)', 'public.open_support(uuid)', 'public.confirm_support(uuid)',
    'public.leave_support_feedback(uuid, text, text)', 'public.support_feedback(uuid)', 'public.report_support_request(uuid, text)',
    'public.support_discover(text, text, text, integer)', 'public.admin_log(text, text, uuid, text, jsonb)',
    'public.admin_support_moderate(uuid, text, text)', 'public.admin_support_reports(text)', 'public.admin_support_resolve_report(uuid, text)',
    'public.admin_support_suspicious()', 'public.admin_support_supporters(uuid)', 'public.admin_support_find_user(text)',
    'public.admin_support_adjust_credits(uuid, integer, text)', 'public.admin_audit(integer)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end $$;

-- Helpers used inside RLS policies / invoker functions must be callable by the caller's role.
grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.support_reputation_of(uuid) to anon, authenticated;
grant execute on function public.support_config() to anon, authenticated;
grant execute on function public.support_profile_stats(uuid) to anon, authenticated;
grant execute on function public.support_discover(text, text, text, integer) to anon, authenticated;

grant execute on function public.support_wallet() to authenticated;
grant execute on function public.create_support_request(text, text, text, text, text, integer) to authenticated;
grant execute on function public.open_support(uuid) to authenticated;
grant execute on function public.confirm_support(uuid) to authenticated;
grant execute on function public.leave_support_feedback(uuid, text, text) to authenticated;
grant execute on function public.support_feedback(uuid) to authenticated;
grant execute on function public.report_support_request(uuid, text) to authenticated;

-- Admin RPCs are executable by signed-in users but refuse non-admins inside (support_require_admin).
grant execute on function public.admin_support_moderate(uuid, text, text) to authenticated;
grant execute on function public.admin_support_reports(text) to authenticated;
grant execute on function public.admin_support_resolve_report(uuid, text) to authenticated;
grant execute on function public.admin_support_suspicious() to authenticated;
grant execute on function public.admin_support_supporters(uuid) to authenticated;
grant execute on function public.admin_support_find_user(text) to authenticated;
grant execute on function public.admin_support_adjust_credits(uuid, integer, text) to authenticated;
grant execute on function public.admin_audit(integer) to authenticated;

-- Realtime: request rows (supporter_count/status changes) so lists stay live.
alter publication supabase_realtime add table public.support_requests;
