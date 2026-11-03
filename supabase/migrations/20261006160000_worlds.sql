-- =============================================================================
-- Amigo World — Worlds (scheduled live social events), MVP
--
-- Additive: four new tables, two new columns on posts (nullable / defaulted,
-- so existing rows and queries are unaffected), triggers, two RPCs, policies.
--
--   worlds               the events. Created and edited by Amigo admins only
--                        (service role / SQL editor): clients have no write grant.
--   world_members        who joined. People join/leave themselves until the World ends.
--   world_host_picks     "Amigo pick" bonus for competition entries. Admin-only writes.
--   world_chat_messages  simple live chat while a World is live.
--   posts.world_id       a post made inside a World (replies inherit their thread's World)
--   posts.is_entry       a competition entry
--
-- Points are not stored: world_leaderboard() computes them from likes and
-- replies on entries made before the World ended, so they can't be forged
-- and freeze automatically at the end. Points never come from follower counts.
-- No payments, prizes are display text only.
-- =============================================================================

create table public.worlds (
  id                uuid primary key default gen_random_uuid(),
  slug              text not null unique,
  title             text not null,
  tagline           text not null default '',
  description       text not null default '',
  cover_url         text,
  starts_at         timestamptz not null,
  ends_at           timestamptz not null,
  -- Competition mode (all of these are ignored when competition = false).
  competition       boolean not null default false,
  entries_close_at  timestamptz,
  entry_limit       smallint not null default 1,
  points_reaction   integer not null default 1,
  points_reply      integer not null default 2,
  points_host_pick  integer not null default 0,
  prize             text,
  participant_count integer not null default 0,
  created_by        uuid references public.profiles (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint worlds_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) between 3 and 60),
  constraint worlds_title_length check (char_length(btrim(title)) between 1 and 80),
  constraint worlds_tagline_length check (char_length(tagline) <= 140),
  constraint worlds_description_length check (char_length(description) <= 2000),
  constraint worlds_cover_https check (cover_url is null or cover_url ~ '^https://'),
  constraint worlds_prize_length check (prize is null or char_length(prize) <= 280),
  constraint worlds_times check (ends_at > starts_at),
  constraint worlds_competition_window check (
    (competition and entries_close_at is not null and entries_close_at > starts_at and entries_close_at <= ends_at)
    or (not competition and entries_close_at is null)),
  constraint worlds_scoring_sane check (
    entry_limit between 1 and 10 and points_reaction between 0 and 100
    and points_reply between 0 and 100 and points_host_pick between 0 and 1000)
);

create index worlds_starts_idx on public.worlds (starts_at);
create trigger worlds_touch before update on public.worlds
  for each row execute function public.touch_updated_at();

comment on table public.worlds is 'Admin-created events. No client write access; status (upcoming/live/finished) is derived from starts_at/ends_at.';

create table public.world_members (
  world_id   uuid not null references public.worlds (id) on delete cascade,
  user_id    uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  joined_at  timestamptz not null default now(),
  primary key (world_id, user_id)
);
create index world_members_user_idx on public.world_members (user_id);
create index world_members_recent_idx on public.world_members (world_id, joined_at desc);

