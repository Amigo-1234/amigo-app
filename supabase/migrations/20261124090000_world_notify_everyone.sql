-- =============================================================================
-- "Notify everyone" Worlds (launch night, 24 Nov 2026)
--
-- Normally a World's "it's live" notice goes to its members only (worlds_mark_live).
-- A World with notify_everyone = true also sends that notice to every account when
-- it goes live, so a launch or community-wide event reaches people who haven't
-- joined yet. Same notice, same in-app display and push (world_push_targets), and
-- each person's "World notifications" setting is still respected for push.
-- Suspended accounts are left out. Members aren't notified twice (unique notice).
--
-- Additive: one column (default false, so existing Worlds are unchanged) and one
-- trigger. Undo: drop the trigger, the function and the column.
-- =============================================================================

alter table public.worlds add column notify_everyone boolean not null default false;

create function public.worlds_notify_everyone() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.notify_everyone and old.live_notified_at is null and new.live_notified_at is not null then
    insert into public.world_notices (recipient_id, world_id, kind)
    select p.id, new.id, 'live'
    from public.profiles p
    where not public.is_suspended(p.id)
    on conflict do nothing;
  end if;
  return null;
end $$;
revoke execute on function public.worlds_notify_everyone() from public, anon, authenticated;

create trigger worlds_notify_everyone after update of live_notified_at on public.worlds
  for each row execute function public.worlds_notify_everyone();
