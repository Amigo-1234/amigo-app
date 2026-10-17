do $neon_wrap$ begin execute $neon_step$
-- =============================================================================
-- Amigo World — legal document versioning + creator monetization architecture
--
-- Legal
--   legal_documents      published versions of each policy (text lives in the
--                        app bundle per version; the database decides which
--                        version is current and whether it needs acceptance)
--   legal_acceptances    who accepted which version, with server time
--   legal_current()      current published version of every document
--   legal_pending()      what this account still has to accept (or should be
--                        told about), e.g. after a material change
--   legal_accept(docs)   records acceptance of current versions only
--   admin_legal_*        admin-only publish + list, audited
--
-- Monetization (ARCHITECTURE ONLY — nothing financial exists or is enabled)
--   monetization_settings        programme switches + criteria, all off/empty
--   creator_applications         eligibility applications + admin review
--   creator_monetization_status  per-creator status set only by admins
--   monetization_fraud_flags     manipulation flags raised/resolved by admins
--   my_creator_overview()        the creator's own standing + engagement stats
--   apply_for_monetization()     refused unless admins opened applications
--   admin_monetization_*         admin-only, audited
-- No thresholds, percentages, payouts or payment providers are defined here.
-- =============================================================================

-- ------------------------------------------------------------------ legal

create table public.legal_documents (
  slug                text not null check (slug in ('terms', 'privacy', 'guidelines', 'copyright', 'monetization', 'deletion', 'cookies')),
  version             text not null check (version ~ '^[0-9]+\.[0-9]+$'),
  title               text not null check (char_length(btrim(title)) between 1 and 120),
  effective_at        timestamptz not null,
  published_at        timestamptz,
  -- Accepting this document is part of having an account (Terms, Privacy).
  requires_acceptance boolean not null default false,
  -- A material change: people who accepted an earlier version must accept again.
  material_change     boolean not null default false,
  -- What changed, shown in the change notice.
  summary             text not null default '' check (char_length(summary) <= 500),
  created_at          timestamptz not null default now(),
  primary key (slug, version)
);

create table public.legal_acceptances (
  user_id      uuid not null references public.profiles (id) on delete cascade,
  slug         text not null,
  version      text not null,
  accepted_at  timestamptz not null default now(),
  primary key (user_id, slug, version),
  foreign key (slug, version) references public.legal_documents (slug, version)
);

revoke all on public.legal_documents, public.legal_acceptances from anon, authenticated;
grant select on public.legal_acceptances to authenticated;
alter table public.legal_documents enable row level security;
alter table public.legal_acceptances enable row level security;
create policy "Own acceptances" on public.legal_acceptances for select to authenticated using (user_id = (select app_auth.uid()));

-- The current version of each document: the newest published one already in effect.
create function public.legal_current()
returns table (slug text, version text, title text, effective_at timestamptz, published_at timestamptz,
               requires_acceptance boolean, material_change boolean, summary text)
language sql stable security definer set search_path = '' as $$
  select distinct on (d.slug) d.slug, d.version, d.title, d.effective_at, d.published_at,
         d.requires_acceptance, d.material_change, d.summary
    from public.legal_documents d
   where d.published_at is not null and d.effective_at <= now()
   order by d.slug, d.effective_at desc, d.published_at desc
$$;

-- required: must accept before continuing (never accepted, or a material change).
-- Otherwise a newer non-material version is listed with required = false (a notice).
create function public.legal_pending()
returns table (slug text, version text, title text, summary text, required boolean)
language sql stable security definer set search_path = '' as $$
  select c.slug, c.version, c.title, c.summary,
         (not exists (select 1 from public.legal_acceptances a where a.user_id = (select app_auth.uid()) and a.slug = c.slug)
          or c.material_change) as required
    from public.legal_current() c
   where (select app_auth.uid()) is not null
     and c.requires_acceptance
     and not exists (select 1 from public.legal_acceptances a
                      where a.user_id = (select app_auth.uid()) and a.slug = c.slug and a.version = c.version)
$$;