create table public.world_host_picks (
  world_id    uuid not null references public.worlds (id) on delete cascade,
  post_id     uuid not null references public.posts (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (world_id, post_id)
);

create table public.world_chat_messages (
  id          uuid primary key default gen_random_uuid(),
  world_id    uuid not null references public.worlds (id) on delete cascade,
  author_id   uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  body        text not null,
  created_at  timestamptz not null default now(),
  constraint world_chat_body_length check (char_length(btrim(body)) between 1 and 300)
);
create index world_chat_recent_idx on public.world_chat_messages (world_id, created_at desc);
create index world_chat_author_idx on public.world_chat_messages (author_id);

-- Deleting a World keeps its posts (they're people's content); they just lose
-- the World link. is_entry only means something together with world_id.
alter table public.posts
  add column world_id uuid references public.worlds (id) on delete set null,
  add column is_entry boolean not null default false;

create index posts_world_idx on public.posts (world_id, created_at desc)
  where world_id is not null and deleted_at is null;
create index posts_world_entries_idx on public.posts (world_id, author_id)
  where is_entry and deleted_at is null;

-- ---------------------------------------------------------------- triggers

create function public.world_members_counter() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  d integer := case when tg_op = 'INSERT' then 1 else -1 end;
  r public.world_members := case when tg_op = 'INSERT' then new else old end;
begin
  update public.worlds set participant_count = greatest(participant_count + d, 0) where id = r.world_id;
  return null;
end $$;

create trigger world_members_counter after insert or delete on public.world_members
  for each row execute function public.world_members_counter();

-- Posts in Worlds: replies inherit the thread's World (and are never entries);
-- a top-level World post needs a live World and membership; entries also need
-- competition mode, open entries and a free entry slot. World posts are public.
-- Errors use codes AW001–AW005 so the app can explain them.
create function public.posts_world_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  w public.worlds;
begin
  if new.parent_id is not null then
    select world_id into new.world_id from public.posts where id = new.parent_id;
    new.is_entry := false;
    return new;
  end if;
  if new.world_id is null then
    return new;
  end if;

  select * into w from public.worlds where id = new.world_id;
  if w.id is null then
    raise exception 'no such World' using errcode = '23503';
  end if;
  if now() < w.starts_at or now() >= w.ends_at then
    raise exception 'this World is not live' using errcode = 'AW001';
  end if;
  if not exists (select 1 from public.world_members m where m.world_id = w.id and m.user_id = new.author_id) then
    raise exception 'join the World first' using errcode = 'AW002';
  end if;
  new.visibility := 'public';

  if new.is_entry then
    if not w.competition then
      raise exception 'this World has no competition' using errcode = 'AW005';
    end if;
    if now() >= w.entries_close_at then
      raise exception 'entries are closed' using errcode = 'AW003';
    end if;
    -- Serialise entries per person so two parallel submits can't both slip under the limit.
    perform pg_advisory_xact_lock(hashtextextended(w.id::text || new.author_id::text, 0));
    if (select count(*) from public.posts p
        where p.world_id = w.id and p.author_id = new.author_id and p.is_entry and p.deleted_at is null) >= w.entry_limit then
      raise exception 'entry limit reached' using errcode = 'AW004';
    end if;
  end if;
  return new;
end $$;

create trigger posts_world_before_insert before insert on public.posts
  for each row execute function public.posts_world_before_insert();

-- ---------------------------------------------------------------- security

revoke all on public.worlds, public.world_members, public.world_host_picks, public.world_chat_messages
  from anon, authenticated;

grant select on public.worlds, public.world_host_picks to anon, authenticated;
grant select on public.world_members, public.world_chat_messages to authenticated;
grant insert (world_id, user_id), delete on public.world_members to authenticated;
grant insert (world_id, author_id, body) on public.world_chat_messages to authenticated;
grant insert (world_id, is_entry) on public.posts to authenticated;

alter table public.worlds              enable row level security;
alter table public.world_members       enable row level security;
alter table public.world_host_picks    enable row level security;
alter table public.world_chat_messages enable row level security;

-- Event listings are public information, like profiles.
create policy "Worlds are public" on public.worlds for select to anon, authenticated using (true);
create policy "Amigo picks are public" on public.world_host_picks for select to anon, authenticated using (true);

create policy "Signed-in people see who joined" on public.world_members for select
  to authenticated using ((select auth.uid()) is not null);
create policy "People join Worlds that haven't ended" on public.world_members for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.worlds w where w.id = world_id and w.ends_at > now()));
create policy "People leave Worlds that haven't ended" on public.world_members for delete
  to authenticated
  using (
    user_id = (select auth.uid())
    and exists (select 1 from public.worlds w where w.id = world_id and w.ends_at > now()));

create policy "Signed-in people read World chat" on public.world_chat_messages for select
  to authenticated using ((select auth.uid()) is not null);
create policy "Members chat while a World is live" on public.world_chat_messages for insert
  to authenticated
  with check (
    author_id = (select auth.uid())
    and exists (select 1 from public.world_members m where m.world_id = world_chat_messages.world_id and m.user_id = (select auth.uid()))
    and exists (select 1 from public.worlds w where w.id = world_chat_messages.world_id and now() >= w.starts_at and now() < w.ends_at));

