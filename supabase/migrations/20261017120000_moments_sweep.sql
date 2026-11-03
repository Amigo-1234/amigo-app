-- =============================================================================
-- Moments — expiry clean-up without a scheduler (additive)
--
-- Expired Moments are already hidden by moment_visible() the moment they
-- expire. Where nothing runs purge_expired_moments() on a schedule (Neon Free
-- has no cron), posting a Moment sweeps rows that expired over an hour ago.
-- Their photo paths go to media_cleanup_queue, for whichever media service
-- holds the files to delete them; nothing is lost silently.
-- =============================================================================

create table public.media_cleanup_queue (
  id         bigint generated always as identity primary key,
  bucket     text not null check (char_length(bucket) between 1 and 64),
  path       text not null check (char_length(path) between 1 and 300),
  reason     text not null default '' check (char_length(reason) <= 100),
  queued_at  timestamptz not null default now()
);
revoke all on public.media_cleanup_queue from anon, authenticated;
alter table public.media_cleanup_queue enable row level security;

create index moments_expires_all on public.moments (expires_at);

create function public.moments_sweep() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  with gone as (
    delete from public.moments where expires_at < now() - interval '1 hour' returning media_path
  ), queued as (
    insert into public.media_cleanup_queue (bucket, path, reason)
    select 'moment-media', g.media_path, 'moment expired' from gone g where g.media_path is not null
  )
  select count(*) into n from gone;
  return n;
end $$;

create function public.moments_sweep_trigger() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.moments_sweep();
  return null;
end $$;

create trigger moments_sweep_after_insert after insert on public.moments
  for each statement execute function public.moments_sweep_trigger();

revoke execute on function public.moments_sweep(), public.moments_sweep_trigger() from public, anon, authenticated;
-- Both internal: run by the trigger (as the definer) or by an operator.
