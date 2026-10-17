-- =============================================================================
-- Performance: "did I like this post?" as a computed field of posts
--
-- Lists of posts used a second, sequential request to fetch the viewer's likes
-- for the posts on screen (one extra round trip per feed, profile, World or
-- thread load — ~0.15–0.4 s on mobile networks). PostgREST exposes this
-- function as a field (`select=…,liked`), so posts arrive already marked.
-- Security invoker: it reads post_likes under the caller's own RLS (you can
-- always see your own likes) and reveals nothing else. Primary-key lookup.
-- =============================================================================

create function public.liked(p public.posts) returns boolean
language sql stable security invoker set search_path = '' as $$
  select exists (select 1 from public.post_likes l where l.user_id = (select auth.uid()) and l.post_id = p.id)
$$;

revoke execute on function public.liked(public.posts) from public, anon;
grant execute on function public.liked(public.posts) to authenticated;
