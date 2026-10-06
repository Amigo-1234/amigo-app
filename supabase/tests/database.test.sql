-- =============================================================================
-- Database behaviour + security tests.
--
-- Runs inside one transaction and ROLLS BACK, so it leaves no trace. Fails
-- loudly (non-zero psql exit) on the first broken expectation.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/database.test.sql
--
-- Works on a real Supabase database and on the local shim
-- (supabase/tests/local_supabase_shim.sql).
-- =============================================================================
\set ON_ERROR_STOP 1
begin;

-- ---------------------------------------------------------------- helpers

create function pg_temp.act_as(p_uid uuid) returns void language plpgsql as $$
begin
  if p_uid is null then
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    perform set_config('role', 'anon', true);
  else
    perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
  end if;
end $$;

create function pg_temp.act_as_admin() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- Run p_sql as p_uid (null = anon) and require it to fail with p_state (prefix match).
create function pg_temp.must_fail(p_label text, p_uid uuid, p_sql text, p_state text) returns void language plpgsql as $$
declare st text;
begin
  begin
    perform pg_temp.act_as(p_uid);
    execute p_sql;
    raise exception 'EXPECTED FAILURE did not happen: %', p_label using errcode = 'P0001';
  exception when others then
    get stacked diagnostics st = returned_sqlstate;
    if st = 'P0001' and sqlerrm like 'EXPECTED FAILURE%' then raise; end if;
    if p_state is not null and st not like p_state || '%' then
      raise exception 'FAIL %: expected sqlstate %, got % (%)', p_label, p_state, st, sqlerrm;
    end if;
  end;
  perform pg_temp.act_as_admin();
  raise notice 'ok  %', p_label;
end $$;

create function pg_temp.check(p_label text, p_ok boolean) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL %', p_label; end if;
  raise notice 'ok  %', p_label;
end $$;

-- Runs p_sql as p_uid and returns the single scalar result (as text).
create function pg_temp.q(p_uid uuid, p_sql text) returns text language plpgsql as $$
declare r text;
begin
  perform pg_temp.act_as(p_uid);
  execute p_sql into r;
  perform pg_temp.act_as_admin();
  return r;
end $$;

-- ---------------------------------------------------------------- fixtures

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-00000000000a', 'ama@example.com',  '{"display_name":"Ama Mensah"}'),
  ('00000000-0000-0000-0000-00000000000b', 'leo@example.com',  '{"display_name":"Leo Park"}'),
  ('00000000-0000-0000-0000-00000000000c', 'zoe@example.com',  '{"display_name":"Zoë Laurent"}'),
  ('00000000-0000-0000-0000-00000000000d', 'secret.name@example.com', '{}'),
  ('00000000-0000-0000-0000-00000000000e', 'ama2@example.com', '{"display_name":"Ama Mensah"}');

\set A '''00000000-0000-0000-0000-00000000000a'''
\set B '''00000000-0000-0000-0000-00000000000b'''
\set C '''00000000-0000-0000-0000-00000000000c'''
\set D '''00000000-0000-0000-0000-00000000000d'''

-- ------------------------------------------------------- signup → profile

select pg_temp.check('profile created for every auth user',
  (select count(*) = 5 from public.profiles where id::text like '00000000-0000-0000-0000-00000000000_'));
select pg_temp.check('username from display name', (select username = 'ama_mensah' from public.profiles where id = :A));
select pg_temp.check('accents folded in username', (select username = 'zoe_laurent' from public.profiles where id = :C));
select pg_temp.check('duplicate name gets a unique suffix',
  (select username ~ '^ama_mensah_[0-9]{4}$' from public.profiles where id = '00000000-0000-0000-0000-00000000000e'));
select pg_temp.check('username never derived from email',
  (select username !~ 'secret' and username like 'amigo%' from public.profiles where id = :D));
select pg_temp.check('profiles has no email column',
  not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name ilike '%mail%'));

-- ------------------------------------------------------------ profiles RLS

