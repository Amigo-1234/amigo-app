-- =============================================================================
-- Privacy-safe client error log (additive)
--
-- The app reports uncaught errors so admins can see error rates. Stored: a
-- redacted message (emails, ids, numbers, URLs replaced on the device and
-- again here), the route with ids removed, the app version. Not stored: who
-- reported it — rows have no user id, and per-person rate limiting uses a
-- short-lived counter that is not joined to the rows. Rows older than 30
-- days are pruned on insert. Admins see aggregates only.
-- =============================================================================

create table public.client_errors (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  kind         text not null check (kind in ('error', 'unhandledrejection', 'render')),
  message      text not null check (char_length(message) <= 300),
  route        text not null default '' check (char_length(route) <= 120),
  app_version  text not null default '' check (char_length(app_version) <= 40)
);
create index client_errors_recent on public.client_errors (created_at desc);
revoke all on public.client_errors from anon, authenticated;
alter table public.client_errors enable row level security;

-- Per-person counter for the last hour (no link to the error rows).
create unlogged table public.client_error_quota (
  user_id   uuid primary key,
  window_at timestamptz not null,
  n         integer not null
);
revoke all on public.client_error_quota from anon, authenticated;
alter table public.client_error_quota enable row level security;

create function public.redact_error_text(p text) returns text
language sql immutable set search_path = '' as $$
  select left(
    regexp_replace(regexp_replace(regexp_replace(regexp_replace(coalesce(p, ''),
      '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+', '<email>', 'g'),
      'https?://[^ )"'']+', '<url>', 'g'),
      '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', '<id>', 'g'),
      '[0-9]{4,}', '<n>', 'g'),
    300)
$$;

create function public.log_client_error(p_kind text, p_message text, p_route text, p_version text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  q public.client_error_quota;
begin
  if uid is null then return; end if;
  select * into q from public.client_error_quota where user_id = uid;
  if q.user_id is not null and q.window_at > now() - interval '1 hour' then
    if q.n >= 20 then return; end if;  -- quietly drop floods
    update public.client_error_quota set n = n + 1 where user_id = uid;
  else
    insert into public.client_error_quota (user_id, window_at, n) values (uid, now(), 1)
    on conflict (user_id) do update set window_at = now(), n = 1;
  end if;
  insert into public.client_errors (kind, message, route, app_version)
  values (case when p_kind in ('error', 'unhandledrejection', 'render') then p_kind else 'error' end,
          public.redact_error_text(p_message),
          left(regexp_replace(coalesce(p_route, ''), '/[^/]*[0-9][^/]*', '/:id', 'g'), 120),
          left(coalesce(p_version, ''), 40));
  delete from public.client_errors where created_at < now() - interval '30 days';
end $$;

create function public.admin_client_errors(p_hours integer default 24) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare since timestamptz := now() - make_interval(hours => least(greatest(coalesce(p_hours, 24), 1), 720));
begin
  perform public.support_require_admin();
  return jsonb_build_object(
    'total', (select count(*) from public.client_errors where created_at > since),
    'top', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
              select message, route, app_version, count(*) as n, max(created_at) as last_at
                from public.client_errors where created_at > since
               group by 1, 2, 3 order by n desc limit 20) x));
end $$;

revoke execute on function public.redact_error_text(text), public.log_client_error(text, text, text, text), public.admin_client_errors(integer)
  from public, anon, authenticated;
grant execute on function public.log_client_error(text, text, text, text), public.admin_client_errors(integer) to authenticated;