create function public.legal_accept(p_docs jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select app_auth.uid());
  d record;
  n integer := 0;
begin
  if uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  for d in select x ->> 'slug' as slug, x ->> 'version' as version from jsonb_array_elements(coalesce(p_docs, '[]'::jsonb)) x loop
    -- Only the version currently in effect can be accepted.
    if not exists (select 1 from public.legal_current() c where c.slug = d.slug and c.version = d.version) then
      raise exception 'not the current version of %', d.slug using errcode = 'LG001';
    end if;
    insert into public.legal_acceptances (user_id, slug, version) values (uid, d.slug, d.version) on conflict do nothing;
    n := n + 1;
  end loop;
  return n;
end $$;

create function public.admin_legal_documents()
returns setof public.legal_documents
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.support_require_admin();
  return query select * from public.legal_documents order by slug, effective_at desc;
end $$;

create function public.admin_legal_publish(p_slug text, p_version text, p_title text, p_effective_at timestamptz,
                                           p_requires_acceptance boolean, p_material_change boolean, p_summary text)
returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.support_require_admin();
begin
  if p_effective_at is null then raise exception 'effective date required' using errcode = 'SP006'; end if;
  begin
    insert into public.legal_documents (slug, version, title, effective_at, published_at, requires_acceptance, material_change, summary)
    values (p_slug, p_version, btrim(p_title), p_effective_at, now(), coalesce(p_requires_acceptance, false),
            coalesce(p_material_change, false), btrim(coalesce(p_summary, '')));
  exception
    when unique_violation then raise exception 'version % of % already exists', p_version, p_slug using errcode = 'SP006';
    when check_violation then raise exception 'invalid document' using errcode = 'SP006';
  end;
  perform public.admin_log('legal.publish', 'legal_document', null,
    format('published %s v%s (effective %s)%s', p_slug, p_version, to_char(p_effective_at, 'YYYY-MM-DD'),
           case when p_material_change then ', material change' else '' end),
    jsonb_build_object('slug', p_slug, 'version', p_version));
end $$;

-- Draft documents for legal review: published so registration works on the
-- preview; the app labels every 0.x version "Draft — pending legal review".
insert into public.legal_documents (slug, version, title, effective_at, published_at, requires_acceptance, summary) values
  ('terms', '0.1', 'Terms of Service', now(), now(), true, 'First draft, pending legal review.'),
  ('privacy', '0.1', 'Privacy Policy', now(), now(), true, 'First draft, pending legal review.'),
  ('guidelines', '0.1', 'Community Guidelines', now(), now(), false, 'First draft, pending legal review.'),
  ('copyright', '0.1', 'Copyright and Content Ownership Policy', now(), now(), false, 'First draft, pending legal review.'),
  ('monetization', '0.1', 'Monetization Programme Terms', now(), now(), false, 'First draft, pending legal review.'),
  ('deletion', '0.1', 'Account Deletion and Data Retention Policy', now(), now(), false, 'First draft, pending legal review.'),
  ('cookies', '0.1', 'Cookie and Tracking Notice', now(), now(), false, 'First draft, pending legal review.');

-- ----------------------------------------------------------- monetization

create table public.monetization_settings (
  id                  boolean primary key default true check (id),
  -- Programme visible as open to creators. Off at launch.
  programme_open      boolean not null default false,
  -- Creators may submit eligibility applications. Off at launch.
  applications_open   boolean not null default false,
  -- Admin-defined criteria, e.g. {"min_verified_followers": 0}. Empty = not configured.
  criteria            jsonb not null default '{}'::jsonb check (jsonb_typeof(criteria) = 'object' and pg_column_size(criteria) <= 4096),
  -- Public note shown to creators (e.g. when the programme will open).
  public_note         text not null default '' check (char_length(public_note) <= 500),
  updated_by          uuid references public.profiles (id) on delete set null,
  updated_at          timestamptz not null default now()
);
insert into public.monetization_settings default values;

