-- =============================================================================
-- Amigo World — core social schema
--
--   profiles      public identity for every auth user (no email here, ever)
--   posts         posts AND replies AND reposts in one table (see README)
--   post_media    images/videos in Supabase Storage, up to 4 per post
--   post_likes    one row per (user, post)
--   follows       one row per (follower, followee)
--
-- Counters (likes, replies, reposts, followers…) are maintained by triggers
-- and are not writable by clients.
-- =============================================================================

create type public.post_visibility as enum ('public', 'followers');
create type public.media_kind as enum ('image', 'video');

-- ---------------------------------------------------------------- profiles

create table public.profiles (
  id              uuid primary key references auth.users (id) on delete cascade,
  username        text not null,
  display_name    text not null,
  bio             text not null default '',
  avatar_url      text,
  follower_count  integer not null default 0,
  following_count integer not null default 0,
  post_count      integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint profiles_username_format check (username ~ '^[a-z0-9_]{3,24}$'),
  constraint profiles_display_name_length check (char_length(btrim(display_name)) between 1 and 50),
  constraint profiles_bio_length check (char_length(bio) <= 160),
  constraint profiles_avatar_url_https check (avatar_url is null or avatar_url ~ '^https://')
);

create unique index profiles_username_key on public.profiles (username);

comment on table public.profiles is 'Public profile for each auth user. Email and auth metadata stay in auth.users.';

-- ------------------------------------------------------------------- posts

create table public.posts (
  id            uuid primary key default gen_random_uuid(),
  author_id     uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  body          text not null default '',
  -- Replies: parent is the post being answered, root is the top of the thread.
  parent_id     uuid references public.posts (id) on delete cascade,
  root_id       uuid references public.posts (id) on delete cascade,
  -- Reposts (body = '') and quote posts (body <> '') point at the original.
  repost_of_id  uuid references public.posts (id) on delete cascade,
  visibility    public.post_visibility not null default 'public',
  like_count    integer not null default 0,
  reply_count   integer not null default 0,
  repost_count  integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  constraint posts_body_length check (char_length(body) <= 2000),
  constraint posts_reply_xor_repost check (parent_id is null or repost_of_id is null),
  constraint posts_root_iff_parent check ((parent_id is null) = (root_id is null)),
  constraint posts_not_self_parent check (parent_id is distinct from id and repost_of_id is distinct from id)
);

-- Home timeline: newest top-level posts.
create index posts_timeline_idx on public.posts (created_at desc, id desc)
  where parent_id is null and deleted_at is null;
-- Profile timelines and the Following feed.
create index posts_author_created_idx on public.posts (author_id, created_at desc)
  where deleted_at is null;
-- Conversation view.
create index posts_parent_created_idx on public.posts (parent_id, created_at)
  where parent_id is not null;
create index posts_root_idx on public.posts (root_id) where root_id is not null;
create index posts_repost_of_idx on public.posts (repost_of_id) where repost_of_id is not null;
-- A person can plainly repost a given post only once (quotes are unlimited).
create unique index posts_one_repost_per_user on public.posts (author_id, repost_of_id)
  where repost_of_id is not null and body = '' and deleted_at is null;

comment on column public.posts.parent_id is 'Set for replies. Replies are posts so they can be liked, reposted and carry media like any post.';

-- -------------------------------------------------------------- post_media

create table public.post_media (
  id            uuid primary key default gen_random_uuid(),
  post_id       uuid not null references public.posts (id) on delete cascade,
  owner_id      uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  position      smallint not null default 0,
  kind          public.media_kind not null,
  bucket        text not null default 'post-media',
  storage_path  text not null,
  mime_type     text not null,
  width         integer,
  height        integer,
  duration_ms   integer,
  byte_size     bigint,
  alt           text,
  created_at    timestamptz not null default now(),
  constraint post_media_position_range check (position between 0 and 3),
  constraint post_media_dimensions check ((width is null or width > 0) and (height is null or height > 0)),
  constraint post_media_alt_length check (alt is null or char_length(alt) <= 1000),
  constraint post_media_path_owned check (storage_path like owner_id::text || '/%'),
  unique (post_id, position),
  unique (bucket, storage_path)
);

create index post_media_owner_idx on public.post_media (owner_id);

-- -------------------------------------------------------------- post_likes

create table public.post_likes (
  user_id     uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  post_id     uuid not null references public.posts (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, post_id)
);

create index post_likes_post_idx on public.post_likes (post_id, created_at desc);

-- ----------------------------------------------------------------- follows

