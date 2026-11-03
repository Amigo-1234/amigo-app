-- =============================================================================
-- Creator Programme: restoring a suspended or revoked creator (applied to verify-1029 on 3 Nov 2026; not on Production)
--
-- Found by the API tests: creator_eligibility() counts a suspended or revoked
-- creator status against good standing, and admin_monetization_status_set()
-- requires eligibility to set "eligible". So restoring a suspended creator was
-- always refused (MN008), even when they met all six other requirements.
--
-- Fix: when an admin restores someone, their own creator status (the thing being
-- changed) is not held against them. Everything else still applies: the six other
-- requirements, an active account suspension and open fraud flags still block it.
-- Applying and approving are unchanged.
--
-- One function replaced, same signature. No table or data changes.
-- Undo: restore admin_monetization_status_set from 20261105090000_creator_eligibility.sql.
-- =============================================================================

create or replace function public.admin_monetization_status_set(p_user uuid, p_status text, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_admin();
  handle text := (select username from public.profiles where id = p_user);
  e jsonb;
begin
  if handle is null then raise exception 'no such user' using errcode = 'SP005'; end if;
  if p_status not in ('not_eligible', 'eligible', 'suspended', 'revoked') then raise exception 'bad status' using errcode = 'SP006'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'add a reason' using errcode = 'SP006'; end if;
  if p_status = 'eligible' then
    e := public.creator_eligibility(p_user);
    -- Every requirement met, ignoring only standing reasons that are this creator status itself.
    if exists (
      select 1 from jsonb_array_elements(e -> 'requirements') x
       where not (x->>'met')::boolean
         and not (x->>'key' = 'good_standing'
                  and not exists (select 1 from jsonb_array_elements_text(x -> 'reasons') r
                                   where r not in ('creator_suspended', 'creator_revoked')))
    ) then
      raise exception 'this creator does not meet every requirement' using errcode = 'MN008';
    end if;
  end if;
  insert into public.creator_monetization_status (user_id, status, reason, updated_by)
  values (p_user, p_status, left(btrim(p_reason), 500), uid)
  on conflict (user_id) do update set status = excluded.status, reason = excluded.reason, updated_by = uid, updated_at = now();
  perform public.admin_log('monetization.status', 'profile', p_user, format('monetization status of @%s → %s — %s', handle, p_status, btrim(p_reason)));
end $$;