create table public.creator_applications (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (id) on delete cascade,
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  -- Engagement figures when the application was made (for the reviewer).
  snapshot      jsonb not null default '{}'::jsonb,
  submitted_at  timestamptz not null default now(),
  reviewed_by   uuid references public.profiles (id) on delete set null,
  reviewed_at   timestamptz,
  review_note   text not null default '' check (char_length(review_note) <= 500)
);
create unique index creator_applications_one_pending on public.creator_applications (user_id) where status = 'pending';
create index creator_applications_status_idx on public.creator_applications (status, submitted_at desc);

create table public.creator_monetization_status (
  user_id     uuid primary key references public.profiles (id) on delete cascade,
  status      text not null check (status in ('not_eligible', 'eligible', 'suspended')),
  reason      text not null default '' check (char_length(reason) <= 500),
  updated_by  uuid references public.profiles (id) on delete set null,
  updated_at  timestamptz not null default now()
);

create table public.monetization_fraud_flags (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  kind         text not null check (kind in ('support_farming', 'fake_followers', 'engagement_manipulation', 'duplicate_accounts', 'other')),
  detail       text not null default '' check (char_length(detail) <= 500),
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  resolved_by  uuid references public.profiles (id) on delete set null,
  resolved_at  timestamptz
);
create index monetization_fraud_flags_user_idx on public.monetization_fraud_flags (user_id) where resolved_at is null;

revoke all on public.monetization_settings, public.creator_applications, public.creator_monetization_status,
  public.monetization_fraud_flags from anon, authenticated;
alter table public.monetization_settings enable row level security;
alter table public.creator_applications enable row level security;
alter table public.creator_monetization_status enable row level security;
alter table public.monetization_fraud_flags enable row level security;

-- Engagement that counts: only accounts with a verified email, so throwaway
-- sign-ups don't inflate it. Support is one per person per request already
-- (support_visits primary key) and needs a real visit before confirming.
create function public.creator_engagement(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'verified_followers', (select count(*) from public.follows f join app_auth.users u on u.id = f.follower_id
                            where f.followee_id = p_user and u.email_confirmed_at is not null),
    'followers', (select follower_count from public.profiles where id = p_user),
    'posts_30d', (select count(*) from public.posts p where p.author_id = p_user and p.parent_id is null
                    and p.deleted_at is null and p.created_at > now() - interval '30 days'),
    'support_received', (select count(*) from public.support_visits v join public.support_requests r on r.id = v.request_id
                           join app_auth.users u on u.id = v.user_id
                          where r.creator_id = p_user and v.confirmed_at is not null and u.email_confirmed_at is not null),
    'support_requests_completed', (select count(*) from public.support_requests r where r.creator_id = p_user and r.status = 'completed'),
    'account_age_days', (select greatest(0, extract(day from now() - created_at))::int from public.profiles where id = p_user),
    'open_fraud_flags', (select count(*) from public.monetization_fraud_flags x where x.user_id = p_user and x.resolved_at is null)
  )
$$;

create function public.my_creator_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := (select app_auth.uid());
  s public.monetization_settings;
  st public.creator_monetization_status;
  app public.creator_applications;
begin
  if uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  select * into s from public.monetization_settings where id;
  select * into st from public.creator_monetization_status where user_id = uid;
  select * into app from public.creator_applications where user_id = uid order by submitted_at desc limit 1;
  return jsonb_build_object(
    'programme_open', s.programme_open,
    'applications_open', s.applications_open,
    'criteria', s.criteria,
    'public_note', s.public_note,
    'status', coalesce(st.status, 'not_eligible'),
    'status_reason', case when st.status = 'suspended' then st.reason else '' end,
    'standing', case when st.status = 'suspended' then 'restricted'
                     when exists (select 1 from public.monetization_fraud_flags x where x.user_id = uid and x.resolved_at is null) then 'under_review'
                     else 'good' end,
    'application', case when app.id is null then null else jsonb_build_object(
      'status', app.status, 'submitted_at', app.submitted_at, 'reviewed_at', app.reviewed_at,
      'review_note', case when app.status in ('approved', 'rejected') then app.review_note else '' end) end,
    'engagement', public.creator_engagement(uid) - 'open_fraud_flags'
  );
