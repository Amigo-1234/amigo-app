-- =============================================================================
-- Security fix: remove PUBLIC's EXECUTE on API functions.
--
-- PostgreSQL grants EXECUTE on every new function to PUBLIC by default. The
-- earlier migration tried to switch that off with
--   alter default privileges in schema public revoke execute on functions from public
-- but a schema-scoped default can't revoke PostgreSQL's *global* default, so
-- create_post, set_post_like, delete_post, suggested_profiles and feed_posts
-- ended up callable by PUBLIC (including anon).
--
-- Not exploitable as shipped — each function checks auth.uid(), table grants or
-- RLS — but the intended "explicit grants only" layer wasn't there. This
-- restores it and re-asserts exactly who may call what.
-- =============================================================================

revoke execute on all functions in schema public from public;

-- Deliberately NOT changing the global default (ALTER DEFAULT PRIVILEGES without
-- IN SCHEMA): it would also strip PUBLIC execute from functions of extensions
-- installed later (e.g. pg_trgm for search). Instead every migration that adds a
-- function must revoke/grant explicitly, and supabase/tests/database.test.sql
-- fails if any public-schema function is executable by PUBLIC.

-- Signed-out visitors: read paths only.
grant execute on function public.can_view_post(uuid) to anon, authenticated;
grant execute on function public.viewer_follows(uuid) to anon, authenticated;
grant execute on function public.feed_posts(text, integer, timestamptz) to anon, authenticated;

-- Signed-in people.
grant execute on function public.create_post(text, uuid, jsonb, public.post_visibility) to authenticated;
grant execute on function public.delete_post(uuid) to authenticated;
grant execute on function public.set_post_like(uuid, boolean) to authenticated;
grant execute on function public.suggested_profiles(integer) to authenticated;
