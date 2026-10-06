-- =============================================================================
-- Amigo World — privileges, Row Level Security and API functions
--
-- Defence in depth:
--   1. Table/column GRANTs decide *which columns* a role may touch at all
--      (clients can never write counters, timestamps or thread roots).
--   2. RLS policies decide *which rows*.
--   3. Writes that span tables go through small SECURITY INVOKER functions,
--      so RLS still applies inside them.
-- =============================================================================

-- ---------------------------------------------------------------- grants
-- Supabase grants everything on public tables to anon/authenticated by
-- default. Start from nothing and add back exactly what the app needs.

revoke all on public.profiles, public.posts, public.post_media, public.post_likes, public.follows
  from anon, authenticated;

grant select on public.profiles, public.posts, public.post_media to anon, authenticated;
grant select on public.post_likes, public.follows to authenticated;

grant update (username, display_name, bio, avatar_url) on public.profiles to authenticated;
grant insert (author_id, body, parent_id, repost_of_id, visibility) on public.posts to authenticated;
grant insert (post_id, owner_id, position, kind, bucket, storage_path, mime_type, width, height, duration_ms, byte_size, alt)
  on public.post_media to authenticated;
grant insert (user_id, post_id), delete on public.post_likes to authenticated;
grant insert (follower_id, followee_id), delete on public.follows to authenticated;

-- Functions are not callable by default; each API function below is granted explicitly.
revoke execute on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

alter table public.profiles   enable row level security;
alter table public.posts      enable row level security;
alter table public.post_media enable row level security;
alter table public.post_likes enable row level security;
alter table public.follows    enable row level security;

-- ---------------------------------------------------------------- helpers

-- Does the current user follow p_author? SECURITY DEFINER so policies on
-- posts can use it for anonymous visitors too (who cannot read follows).
create function public.viewer_follows(p_author uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.follows f
    where f.follower_id = (select auth.uid()) and f.followee_id = p_author
  );
$$;
grant execute on function public.viewer_follows(uuid) to anon, authenticated;

-- Can the current user see this post? SECURITY DEFINER so it can be used
-- from other tables' policies without recursive RLS evaluation. It only
-- answers yes/no about one row and leaks nothing else.
create function public.can_view_post(p_post_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.posts p
    where p.id = p_post_id
      and p.deleted_at is null
      and (
        p.visibility = 'public'
        or p.author_id = (select auth.uid())
        or (p.visibility = 'followers' and public.viewer_follows(p.author_id))
      )
  );
$$;
grant execute on function public.can_view_post(uuid) to anon, authenticated;

-- ---------------------------------------------------------------- profiles
-- Profiles are the public face of an account and hold nothing private.

create policy "Profiles are public"
  on public.profiles for select
  to anon, authenticated
  using (true);

create policy "People update their own profile"
  on public.profiles for update
  to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- No insert policy: profiles are created by the on_auth_user_created trigger.
-- No delete policy: profiles go away with their auth user (on delete cascade).

-- ------------------------------------------------------------------ posts

create policy "Visible posts can be read"
  on public.posts for select
  to anon, authenticated
  using (
    deleted_at is null
    and (
      visibility = 'public'
      or author_id = (select auth.uid())
      or (visibility = 'followers' and public.viewer_follows(author_id))
    )
  );

create policy "People post as themselves"
  on public.posts for insert
  to authenticated
  with check (
    author_id = (select auth.uid())
    and (parent_id is null or public.can_view_post(parent_id))
    and (repost_of_id is null or public.can_view_post(repost_of_id))
  );

-- No update/delete policies: deletion is a soft delete through delete_post().

-- ------------------------------------------------------------- post_media

create policy "Media of visible posts can be read"
  on public.post_media for select
  to anon, authenticated
  using (public.can_view_post(post_id));

create policy "Authors attach media to their own posts"
  on public.post_media for insert
  to authenticated
  with check (
    owner_id = (select auth.uid())
    and bucket = 'post-media'
    and storage_path like (select auth.uid())::text || '/%'
    and exists (
      select 1 from public.posts p
      where p.id = post_id and p.author_id = (select auth.uid()) and p.deleted_at is null)
  );

-- ------------------------------------------------------------- post_likes