select pg_temp.check('anon can read profiles', pg_temp.q(null, $$select count(*) from public.profiles where id::text like '00000000-0000-0000-0000-00000000000_'$$)::int = 5);
select pg_temp.must_fail('anon cannot read auth.users', null, 'select count(*) from auth.users', '42501');
select pg_temp.must_fail('authenticated cannot read auth.users', :A, 'select count(*) from auth.users', '42501');

select pg_temp.act_as(:A);
update public.profiles set display_name = 'Ama M.' where id = :A;
update public.profiles set display_name = 'hacked' where id = :B; -- silently filtered by RLS
select pg_temp.act_as_admin();
select pg_temp.check('people can edit their own profile', (select display_name = 'Ama M.' from public.profiles where id = :A));
select pg_temp.check('people cannot edit someone else''s profile', (select display_name = 'Leo Park' from public.profiles where id = :B));
select pg_temp.must_fail('counters are not client-writable', :A, $$update public.profiles set follower_count = 1000000 where id = '00000000-0000-0000-0000-00000000000a'$$, '42501');
select pg_temp.must_fail('clients cannot insert profiles', :A, $$insert into public.profiles (id, username, display_name) values ('00000000-0000-0000-0000-00000000000a', 'dupe', 'x')$$, '42501');
select pg_temp.must_fail('username format enforced', :A, $$update public.profiles set username = 'Bad Name!' where id = '00000000-0000-0000-0000-00000000000a'$$, '23514');

-- ----------------------------------------------------------------- posts

select pg_temp.must_fail('anon cannot post', null, $$select public.create_post('hi')$$, '42501');
select pg_temp.must_fail('cannot post as someone else', :A,
  $$insert into public.posts (author_id, body) values ('00000000-0000-0000-0000-00000000000b', 'forged')$$, '42501');
select pg_temp.must_fail('cannot forge like_count on insert', :A,
  $$insert into public.posts (body, like_count) values ('x', 999)$$, '42501');
select pg_temp.must_fail('cannot backdate created_at', :A,
  $$insert into public.posts (body, created_at) values ('x', '2001-01-01')$$, '42501');
select pg_temp.must_fail('empty post rejected', :A, $$select public.create_post('   ')$$, '22023');
select pg_temp.must_fail('post over 500 chars rejected', :A, $$select public.create_post(repeat('x', 501))$$, '22001');

create temp table t (k text primary key, id uuid);
grant all on t to anon, authenticated;

select pg_temp.act_as(:A);
insert into t select 'a1', (public.create_post('Golden hour', null,
  '[{"kind":"image","storage_path":"00000000-0000-0000-0000-00000000000a/one.jpg","mime_type":"image/jpeg","width":1200,"height":1500}]')).id;
select pg_temp.act_as_admin();
select pg_temp.check('create_post stores media', (select count(*) = 1 from public.post_media where post_id = (select id from t where k = 'a1')));
select pg_temp.check('post_count maintained', (select post_count = 1 from public.profiles where id = :A));

select pg_temp.must_fail('media path must be in own folder', :A,
  $$select public.create_post('steal', null, '[{"kind":"image","storage_path":"00000000-0000-0000-0000-00000000000b/x.jpg","mime_type":"image/jpeg"}]')$$, '42501');
select pg_temp.must_fail('cannot attach media to someone else''s post', :B,
  format($$insert into public.post_media (post_id, owner_id, kind, storage_path, mime_type) values (%L, '00000000-0000-0000-0000-00000000000b', 'image', '00000000-0000-0000-0000-00000000000b/y.jpg', 'image/jpeg')$$, (select id from t where k = 'a1')), '42501');

-- --------------------------------------------------------------- replies

select pg_temp.act_as(:B);
insert into t select 'b_reply', (public.create_post('Beautiful', (select id from t where k = 'a1'))).id;
insert into t select 'b_reply2', (public.create_post('Agreed', (select id from t where k = 'b_reply'))).id;
select pg_temp.act_as_admin();
select pg_temp.check('reply_count maintained', (select reply_count = 1 from public.posts where id = (select id from t where k = 'a1')));
select pg_temp.check('nested reply keeps thread root',
  (select root_id = (select id from t where k = 'a1') from public.posts where id = (select id from t where k = 'b_reply2')));