-- No update/delete policies on worlds, picks or chat: admins manage those with the service role.

-- ---------------------------------------------------------------- API

-- Creates a post (or competition entry) inside a World, with media, in one
-- transaction. Same validation as create_post; the World rules live in the
-- posts_world_before_insert trigger, so they also hold for direct inserts.
create function public.create_world_post(
  p_world_id uuid,
  p_body text,
  p_media jsonb default '[]'::jsonb,
  p_entry boolean default false
) returns public.posts
language plpgsql security invoker set search_path = '' as $$
declare
  body text := btrim(coalesce(p_body, ''));
  media_count integer := coalesce(jsonb_array_length(p_media), 0);
  created public.posts;
  item jsonb;
  i integer := 0;
begin
  if (select auth.uid()) is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if body = '' and media_count = 0 then
    raise exception 'a post needs text or media' using errcode = '22023';
  end if;
  if char_length(body) > 500 then
    raise exception 'posts are limited to 500 characters' using errcode = '22001';
  end if;
  if media_count > 4 then
    raise exception 'at most 4 media items per post' using errcode = '22023';
  end if;

  insert into public.posts (author_id, body, world_id, is_entry)
  values ((select auth.uid()), body, p_world_id, coalesce(p_entry, false))
  returning * into created;

  for item in select value from jsonb_array_elements(coalesce(p_media, '[]'::jsonb)) loop
    insert into public.post_media (post_id, owner_id, position, kind, storage_path, mime_type, width, height, byte_size, alt)
    values (
      created.id, (select auth.uid()), i,
      (item ->> 'kind')::public.media_kind,
      item ->> 'storage_path',
      item ->> 'mime_type',
      (item ->> 'width')::integer,
      (item ->> 'height')::integer,
      (item ->> 'byte_size')::bigint,
      nullif(item ->> 'alt', '')
    );
    i := i + 1;
  end loop;

  return created;
end $$;

-- The leaderboard of a competition World. Per entry: likes from others x
-- points_reaction + replies from others x points_reply + Amigo pick bonus,
-- counting only likes/replies made before the World ended (so it freezes at
-- the end). Ties: earliest first entry ranks higher. SECURITY DEFINER because
-- anon can't read post_likes; it only returns per-person totals of public posts.
create function public.world_leaderboard(p_world_id uuid, p_limit integer default 100)
returns table (user_id uuid, points integer, entries integer, first_entry_at timestamptz, rank integer)
language sql stable security definer set search_path = '' as $$
  with w as (
    select * from public.worlds where id = p_world_id and competition
  ), scored as (
    select
      e.author_id,
      e.created_at,
      (select count(*) from public.post_likes l
        where l.post_id = e.id and l.user_id <> e.author_id and l.created_at <= w.ends_at) * w.points_reaction
      + (select count(*) from public.posts r
          where r.parent_id = e.id and r.author_id <> e.author_id and r.deleted_at is null and r.created_at <= w.ends_at) * w.points_reply
      + case when exists (select 1 from public.world_host_picks h where h.world_id = w.id and h.post_id = e.id)
             then w.points_host_pick else 0 end as pts
    from w
    join public.posts e on e.world_id = w.id and e.is_entry and e.deleted_at is null
  ), totals as (
    select author_id, sum(pts)::integer as points, count(*)::integer as entries, min(created_at) as first_entry_at
    from scored group by author_id
  )
  select author_id, points, entries, first_entry_at,
         (row_number() over (order by points desc, first_entry_at asc, author_id))::integer as rank
  from totals
  order by rank
  limit least(greatest(coalesce(p_limit, 100), 1), 500);
$$;

revoke execute on function public.world_members_counter() from public, anon, authenticated;
revoke execute on function public.posts_world_before_insert() from public, anon, authenticated;
revoke execute on function public.create_world_post(uuid, text, jsonb, boolean) from public, anon;
revoke execute on function public.world_leaderboard(uuid, integer) from public;
grant execute on function public.create_world_post(uuid, text, jsonb, boolean) to authenticated;
grant execute on function public.world_leaderboard(uuid, integer) to anon, authenticated;

-- Realtime: chat messages, and World rows (participant_count changes on join/leave).
alter publication supabase_realtime add table public.world_chat_messages, public.worlds;