create table public.follows (
  follower_id  uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  followee_id  uuid not null references public.profiles (id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (follower_id, followee_id),
  constraint follows_not_self check (follower_id <> followee_id)
);

create index follows_followee_idx on public.follows (followee_id, created_at desc);

-- =============================================================================
-- Triggers
-- All trigger functions are SECURITY DEFINER with an empty search_path, so
-- they can maintain counters that clients cannot write directly.
-- =============================================================================

create function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();
create trigger posts_touch before update on public.posts
  for each row execute function public.touch_updated_at();

-- Replies inherit their thread root; replying to a deleted post is refused.
create function public.posts_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  parent record;
begin
  if new.parent_id is not null then
    select id, root_id, deleted_at into parent from public.posts where id = new.parent_id;
    if parent.id is null or parent.deleted_at is not null then
      raise exception 'cannot reply to a missing or deleted post' using errcode = '23503';
    end if;
    new.root_id := coalesce(parent.root_id, parent.id);
  else
    new.root_id := null;
  end if;
  return new;
end $$;

create trigger posts_before_insert before insert on public.posts
  for each row execute function public.posts_before_insert();

-- Keep reply/repost/post counters in step with inserts, soft deletes and hard deletes.
create function public.posts_counters() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  delta integer;
  rec public.posts;
begin
  if tg_op = 'INSERT' then
    delta := 1; rec := new;
    if new.deleted_at is not null then return null; end if;
  elsif tg_op = 'DELETE' then
    delta := -1; rec := old;
    if old.deleted_at is not null then return null; end if; -- already uncounted
  else -- UPDATE of deleted_at
    if (old.deleted_at is null) = (new.deleted_at is null) then return null; end if;
    delta := case when new.deleted_at is null then 1 else -1 end;
    rec := new;
  end if;

  if rec.parent_id is not null then
    update public.posts set reply_count = greatest(reply_count + delta, 0) where id = rec.parent_id;
  elsif rec.repost_of_id is not null then
    update public.posts set repost_count = greatest(repost_count + delta, 0) where id = rec.repost_of_id;
  end if;
  if rec.parent_id is null then
    update public.profiles set post_count = greatest(post_count + delta, 0) where id = rec.author_id;
  end if;
  return null;
end $$;

create trigger posts_counters_ins after insert on public.posts
  for each row execute function public.posts_counters();
create trigger posts_counters_del after delete on public.posts
  for each row execute function public.posts_counters();
create trigger posts_counters_upd after update of deleted_at on public.posts
  for each row execute function public.posts_counters();

create function public.post_likes_counter() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    update public.posts set like_count = like_count + 1 where id = new.post_id;
  else
    update public.posts set like_count = greatest(like_count - 1, 0) where id = old.post_id;
  end if;
  return null;
end $$;

create trigger post_likes_counter after insert or delete on public.post_likes
  for each row execute function public.post_likes_counter();

create function public.follows_counter() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  d integer := case when tg_op = 'INSERT' then 1 else -1 end;
  r public.follows := case when tg_op = 'INSERT' then new else old end;
begin
  update public.profiles set following_count = greatest(following_count + d, 0) where id = r.follower_id;
  update public.profiles set follower_count = greatest(follower_count + d, 0) where id = r.followee_id;
  return null;
end $$;

create trigger follows_counter after insert or delete on public.follows
  for each row execute function public.follows_counter();

-- ------------------------------------------------------------ usernames

-- Turns any display name into an available username. Never derived from email
-- (that would leak part of a private address into a public handle).
create function public.generate_username(seed text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  base text;
  candidate text;
  attempt integer := 0;
begin
  base := lower(coalesce(seed, ''));
  base := translate(base, 'àáâãäåāçćčèéêëēėęìíîïīįłñńòóôõöøōśšùúûüūÿýžźż', 'aaaaaaaccceeeeeeeiiiiiilnnooooooossuuuuuyyzzz');
  base := regexp_replace(base, '[^a-z0-9_]+', '_', 'g');
  base := btrim(base, '_');
  base := left(base, 20);
  if char_length(base) < 3 then
    base := 'amigo' || case when base = '' then '' else '_' || base end;
  end if;
  candidate := base;
  while exists (select 1 from public.profiles where username = candidate) loop
    attempt := attempt + 1;
    candidate := left(base, 19) || '_' || (floor(random() * 9000) + 1000)::int::text;
    if attempt > 50 then
      candidate := 'amigo_' || replace(gen_random_uuid()::text, '-', '')::text;
      candidate := left(candidate, 24);
    end if;
  end loop;
  return candidate;
end $$;

-- Every new auth user gets a profile. Name comes from sign-up metadata.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  name text := nullif(btrim(left(coalesce(meta ->> 'display_name', meta ->> 'full_name', meta ->> 'name', ''), 50)), '');
  wanted text := lower(nullif(btrim(meta ->> 'username'), ''));
  final_username text;
begin
  if wanted is not null and wanted ~ '^[a-z0-9_]{3,24}$'
     and not exists (select 1 from public.profiles where username = wanted) then
    final_username := wanted;
  else
    final_username := public.generate_username(coalesce(name, wanted));
  end if;

  insert into public.profiles (id, username, display_name)
  values (new.id, final_username, coalesce(name, final_username));
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
