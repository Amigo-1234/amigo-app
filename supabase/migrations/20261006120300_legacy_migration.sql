-- =============================================================================
-- legacy — bookkeeping for the one-time Firebase → Supabase migration
--
-- This schema is NOT exposed through the Data API (it is not in
-- [api].schemas) and anon/authenticated have no privileges on it. Only the
-- migration script (service role / postgres) reads and writes it.
--
-- Every migrated row is traceable to its Firebase document, and the maps make
-- the migration idempotent: re-running it updates/skips instead of duplicating.
-- Drop the whole schema once Firebase is decommissioned and nobody needs the
-- trail any more.
-- =============================================================================

create schema if not exists legacy;
revoke all on schema legacy from public, anon, authenticated;
alter default privileges in schema legacy revoke all on tables from public, anon, authenticated;

-- Firebase uid  →  Supabase auth user
create table legacy.user_map (
  firebase_uid          text primary key,
  user_id               uuid not null unique references auth.users (id) on delete cascade,
  -- 'created': the migration created the auth user
  -- 'linked':  an auth user with the same email already existed and was reused
  link_method           text not null check (link_method in ('created', 'linked')),
  email_at_migration    text,
  -- Set when the person proves their Firebase password (legacy-sign-in function)
  -- or resets their password; until then they cannot sign in with a password.
  password_migrated_at  timestamptz,
  migrated_at           timestamptz not null default now()
);

-- Firestore post/comment path  →  posts row
create table legacy.post_map (
  firebase_path  text primary key,            -- "posts/{id}" or "posts/{id}/comments/{id}"
  post_id        uuid not null unique references public.posts (id) on delete cascade,
  kind           text not null check (kind in ('post', 'comment')),
  -- Fields with no home in the new schema (category, savedBy, legacy reaction
  -- counters, original field aliases), kept verbatim for reference.
  raw_meta       jsonb not null default '{}'::jsonb,
  migrated_at    timestamptz not null default now()
);

-- Inline base64 image in Firestore  →  Storage object + post_media row
create table legacy.media_map (
  source_key    text primary key,             -- "posts/{id}#0"
  media_id      uuid not null unique references public.post_media (id) on delete cascade,
  sha256        text not null,
  migrated_at   timestamptz not null default now()
);

-- Non-like reactions (lol, wow, cry, fire) have no product equivalent yet.
-- Kept here so they can be restored if richer reactions ship.
create table legacy.reaction_archive (
  firebase_post_path  text not null,
  firebase_uid        text not null,
  kind                text not null,
  user_id             uuid references auth.users (id) on delete set null,
  post_id             uuid references public.posts (id) on delete cascade,
  primary key (firebase_post_path, firebase_uid, kind)
);

-- "savedBy" arrays → future bookmarks.
create table legacy.saved_post_archive (
  firebase_post_path  text not null,
  firebase_uid        text not null,
  user_id             uuid references auth.users (id) on delete set null,
  post_id             uuid references public.posts (id) on delete cascade,
  primary key (firebase_post_path, firebase_uid)
);

-- The prototype's public "globalChat" room. Archived, not migrated into the
-- product: Messages will be private conversations, a different thing.
create table legacy.global_chat_archive (
  firebase_id   text primary key,
  firebase_uid  text,
  user_id       uuid references auth.users (id) on delete set null,
  author_name   text,
  body          text not null,
  created_at    timestamptz
);

create table legacy.migration_runs (
  id                     bigint generated always as identity primary key,
  started_at             timestamptz not null default now(),
  finished_at            timestamptz,
  snapshot_source        text not null,
  snapshot_extracted_at  timestamptz not null,
  summary                jsonb
);

-- Lookup used by the legacy-sign-in Edge Function (service role only).
create function legacy.find_unmigrated_user(p_email text)
returns table (user_id uuid, firebase_uid text)
language sql stable security definer set search_path = '' as $$
  select m.user_id, m.firebase_uid
  from legacy.user_map m
  join auth.users u on u.id = m.user_id
  where lower(u.email) = lower(p_email)
    and m.password_migrated_at is null
  limit 1;
$$;
revoke execute on function legacy.find_unmigrated_user(text) from public, anon, authenticated;

create function legacy.mark_password_migrated(p_user_id uuid) returns void
language sql security definer set search_path = '' as $$
  update legacy.user_map set password_migrated_at = now()
  where user_id = p_user_id and password_migrated_at is null;
$$;
revoke execute on function legacy.mark_password_migrated(uuid) from public, anon, authenticated;

-- Any password set on a migrated account (reset flow or legacy sign-in) means
-- the person no longer depends on their Firebase password.
create function legacy.on_auth_password_set() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.encrypted_password is distinct from old.encrypted_password
     and coalesce(new.encrypted_password, '') <> '' then
    perform legacy.mark_password_migrated(new.id);
  end if;
  return new;
end $$;

create trigger on_auth_password_set after update of encrypted_password on auth.users
  for each row execute function legacy.on_auth_password_set();

-- Data API entry points for the legacy-sign-in Edge Function. The legacy
-- schema itself is not exposed, so these thin wrappers live in public and are
-- executable by service_role ONLY.
create function public.legacy_find_unmigrated_user(p_email text)
returns table (user_id uuid, firebase_uid text)
language sql stable security definer set search_path = '' as $$
  select * from legacy.find_unmigrated_user(p_email);
$$;

revoke execute on function public.legacy_find_unmigrated_user(text) from public, anon, authenticated;
grant execute on function public.legacy_find_unmigrated_user(text) to service_role;
