-- =============================================================================
-- Post view counts (an eye and a number under each post)
--
-- A view is one signed-in person seeing a post: each account counts once per
-- post, ever. Scrolling past again, reopening the post or reloading never adds
-- more. Not counted: the author (or, for a business post, its owner), people
-- who aren't signed in, suspended accounts, and posts the viewer isn't allowed
-- to see (can_view_post: deleted, followers-only, blocked, suspended business).
-- Each account can add at most 2,000 new views a day, 50 posts per request.
--
-- Privacy: who viewed what (post_views) is never readable by anyone through the
-- API — no grants, no policies, and no function lists viewers. Only the total
-- per post is shown. The rows go when the post or the viewer's account is
-- deleted (the totals stay, as they were genuine when counted).
--
-- Efficiency: totals live in post_view_counts, not on posts, so a view never
-- rewrites the post row (posts_touch would bump updated_at on every view). The
-- app reads totals in one batched request per screen of posts.
--
-- Off until an admin switches on 'post_views' (Admin → Creators → Post view counts):
-- while off, nothing is recorded and no totals are shown.
-- =============================================================================

insert into public.app_features (key) values ('post_views') on conflict (key) do nothing;

create table public.post_views (
  post_id    uuid not null references public.posts (id) on delete cascade,
  viewer_id  uuid not null references public.profiles (id) on delete cascade,
  viewed_at  timestamptz not null default now(),
  primary key (post_id, viewer_id)
);
-- The daily per-account limit.
create index post_views_viewer_idx on public.post_views (viewer_id, viewed_at desc);

create table public.post_view_counts (
  post_id  uuid primary key references public.posts (id) on delete cascade,
  views    integer not null default 0 check (views >= 0)
);

revoke all on public.post_views, public.post_view_counts from anon, authenticated;
alter table public.post_views enable row level security;
alter table public.post_view_counts enable row level security;
-- No policies: both are reached through the functions below only.

-- Records that the signed-in person saw these posts. Answers the posts that
-- were newly counted (so the app can add one to what it shows).
create function public.record_post_views(p_posts uuid[]) returns uuid[]
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  today integer;
  counted uuid[];
begin
  if uid is null or p_posts is null or cardinality(p_posts) = 0 then return '{}'; end if;
  if cardinality(p_posts) > 50 then raise exception 'too many posts' using errcode = '22023'; end if;
  if not public.feature_enabled('post_views') or public.is_suspended(uid) then return '{}'; end if;

  select count(*) into today from public.post_views where viewer_id = uid and viewed_at > now() - interval '1 day';
  if today >= 2000 then return '{}'; end if;

  with candidates as (
    select p.id
      from public.posts p
     where p.id = any (p_posts)
       and p.author_id is distinct from uid
       and (p.business_id is null
            or not exists (select 1 from public.businesses b where b.id = p.business_id and b.owner_id = uid))
       and public.can_view_post(p.id)
     limit 2000 - today
  ), added as (
    insert into public.post_views (post_id, viewer_id)
    select id, uid from candidates
    on conflict do nothing
    returning post_id
  ), bumped as (
    insert into public.post_view_counts as c (post_id, views)
    select post_id, 1 from added
    on conflict (post_id) do update set views = c.views + 1
    returning c.post_id
  )
  select coalesce(array_agg(post_id), '{}') into counted from bumped;
  return counted;
end $$;

-- Totals for posts the caller can see, up to 100 at a time:
-- {"on": true, "counts": {"<post id>": 12, ...}}; posts with no views are left
-- out (the app shows nothing for them). While switched off: {"on": false}.
create function public.post_view_totals(p_posts uuid[]) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when not public.feature_enabled('post_views') then jsonb_build_object('on', false)
    else jsonb_build_object('on', true, 'counts', coalesce((
      select jsonb_object_agg(c.post_id, c.views)
        from public.post_view_counts c
       where c.post_id = any ((coalesce(p_posts, '{}'))[1:100])
         and public.can_view_post(c.post_id)), '{}'::jsonb))
  end
$$;

revoke execute on function public.record_post_views(uuid[]), public.post_view_totals(uuid[]) from public, anon, authenticated;
grant execute on function public.record_post_views(uuid[]), public.post_view_totals(uuid[]) to authenticated;