select pg_temp.check('replies do not count as profile posts', (select post_count = 0 from public.profiles where id = :B));
select pg_temp.check('replies stay out of the home feed',
  pg_temp.q(:A, $$select count(*) from public.feed_posts('latest', 100) where author_id in ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b')$$)::int = 1);

-- ----------------------------------------------------------------- likes

select pg_temp.act_as(:B);
select public.set_post_like((select id from t where k = 'a1'), true);
select public.set_post_like((select id from t where k = 'a1'), true);
select pg_temp.act_as(:C);
select public.set_post_like((select id from t where k = 'a1'), true);
select pg_temp.act_as_admin();
select pg_temp.check('likes are idempotent and counted', (select like_count = 2 from public.posts where id = (select id from t where k = 'a1')));
select pg_temp.act_as(:C);
select public.set_post_like((select id from t where k = 'a1'), false);
select pg_temp.act_as_admin();
select pg_temp.check('unlike decrements', (select like_count = 1 from public.posts where id = (select id from t where k = 'a1')));
select pg_temp.must_fail('cannot like on behalf of someone else', :C,
  format($$insert into public.post_likes (user_id, post_id) values ('00000000-0000-0000-0000-00000000000b', %L)$$, (select id from t where k = 'a1')), '42501');
select pg_temp.act_as(:C);
delete from public.post_likes where user_id = :B; -- filtered out by RLS: affects 0 rows
select pg_temp.act_as_admin();
select pg_temp.check('cannot remove someone else''s like', (select like_count = 1 from public.posts where id = (select id from t where k = 'a1')));
select pg_temp.must_fail('anon cannot read likes', null, 'select count(*) from public.post_likes', '42501');

-- --------------------------------------------------------------- follows

select pg_temp.act_as(:C);
insert into public.follows (followee_id) values (:A);
select pg_temp.act_as_admin();
select pg_temp.check('follow counters', (select follower_count = 1 from public.profiles where id = :A)
  and (select following_count = 1 from public.profiles where id = :C));
select pg_temp.must_fail('cannot follow yourself', :C, $$insert into public.follows (followee_id) values ('00000000-0000-0000-0000-00000000000c')$$, '23514');
select pg_temp.must_fail('cannot create follows for someone else', :C,
  $$insert into public.follows (follower_id, followee_id) values ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000a')$$, '42501');
select pg_temp.must_fail('anon cannot read the follow graph', null, 'select count(*) from public.follows', '42501');
select pg_temp.check('following feed = followed + self',
  pg_temp.q(:C, $$select count(*) from public.feed_posts('following', 100)$$)::int = 1
  and pg_temp.q(:B, $$select count(*) from public.feed_posts('following', 100)$$)::int = 0);
select pg_temp.check('suggestions exclude self and followed',
  pg_temp.q(:C, $$select count(*) from public.suggested_profiles(50) where id in ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000c')$$)::int = 0);

-- ------------------------------------------------------ followers-only posts

select pg_temp.act_as(:A);
insert into t select 'a_private', (public.create_post('For my people', null, '[]', 'followers')).id;
select pg_temp.act_as_admin();
select pg_temp.check('followers-only: author sees it', pg_temp.q(:A, format('select count(*) from public.posts where id = %L', (select id from t where k = 'a_private')))::int = 1);
select pg_temp.check('followers-only: follower sees it', pg_temp.q(:C, format('select count(*) from public.posts where id = %L', (select id from t where k = 'a_private')))::int = 1);
select pg_temp.check('followers-only: stranger does not', pg_temp.q(:B, format('select count(*) from public.posts where id = %L', (select id from t where k = 'a_private')))::int = 0);
select pg_temp.check('followers-only: anon does not', pg_temp.q(null, format('select count(*) from public.posts where id = %L', (select id from t where k = 'a_private')))::int = 0);
select pg_temp.check('anon can read the public feed (no follows access needed)',
  pg_temp.q(null, $$select count(*) from public.feed_posts('latest', 100) where author_id = '00000000-0000-0000-0000-00000000000a'$$)::int = 1);
select pg_temp.must_fail('stranger cannot reply to a post they cannot see', :B,
  format($$select public.create_post('sneaky', %L)$$, (select id from t where k = 'a_private')), '42501');
select pg_temp.must_fail('stranger cannot like a post they cannot see', :B,
  format($$select public.set_post_like(%L, true)$$, (select id from t where k = 'a_private')), '42501');

-- ---------------------------------------------------------------- delete

select pg_temp.must_fail('only the author can delete', :B, format($$select public.delete_post(%L)$$, (select id from t where k = 'a1')), 'P0002');
select pg_temp.must_fail('no direct DELETE on posts', :A, format($$delete from public.posts where id = %L$$, (select id from t where k = 'a1')), '42501');
select pg_temp.act_as(:B);
select public.delete_post((select id from t where k = 'b_reply2'));
select pg_temp.act_as_admin();
select pg_temp.check('soft-deleted reply hidden', pg_temp.q(:A, format('select count(*) from public.posts where id = %L', (select id from t where k = 'b_reply2')))::int = 0);
select pg_temp.check('soft delete decrements parent reply_count', (select reply_count = 0 from public.posts where id = (select id from t where k = 'b_reply')));
select pg_temp.must_fail('cannot reply to a deleted post', :A, format($$select public.create_post('late', %L)$$, (select id from t where k = 'b_reply2')), '23503');

-- ------------------------------------------------------- private surfaces

select pg_temp.must_fail('legacy schema closed to authenticated', :A, 'select count(*) from legacy.user_map', '42501');
select pg_temp.must_fail('legacy schema closed to anon', null, 'select count(*) from legacy.global_chat_archive', '42501');
select pg_temp.must_fail('legacy lookup not callable by users', :A, $$select * from public.legacy_find_unmigrated_user('ama@example.com')$$, '42501');
select pg_temp.must_fail('migration import API not callable by users', :A, $$select public.legacy_state()$$, '42501');
select pg_temp.must_fail('migration import API not callable by anon', null, $$select public.legacy_validation_snapshot()$$, '42501');
select pg_temp.must_fail('sign-in throttle not callable by users', :A, $$select public.legacy_signin_throttle('a', 'b')$$, '42501');
select pg_temp.check('no public-schema function is executable by PUBLIC',
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and has_function_privilege('public', p.oid, 'EXECUTE')
                and p.proacl is not null and array_to_string(p.proacl, ',') ~ '(^|,)=X'));
select pg_temp.must_fail('anon cannot call create_post', null, $$select public.create_post('x')$$, '42501');
select pg_temp.must_fail('anon cannot call set_post_like', null, $$select public.set_post_like(gen_random_uuid(), true)$$, '42501');
select pg_temp.must_fail('anon cannot call delete_post', null, $$select public.delete_post(gen_random_uuid())$$, '42501');
select pg_temp.must_fail('anon cannot call suggested_profiles', null, $$select public.suggested_profiles(3)$$, '42501');
select pg_temp.must_fail('trigger helpers not callable by users', :A, $$select public.generate_username('x')$$, '42501');

-- ---------------------------------------------------------------- storage

select pg_temp.act_as(:A);
insert into storage.objects (bucket_id, name) values ('post-media', '00000000-0000-0000-0000-00000000000a/ok.jpg');
select pg_temp.act_as_admin();
select pg_temp.check('upload into own folder', (select count(*) = 1 from storage.objects where name = '00000000-0000-0000-0000-00000000000a/ok.jpg'));
select pg_temp.must_fail('upload into someone else''s folder', :A,
  $$insert into storage.objects (bucket_id, name) values ('post-media', '00000000-0000-0000-0000-00000000000b/x.jpg')$$, '42501');
select pg_temp.must_fail('upload into unknown bucket', :A,
  $$insert into storage.objects (bucket_id, name) values ('secrets', '00000000-0000-0000-0000-00000000000a/x.jpg')$$, null);
select pg_temp.check('cannot list other people''s files',
  pg_temp.q(:B, $$select count(*) from storage.objects where bucket_id = 'post-media'$$)::int = 0);

-- ------------------------------------------------------------ RLS coverage

select pg_temp.check('RLS enabled on every public table',
  not exists (select 1 from pg_tables where schemaname = 'public' and not rowsecurity));

rollback;
\echo 'ALL DATABASE TESTS PASSED'