end $$;

create function public.apply_for_monetization() returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select app_auth.uid());
  s public.monetization_settings;
  app_id uuid;
begin
  if uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  select * into s from public.monetization_settings m where m.id;
  if not s.applications_open then raise exception 'applications are not open' using errcode = 'MN001'; end if;
  if exists (select 1 from public.creator_monetization_status where user_id = uid and status = 'suspended') then
    raise exception 'monetization is suspended for this account' using errcode = 'MN002';
  end if;
  begin
    insert into public.creator_applications (user_id, snapshot) values (uid, public.creator_engagement(uid)) returning creator_applications.id into app_id;
  exception when unique_violation then
    raise exception 'an application is already pending' using errcode = 'MN003';
  end;
  return app_id;
end $$;

create function public.admin_monetization_settings() returns public.monetization_settings
language plpgsql stable security definer set search_path = '' as $$
declare s public.monetization_settings;
begin
  perform public.support_require_admin();
  select * into s from public.monetization_settings where id;
  return s;
end $$;

create function public.admin_monetization_settings_set(p_programme_open boolean, p_applications_open boolean, p_criteria jsonb, p_public_note text)
returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.support_require_admin();
begin
  begin
    update public.monetization_settings
       set programme_open = coalesce(p_programme_open, programme_open),
           applications_open = coalesce(p_applications_open, applications_open),
           criteria = coalesce(p_criteria, criteria),
           public_note = coalesce(btrim(p_public_note), public_note),
           updated_by = uid, updated_at = now()
     where id;
  exception when check_violation then
    raise exception 'invalid settings' using errcode = 'SP006';
  end;
  perform public.admin_log('monetization.settings', 'monetization_settings', null,
    format('programme %s, applications %s', case when p_programme_open then 'open' else 'closed' end,
           case when p_applications_open then 'open' else 'closed' end),
    jsonb_build_object('programme_open', p_programme_open, 'applications_open', p_applications_open, 'criteria', p_criteria));
end $$;

