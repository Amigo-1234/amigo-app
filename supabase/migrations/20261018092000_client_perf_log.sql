-- =============================================================================
-- Privacy-safe performance monitoring (additive)
--
-- Phones report a few timings so admins can see how fast the app really is
-- for people (Core Web Vitals, API latency per endpoint, uploads, message
-- send times), split by connection type. Stored per sample: a metric name, a
-- number, the route with ids removed, the connection type the browser reports
-- (slow-2g/2g/3g/4g/unknown) and the app version. Not stored: who sent it —
-- rows have no user id; per-person rate limiting uses a short-lived counter
-- that is not joined to the rows. No message content, tokens, keys or URLs.
-- Rows older than 30 days are pruned on insert. Admins see percentiles only.
-- =============================================================================

create table public.client_perf (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  metric       text not null check (metric ~ '^[a-z0-9_:.-]{1,60}$'),
  value        real not null check (value >= 0 and value < 3600000),
  route        text not null default '' check (char_length(route) <= 120),
  net          text not null default 'unknown' check (net in ('slow-2g', '2g', '3g', '4g', 'unknown')),
  app_version  text not null default '' check (char_length(app_version) <= 40)
);
create index client_perf_recent on public.client_perf (created_at desc);
revoke all on public.client_perf from anon, authenticated;
alter table public.client_perf enable row level security;

create unlogged table public.client_perf_quota (
  user_id   uuid primary key,
  window_at timestamptz not null,
  n         integer not null
);
revoke all on public.client_perf_quota from anon, authenticated;
alter table public.client_perf_quota enable row level security;

-- A batch of up to 40 samples: [{ "m": "lcp", "v": 1234, "r": "/", "n": "4g" }, …]
create function public.log_client_perf(p_samples jsonb, p_version text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  q public.client_perf_quota;
begin
  if uid is null or jsonb_typeof(p_samples) <> 'array' then return; end if;
  select * into q from public.client_perf_quota where user_id = uid;
  if q.user_id is not null and q.window_at > now() - interval '1 hour' then
    if q.n >= 30 then return; end if;  -- at most 30 batches an hour per person; quietly dropped
    update public.client_perf_quota set n = n + 1 where user_id = uid;
  else
    insert into public.client_perf_quota (user_id, window_at, n) values (uid, now(), 1)
    on conflict (user_id) do update set window_at = now(), n = 1;
  end if;
  insert into public.client_perf (metric, value, route, net, app_version)
  select s ->> 'm',
         (s ->> 'v')::real,
         left(regexp_replace(coalesce(s ->> 'r', ''), '/[^/]*[0-9][^/]*', '/:id', 'g'), 120),
         case when s ->> 'n' in ('slow-2g', '2g', '3g', '4g') then s ->> 'n' else 'unknown' end,
         left(coalesce(p_version, ''), 40)
    from jsonb_array_elements(p_samples) with ordinality as t(s, i)
   where i <= 40
     and coalesce(s ->> 'm', '') ~ '^[a-z0-9_:.-]{1,60}$'
     and jsonb_typeof(s -> 'v') = 'number'
     and (s ->> 'v')::numeric >= 0 and (s ->> 'v')::numeric < 3600000;
  delete from public.client_perf where created_at < now() - interval '30 days';
end $$;

-- Admins: p50/p75/p95 and counts per metric (and route), by connection type.
create function public.admin_client_perf(p_hours integer default 24) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare since timestamptz := now() - make_interval(hours => least(greatest(coalesce(p_hours, 24), 1), 720));
begin
  perform public.support_require_admin();
  return jsonb_build_object(
    'since', since,
    'metrics', (select coalesce(jsonb_agg(x order by x.metric, x.net), '[]'::jsonb) from (
      select metric, net, count(*) as n,
             round(percentile_cont(0.5) within group (order by value)::numeric, 1) as p50,
             round(percentile_cont(0.75) within group (order by value)::numeric, 1) as p75,
             round(percentile_cont(0.95) within group (order by value)::numeric, 1) as p95
        from public.client_perf where created_at > since
       group by metric, net) x),
    'routes', (select coalesce(jsonb_agg(x order by x.n desc), '[]'::jsonb) from (
      select route, metric, count(*) as n,
             round(percentile_cont(0.75) within group (order by value)::numeric, 1) as p75
        from public.client_perf where created_at > since and metric in ('lcp', 'nav', 'feed_ready')
       group by route, metric order by count(*) desc limit 30) x));
end $$;

revoke execute on function public.log_client_perf(jsonb, text), public.admin_client_perf(integer) from public, anon, authenticated;
grant execute on function public.log_client_perf(jsonb, text), public.admin_client_perf(integer) to authenticated;