create policy "Likes on visible posts can be read"
  on public.post_likes for select
  to authenticated
  using (user_id = (select auth.uid()) or public.can_view_post(post_id));

create policy "People like as themselves"
  on public.post_likes for insert
  to authenticated
  with check (user_id = (select auth.uid()) and public.can_view_post(post_id));

create policy "People remove their own likes"
  on public.post_likes for delete
  to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------- follows
-- The follow graph is visible to signed-in people (like follower lists on
-- any public social network), not to anonymous scrapers.

create policy "Signed-in people can see the follow graph"
  on public.follows for select
  to authenticated
  using ((select auth.uid()) is not null);

create policy "People follow as themselves"
  on public.follows for insert
  to authenticated
  with check (follower_id = (select auth.uid()));

create policy "People unfollow as themselves"
  on public.follows for delete
  to authenticated
  using (follower_id = (select auth.uid()));

-- =============================================================================
-- API functions (called through supabase.rpc)
-- =============================================================================

-- Creates a post or reply together with its media in one transaction.
-- p_media: [{ "kind": "image", "storage_path": "<uid>/…", "mime_type": "image/jpeg",
--             "width": 1200, "height": 900, "byte_size": 123, "alt": "…" }]
create function public.create_post(
  p_body text,
  p_parent_id uuid default null,
  p_media jsonb default '[]'::jsonb,
  p_visibility public.post_visibility default 'public'
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

  insert into public.posts (author_id, body, parent_id, visibility)
  values ((select auth.uid()), body, p_parent_id, p_visibility)
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
grant execute on function public.create_post(text, uuid, jsonb, public.post_visibility) to authenticated;

-- Soft delete: the post disappears from every read path; counters adjust via trigger.
create function public.delete_post(p_post_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.posts
     set deleted_at = now()
   where id = p_post_id
     and author_id = (select auth.uid())
     and deleted_at is null;
  if not found then
    raise exception 'post not found' using errcode = 'P0002';
  end if;
end $$;
grant execute on function public.delete_post(uuid) to authenticated;

-- Idempotent like toggle: calling it twice with the same value is a no-op.
create function public.set_post_like(p_post_id uuid, p_liked boolean) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if p_liked then
    insert into public.post_likes (user_id, post_id)
    values ((select auth.uid()), p_post_id)
    on conflict do nothing;
  else
    delete from public.post_likes
     where user_id = (select auth.uid()) and post_id = p_post_id;
  end if;
end $$;
grant execute on function public.set_post_like(uuid, boolean) to authenticated;

-- Home timeline. p_scope: 'latest' (everyone) or 'following' (people you follow + you).
-- Returns posts rows so PostgREST can embed author/media/likes in one request.
create function public.feed_posts(
  p_scope text default 'latest',
  p_limit integer default 20,
  p_before timestamptz default null
) returns setof public.posts
language sql stable security invoker set search_path = '' as $$
  select p.*
  from public.posts p
  where p.parent_id is null
    and p.deleted_at is null
    and (p_before is null or p.created_at < p_before)
    and (
      p_scope = 'latest'
      or p.author_id = (select auth.uid())
      or public.viewer_follows(p.author_id)
    )
  order by p.created_at desc, p.id desc
  limit least(greatest(coalesce(p_limit, 20), 1), 100);
$$;
grant execute on function public.feed_posts(text, integer, timestamptz) to anon, authenticated;

-- People you might want to follow: not you, not already followed.
create function public.suggested_profiles(p_limit integer default 5) returns setof public.profiles
language sql stable security invoker set search_path = '' as $$
  select pr.*
  from public.profiles pr
  where pr.id <> (select auth.uid())
    and not public.viewer_follows(pr.id)
  order by pr.follower_count desc, pr.post_count desc, pr.created_at desc
  limit least(greatest(coalesce(p_limit, 5), 1), 50);
$$;
grant execute on function public.suggested_profiles(integer) to authenticated;

-- Supporting SECURITY DEFINER helpers used only by triggers/policies stay
-- non-callable through the API (execute was revoked above), except can_view_post.

-- =============================================================================
-- Realtime: only posts. Likes/replies/reposts surface as counter updates on
-- the post row, so clients never need a firehose of like events.
-- =============================================================================
alter publication supabase_realtime add table public.posts;