create function public.admin_creator_applications(p_status text default 'pending')
returns table (id uuid, user_id uuid, username text, display_name text, avatar_url text, status text, snapshot jsonb,
               current jsonb, submitted_at timestamptz, reviewed_at timestamptz, review_note text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.support_require_admin();
  return query
    select a.id, a.user_id, p.username, p.display_name, p.avatar_url, a.status, a.snapshot,
           public.creator_engagement(a.user_id), a.submitted_at, a.reviewed_at, a.review_note
      from public.creator_applications a join public.profiles p on p.id = a.user_id
     where p_status = 'all' or a.status = p_status
     order by a.submitted_at desc
     limit 200;
end $$;

create function public.admin_creator_application_review(p_application uuid, p_decision text, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_admin();
  app public.creator_applications;
  handle text;
begin
  if p_decision not in ('approved', 'rejected') then raise exception 'bad decision' using errcode = 'SP006'; end if;
  select * into app from public.creator_applications where id = p_application for update;
  if app.id is null or app.status <> 'pending' then raise exception 'no pending application' using errcode = 'SP005'; end if;
  update public.creator_applications set status = p_decision, reviewed_by = uid, reviewed_at = now(),
         review_note = left(btrim(coalesce(p_note, '')), 500)
   where id = p_application;
  -- Approval marks the creator eligible; it enables nothing financial.
  if p_decision = 'approved' then
    insert into public.creator_monetization_status (user_id, status, reason, updated_by)
    values (app.user_id, 'eligible', 'application approved', uid)
    on conflict (user_id) do update set status = 'eligible', reason = excluded.reason, updated_by = uid, updated_at = now();
  end if;
  select username into handle from public.profiles where id = app.user_id;
  perform public.admin_log('monetization.application', 'profile', app.user_id,
    format('%s monetization application from @%s', p_decision, handle), jsonb_build_object('application', p_application));
end $$;

create function public.admin_monetization_status_set(p_user uuid, p_status text, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_admin();
  handle text := (select username from public.profiles where id = p_user);
begin
  if handle is null then raise exception 'no such user' using errcode = 'SP005'; end if;
  if p_status not in ('not_eligible', 'eligible', 'suspended') then raise exception 'bad status' using errcode = 'SP006'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'add a reason' using errcode = 'SP006'; end if;
  insert into public.creator_monetization_status (user_id, status, reason, updated_by)
  values (p_user, p_status, left(btrim(p_reason), 500), uid)
  on conflict (user_id) do update set status = excluded.status, reason = excluded.reason, updated_by = uid, updated_at = now();
  perform public.admin_log('monetization.status', 'profile', p_user, format('monetization status of @%s → %s — %s', handle, p_status, btrim(p_reason)));
end $$;

create function public.admin_monetization_flags(p_open_only boolean default true)
returns table (id uuid, user_id uuid, username text, kind text, detail text, created_at timestamptz, resolved_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.support_require_admin();
  return query
    select f.id, f.user_id, p.username, f.kind, f.detail, f.created_at, f.resolved_at
      from public.monetization_fraud_flags f join public.profiles p on p.id = f.user_id
     where not coalesce(p_open_only, true) or f.resolved_at is null
     order by f.created_at desc limit 200;
end $$;

create function public.admin_monetization_flag(p_user uuid, p_kind text, p_detail text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_admin();
  fid uuid;
begin
  begin
    insert into public.monetization_fraud_flags (user_id, kind, detail, created_by) values (p_user, p_kind, btrim(coalesce(p_detail, '')), uid)
    returning id into fid;
  exception when check_violation or foreign_key_violation then
    raise exception 'invalid flag' using errcode = 'SP006';
  end;
  perform public.admin_log('monetization.flag', 'profile', p_user, format('flagged for %s', p_kind));
  return fid;
end $$;

create function public.admin_monetization_flag_resolve(p_flag uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.support_require_admin(); who uuid;
begin
  update public.monetization_fraud_flags set resolved_by = uid, resolved_at = now() where id = p_flag and resolved_at is null
  returning user_id into who;
  if who is null then raise exception 'no open flag' using errcode = 'SP005'; end if;
  perform public.admin_log('monetization.flag_resolved', 'profile', who, 'resolved a monetization flag');
end $$;

-- -------------------------------------------------------------- grants

revoke execute on function
  public.legal_current(), public.legal_pending(), public.legal_accept(jsonb),
  public.admin_legal_documents(), public.admin_legal_publish(text, text, text, timestamptz, boolean, boolean, text),
  public.creator_engagement(uuid), public.my_creator_overview(), public.apply_for_monetization(),
  public.admin_monetization_settings(), public.admin_monetization_settings_set(boolean, boolean, jsonb, text),
  public.admin_creator_applications(text), public.admin_creator_application_review(uuid, text, text),
  public.admin_monetization_status_set(uuid, text, text), public.admin_monetization_flags(boolean),
  public.admin_monetization_flag(uuid, text, text), public.admin_monetization_flag_resolve(uuid)
  from public, anon, authenticated;

grant execute on function public.legal_current() to anon, authenticated;
grant execute on function
  public.legal_pending(), public.legal_accept(jsonb), public.my_creator_overview(), public.apply_for_monetization(),
  public.admin_legal_documents(), public.admin_legal_publish(text, text, text, timestamptz, boolean, boolean, text),
  public.admin_monetization_settings(), public.admin_monetization_settings_set(boolean, boolean, jsonb, text),
  public.admin_creator_applications(text), public.admin_creator_application_review(uuid, text, text),
  public.admin_monetization_status_set(uuid, text, text), public.admin_monetization_flags(boolean),
  public.admin_monetization_flag(uuid, text, text), public.admin_monetization_flag_resolve(uuid)
  to authenticated;
-- creator_engagement stays internal (called by the functions above).

$neon_step$; end $neon_wrap$;
