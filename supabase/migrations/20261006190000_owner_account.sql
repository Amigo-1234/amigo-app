-- =============================================================================
-- Amigo World — owner account bootstrap (admin + Official Amigo verification)
--
-- Additive. Decides who the owner is in the database, from the authenticated
-- account — never from anything the app sends:
--
--   admin_private.owner_accounts   emails of owner accounts. Private schema with
--                                  no grants: clients can't read or write it.
--                                  Filled once by an operator as the service role
--                                  (see docs/migration/RUNBOOK.md) — the email is
--                                  deliberately NOT in this file or in git.
--
-- When an auth account with one of those emails exists AND its email is
-- confirmed (so nobody can claim it by signing up with the address), it gets:
--   - a row in public.app_admins
--   - public.profile_verifications type 'amigo_team' (Official Amigo account)
-- This happens on sign-up/confirmation (trigger on auth.users), on legacy
-- import (same trigger), and when an owner email is registered for an
-- account that already exists (trigger on owner_accounts).
--
-- Normal users still can't grant themselves either: app_admins and
-- profile_verifications have no client write grants (earlier migrations).
-- =============================================================================

create schema if not exists admin_private;
revoke all on schema admin_private from public, anon, authenticated;

create table admin_private.owner_accounts (
  email       text primary key check (email = lower(btrim(email)) and email like '%@%'),
  note        text not null default 'Amigo owner',
  created_at  timestamptz not null default now()
);
revoke all on admin_private.owner_accounts from public, anon, authenticated;

-- Grants owner status to one auth user if their confirmed email is registered.
create function admin_private.apply_owner_account(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  u record;
begin
  select id, lower(email) as email, email_confirmed_at into u from auth.users where id = p_user;
  if u.id is null or u.email_confirmed_at is null then return; end if;
  if not exists (select 1 from admin_private.owner_accounts o where o.email = u.email) then return; end if;
  if not exists (select 1 from public.profiles where id = u.id) then return; end if;

  insert into public.app_admins (user_id, note) values (u.id, 'owner account')
  on conflict (user_id) do nothing;
  insert into public.profile_verifications (user_id, verification_type, note, verified_by)
  values (u.id, 'amigo_team', 'Official Amigo account (owner)', null)
  on conflict (user_id) do update set verification_type = 'amigo_team', note = excluded.note;
end $$;

create function admin_private.owner_on_auth_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform admin_private.apply_owner_account(new.id);
  return null;
end $$;

-- Named to sort after on_auth_user_created, so the profile row already exists.
create trigger owner_account_after_auth after insert or update of email, email_confirmed_at on auth.users
  for each row execute function admin_private.owner_on_auth_user();

create function admin_private.owner_on_register() returns trigger
language plpgsql security definer set search_path = '' as $$
declare uid uuid;
begin
  for uid in select id from auth.users where lower(email) = new.email loop
    perform admin_private.apply_owner_account(uid);
  end loop;
  return null;
end $$;

create trigger owner_account_registered after insert on admin_private.owner_accounts
  for each row execute function admin_private.owner_on_register();

revoke execute on all functions in schema admin_private from public, anon, authenticated;
