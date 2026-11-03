-- =============================================================================
-- Amigo World — Neon compatibility prelude
--
-- Runs before the Supabase migrations (see scripts/neon/build-schema.mjs) so
-- they apply to Neon unchanged in substance. What differs on Neon, as checked
-- on the real project (not assumed):
--
--   * Users live in neon_auth."user" (Managed Better Auth), ids are uuid.
--     We can't create objects in Neon's `auth` schema, so the migrations'
--     auth.users becomes app_auth.users: an app-owned mirror kept in sync by a
--     trigger on neon_auth."user". emailVerified -> email_confirmed_at, so the
--     owner account still only gets admin after its email is verified.
--   * auth.uid() exists (pg_session_jwt, reads the Data API's validated JWT),
--     but the Data API roles have no USAGE on Neon's `auth` schema. The
--     migrations call app_auth.uid() instead, a thin wrapper.
--   * The Data API's signed-out role is `anonymous`; the migrations grant to
--     `anon`, so `anonymous` inherits `anon`.
--   * No Supabase Storage or Realtime: storage.* exists only so storage
--     policies compile (unused on Neon); publication lines are dropped.
-- =============================================================================

-- Roles ----------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
end $$;
grant anon to anonymous;

-- app_auth: uid() + users mirror ---------------------------------------------
create schema if not exists app_auth;
revoke all on schema app_auth from public;
grant usage on schema app_auth to anon, authenticated;

create function app_auth.uid() returns uuid
language sql stable security definer set search_path = '' as $$ select auth.uid() $$;
revoke execute on function app_auth.uid() from public;
grant execute on function app_auth.uid() to anon, authenticated;

create table app_auth.users (
  id                  uuid primary key,
  email               text,
  email_confirmed_at  timestamptz,
  raw_user_meta_data  jsonb not null default '{}'::jsonb,
  raw_app_meta_data   jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
revoke all on app_auth.users from public, anon, authenticated;

create function app_auth.sync_neon_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    delete from app_auth.users where id = old.id;
    return old;
  elsif tg_op = 'INSERT' then
    insert into app_auth.users (id, email, email_confirmed_at, raw_user_meta_data, created_at)
    values (new.id, new.email, case when new."emailVerified" then now() end,
            jsonb_build_object('display_name', coalesce(new.name, '')), coalesce(new."createdAt", now()))
    on conflict (id) do nothing;
  else
    -- A changed email is unconfirmed until Neon Auth says it's verified.
    update app_auth.users u
       set email = new.email,
           email_confirmed_at = case
             when not coalesce(new."emailVerified", false) then null
             when lower(u.email) is distinct from lower(new.email) then now()
             else coalesce(u.email_confirmed_at, now()) end,
           updated_at = now()
     where u.id = new.id
       and (u.email is distinct from new.email
            or (u.email_confirmed_at is not null) is distinct from coalesce(new."emailVerified", false));
  end if;
  return new;
end $$;
revoke execute on function app_auth.sync_neon_user() from public;

create trigger amigo_sync_user after insert or update of email, "emailVerified" or delete on neon_auth."user"
  for each row execute function app_auth.sync_neon_user();

-- Storage stand-in (policies compile; nothing uses it on Neon yet) ------------
create schema if not exists storage;
revoke all on schema storage from public;
create table if not exists storage.buckets (
  id                  text primary key,
  name                text not null,
  public              boolean default false,
  file_size_limit     bigint,
  allowed_mime_types  text[],
  created_at          timestamptz default now()
);
create table if not exists storage.objects (
  id          uuid primary key default gen_random_uuid(),
  bucket_id   text references storage.buckets (id),
  name        text,
  owner       uuid,
  metadata    jsonb,
  created_at  timestamptz default now(),
  unique (bucket_id, name)
);
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
$$;
