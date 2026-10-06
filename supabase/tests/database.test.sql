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

-- ---------------------------------------------------------- notifications
-- So far: B replied to A's a1 and liked it; C liked then unliked it; C follows A.

select pg_temp.check('reply, like and follow notify the recipient',
  pg_temp.q(:A, $$select string_agg(kind::text || ':' || right(actor_id::text, 1), ',' order by kind, actor_id) from public.notifications$$)
    = 'follow:c,like:b,reply:b');
select pg_temp.check('undone like is hidden from the recipient',
  (select count(*) = 1 from public.notifications where recipient_id = :A and actor_id = :C and kind = 'like')
  and pg_temp.q(:A, $$select count(*) from public.notifications where kind = 'like' and actor_id = '00000000-0000-0000-0000-00000000000c'$$)::int = 0);
select pg_temp.check('unread count counts only live notifications', pg_temp.q(:A, 'select public.unread_notification_count()')::int = 3);
select pg_temp.check('replying to yourself notifies nobody', (select count(*) = 0 from public.notifications where recipient_id = :B));

select pg_temp.act_as(:C);
select public.set_post_like((select id from t where k = 'a1'), true);
select pg_temp.act_as_admin();
select pg_temp.check('like → unlike → like keeps one notification',
  (select count(*) = 1 from public.notifications where recipient_id = :A and actor_id = :C and kind = 'like')
  and pg_temp.q(:A, 'select public.unread_notification_count()')::int = 4);

select pg_temp.act_as(:C);
delete from public.follows where followee_id = :A;
select pg_temp.act_as_admin();
select pg_temp.check('unfollow hides the follow notification', pg_temp.q(:A, $$select count(*) from public.notifications where kind = 'follow'$$)::int = 0);
select pg_temp.act_as(:C);
insert into public.follows (followee_id) values (:A);
select pg_temp.act_as_admin();
select pg_temp.check('follow → unfollow → follow keeps one notification',
  (select count(*) = 1 from public.notifications where recipient_id = :A and kind = 'follow')
  and pg_temp.q(:A, $$select count(*) from public.notifications where kind = 'follow'$$)::int = 1);

select pg_temp.act_as(:C);
insert into t select 'c_reply', (public.create_post('Nice reply @leo_park', (select id from t where k = 'b_reply'))).id;
insert into t select 'c_mention', (public.create_post('hey @Leo_Park and @ama_mensah! mail x@zoe_laurent.com or @nobody_here, @ama_mensah again')).id;
select pg_temp.act_as_admin();
select pg_temp.check('reply to a reply notifies the reply''s author',
  (select count(*) = 1 from public.notifications where recipient_id = :B and kind = 'reply' and post_id = (select id from t where k = 'c_reply')));
select pg_temp.check('reply to a reply does not notify the thread root',
  (select count(*) = 0 from public.notifications where recipient_id = :A and post_id = (select id from t where k = 'c_reply')));
select pg_temp.check('mention inside a reply to you is not a second notification',
  (select count(*) = 0 from public.notifications where recipient_id = :B and kind = 'mention' and post_id = (select id from t where k = 'c_reply')));
select pg_temp.check('mentions are case-insensitive, once per person',
  (select count(*) = 2 from public.notifications where kind = 'mention' and post_id = (select id from t where k = 'c_mention'))
  and (select count(*) = 1 from public.notifications where recipient_id = :A and kind = 'mention'));
select pg_temp.check('email addresses and unknown names are not mentions',
  (select count(*) = 0 from public.notifications where recipient_id = :C));

select pg_temp.act_as(:A);
insert into t select 'a_private2', (public.create_post('Just us: @leo_park @zoe_laurent @ama_mensah', null, '[]', 'followers')).id;
select pg_temp.act_as_admin();
select pg_temp.check('followers-only mention notifies followers only',
  (select string_agg(right(recipient_id::text, 1), ',') = 'c' from public.notifications where post_id = (select id from t where k = 'a_private2')));

select pg_temp.act_as_admin();
insert into public.follows (follower_id, followee_id) values (:D, :A);
select pg_temp.check('writes without a signed-in actor (legacy import) notify nobody',
  (select count(*) = 0 from public.notifications where actor_id = :D));

-- privacy
select pg_temp.check('people cannot read someone else''s notifications',
  pg_temp.q(:B, $$select count(*) from public.notifications where recipient_id <> '00000000-0000-0000-0000-00000000000b'$$)::int = 0
  and pg_temp.q(:B, 'select count(*) from public.notifications')::int = pg_temp.q(:B, 'select public.unread_notification_count()')::int);
select pg_temp.must_fail('anon cannot read notifications', null, 'select count(*) from public.notifications', '42501');
select pg_temp.must_fail('anon cannot read the unread count', null, 'select public.unread_notification_count()', '42501');
select pg_temp.must_fail('notifications cannot be forged', :B,
  $$insert into public.notifications (recipient_id, actor_id, kind) values ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000c', 'follow')$$, '42501');
select pg_temp.must_fail('notifications cannot be deleted by clients', :A, 'delete from public.notifications', '42501');
select pg_temp.must_fail('only read_at is writable', :A, $$update public.notifications set kind = 'like'$$, '42501');
select pg_temp.must_fail('notify() is not callable by users', :B,
  $$select public.notify('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000c', 'follow', null)$$, '42501');
select pg_temp.check('marking someone else''s notifications read changes nothing',
  pg_temp.q(:B, format('select public.mark_notifications_read(array[%L]::uuid[])',
    (select id from public.notifications where recipient_id = :A and kind = 'follow')))::int = 0
  and pg_temp.q(:B, $$with u as (update public.notifications set read_at = now() where recipient_id = '00000000-0000-0000-0000-00000000000a' returning 1) select count(*) from u$$)::int = 0
  and (select count(*) = 0 from public.notifications where recipient_id = :A and read_at is not null));

-- read state
select pg_temp.check('mark one read',
  pg_temp.q(:A, format('select public.mark_notifications_read(array[%L]::uuid[])',
    (select id from public.notifications where recipient_id = :A and kind = 'follow')))::int = 1
  and pg_temp.q(:A, 'select public.unread_notification_count()')::int = 4);
select pg_temp.check('mark all read', pg_temp.q(:A, 'select public.mark_notifications_read()')::int = 4
  and pg_temp.q(:A, 'select public.unread_notification_count()')::int = 0);

select pg_temp.act_as(:C);
select public.delete_post((select id from t where k = 'c_reply'));
select pg_temp.act_as_admin();
select pg_temp.check('deleting a post hides its notifications',
  pg_temp.q(:B, format('select count(*) from public.notifications where post_id = %L', (select id from t where k = 'c_reply')))::int = 0);

-- ---------------------------------------------------------------- worlds

select pg_temp.act_as_admin();
insert into public.worlds (slug, title, starts_at, ends_at, competition, entries_close_at, entry_limit, points_reaction, points_reply, points_host_pick, prize) values
  ('live-comp', 'Rage Bait Night', now() - interval '1 hour', now() + interval '1 hour', true, now() + interval '30 minutes', 1, 1, 2, 10, 'Bragging rights'),
  ('closed-entries', 'Debate Night', now() - interval '2 hours', now() + interval '1 hour', true, now() - interval '1 hour', 1, 1, 2, 0, null);
insert into public.worlds (slug, title, starts_at, ends_at) values
  ('live-social', 'Game Night', now() - interval '1 hour', now() + interval '1 hour'),
  ('upcoming', 'Watch Party', now() + interval '1 day', now() + interval '1 day 3 hours'),
  ('finished', 'Photo Walk', now() - interval '3 days', now() - interval '2 days');
insert into t select 'w_comp', id from public.worlds where slug = 'live-comp';
insert into t select 'w_closed', id from public.worlds where slug = 'closed-entries';
insert into t select 'w_social', id from public.worlds where slug = 'live-social';
insert into t select 'w_up', id from public.worlds where slug = 'upcoming';
insert into t select 'w_done', id from public.worlds where slug = 'finished';

select pg_temp.must_fail('Worlds are admin-created only', :A,
  $$insert into public.worlds (slug, title, starts_at, ends_at) values ('mine', 'Mine', now(), now() + interval '1 hour')$$, '42501');
select pg_temp.must_fail('clients cannot edit Worlds', :A, $$update public.worlds set title = 'hacked'$$, '42501');
do $$ begin
  insert into public.worlds (slug, title, starts_at, ends_at, competition) values ('bad-one', 'Bad', now(), now() + interval '1 hour', true);
  raise exception 'FAIL competition World without an entries window was accepted';
exception when check_violation then raise notice 'ok  competition needs an entries window';
end $$;
do $$ begin
  insert into public.worlds (slug, title, starts_at, ends_at) values ('bad-two', 'Bad', now(), now() - interval '1 hour');
  raise exception 'FAIL World ending before it starts was accepted';
exception when check_violation then raise notice 'ok  a World must end after it starts';
end $$;
select pg_temp.check('anon can read Worlds', pg_temp.q(null, $$select count(*) from public.worlds where slug in ('live-comp','finished')$$)::int = 2);

select pg_temp.act_as(:A);
insert into public.world_members (world_id) select id from t where k in ('w_comp', 'w_social', 'w_up', 'w_closed');
select pg_temp.act_as(:B);
insert into public.world_members (world_id) select id from t where k = 'w_comp';
select pg_temp.act_as(:C);
insert into public.world_members (world_id) select id from t where k = 'w_comp';
select pg_temp.act_as_admin();
select pg_temp.check('joining counts participants', (select participant_count = 3 from public.worlds where slug = 'live-comp'));
select pg_temp.must_fail('cannot join a finished World', :A,
  format($$insert into public.world_members (world_id) values (%L)$$, (select id from t where k = 'w_done')), '42501');
select pg_temp.must_fail('cannot join on someone else''s behalf', :A,
  format($$insert into public.world_members (world_id, user_id) values (%L, '00000000-0000-0000-0000-00000000000d')$$, (select id from t where k = 'w_comp')), '42501');
select pg_temp.act_as(:A);
delete from public.world_members where world_id = (select id from t where k = 'w_social');
select pg_temp.act_as_admin();
select pg_temp.check('leaving updates the count', (select participant_count = 0 from public.worlds where slug = 'live-social'));
select pg_temp.must_fail('anon cannot see who joined', null, 'select count(*) from public.world_members', '42501');

select pg_temp.must_fail('must join before posting in a World', :D,
  format($$select public.create_world_post(%L, 'hi')$$, (select id from t where k = 'w_comp')), 'AW002');
select pg_temp.must_fail('cannot post before a World starts', :A,
  format($$select public.create_world_post(%L, 'early')$$, (select id from t where k = 'w_up')), 'AW001');
select pg_temp.act_as_admin();
insert into public.world_members (world_id, user_id) select id, '00000000-0000-0000-0000-00000000000a' from t where k = 'w_social';
select pg_temp.must_fail('no entries in a World without competition', :A,
  format($$select public.create_world_post(%L, 'entry', '[]', true)$$, (select id from t where k = 'w_social')), 'AW005');
select pg_temp.must_fail('no entries after entries close', :A,
  format($$select public.create_world_post(%L, 'late entry', '[]', true)$$, (select id from t where k = 'w_closed')), 'AW003');

select pg_temp.act_as(:A);
insert into t select 'a_entry', (public.create_world_post((select id from t where k = 'w_comp'), 'My entry', '[]', true)).id;
insert into t select 'a_chat_post', (public.create_world_post((select id from t where k = 'w_comp'), 'just chatting')).id;
select pg_temp.act_as(:B);
insert into t select 'b_entry', (public.create_world_post((select id from t where k = 'w_comp'), 'B entry', '[]', true)).id;
select pg_temp.act_as_admin();
select pg_temp.must_fail('entry limit enforced', :A,
  format($$select public.create_world_post(%L, 'second entry', '[]', true)$$, (select id from t where k = 'w_comp')), 'AW004');
select pg_temp.check('World posts are tagged and public',
  (select world_id = (select id from t where k = 'w_comp') and is_entry and visibility = 'public' from public.posts where id = (select id from t where k = 'a_entry'))
  and (select not is_entry from public.posts where id = (select id from t where k = 'a_chat_post')));

-- scoring: likes from others x1, replies from others x2, Amigo pick +10
select pg_temp.act_as(:A);
select public.set_post_like((select id from t where k = 'a_entry'), true);  -- own like: 0
insert into t select 'a_self_reply', (public.create_post('replying to myself', (select id from t where k = 'a_entry'))).id;
select pg_temp.act_as(:B);
select public.set_post_like((select id from t where k = 'a_entry'), true);
select pg_temp.act_as(:C);
select public.set_post_like((select id from t where k = 'a_entry'), true);
insert into t select 'c_wreply', (public.create_post('great entry', (select id from t where k = 'a_entry'))).id;
select pg_temp.act_as_admin();
insert into public.world_host_picks (world_id, post_id) select (select id from t where k = 'w_comp'), id from t where k = 'b_entry';
select pg_temp.check('replies inherit the World and are never entries',
  (select world_id = (select id from t where k = 'w_comp') and not is_entry from public.posts where id = (select id from t where k = 'c_wreply')));
select pg_temp.check('leaderboard: Amigo pick 10 beats 2 likes + 1 reply (4); own likes/replies don''t count',
  pg_temp.q(null, format($$select string_agg(right(user_id::text, 1) || ':' || points || '#' || rank, ',' order by rank) from public.world_leaderboard(%L)$$, (select id from t where k = 'w_comp'))) = 'b:10#1,a:4#2');
select pg_temp.check('a like on an entry still notifies its author',
  (select count(*) = 1 from public.notifications where recipient_id = :A and actor_id = :C and kind = 'like' and post_id = (select id from t where k = 'a_entry')));
update public.post_likes set created_at = now() + interval '2 hours' where user_id = :C and post_id = (select id from t where k = 'a_entry');
select pg_temp.check('likes after the World ends don''t count (leaderboard freezes)',
  pg_temp.q(:B, format($$select points from public.world_leaderboard(%L) where user_id = '00000000-0000-0000-0000-00000000000a'$$, (select id from t where k = 'w_comp')))::int = 3);
select pg_temp.check('a World without competition has no leaderboard',
  pg_temp.q(:A, format('select count(*) from public.world_leaderboard(%L)', (select id from t where k = 'w_social')))::int = 0);
select pg_temp.must_fail('Amigo picks are admin-only', :A,
  format($$insert into public.world_host_picks (world_id, post_id) values (%L, %L)$$, (select id from t where k = 'w_comp'), (select id from t where k = 'a_entry')), '42501');

-- chat
select pg_temp.act_as(:A);
insert into public.world_chat_messages (world_id, body) select id, 'hello World' from t where k = 'w_comp';
select pg_temp.act_as_admin();
select pg_temp.check('members chat while live', pg_temp.q(:B, 'select count(*) from public.world_chat_messages')::int = 1);
select pg_temp.must_fail('non-members cannot chat', :D,
  format($$insert into public.world_chat_messages (world_id, body) values (%L, 'hi')$$, (select id from t where k = 'w_comp')), '42501');
select pg_temp.must_fail('no chat before a World starts', :A,
  format($$insert into public.world_chat_messages (world_id, body) values (%L, 'hi')$$, (select id from t where k = 'w_up')), '42501');
select pg_temp.must_fail('cannot chat as someone else', :A,
  format($$insert into public.world_chat_messages (world_id, author_id, body) values (%L, '00000000-0000-0000-0000-00000000000b', 'forged')$$, (select id from t where k = 'w_comp')), '42501');
select pg_temp.must_fail('empty chat message rejected', :A,
  format($$insert into public.world_chat_messages (world_id, body) values (%L, '   ')$$, (select id from t where k = 'w_comp')), '23514');
select pg_temp.must_fail('anon cannot read chat', null, 'select count(*) from public.world_chat_messages', '42501');
select pg_temp.must_fail('chat cannot be edited', :A, $$update public.world_chat_messages set body = 'edited'$$, '42501');
delete from public.worlds where slug = 'live-comp';
select pg_temp.check('deleting a World keeps its posts',
  (select world_id is null from public.posts where id = (select id from t where k = 'a_entry')));

-- ------------------------------------------------------------- support hub

select pg_temp.check('starter credits on first use', pg_temp.q(:A, 'select credits from public.support_wallet()')::int = 5);
select pg_temp.act_as(:A);
insert into t select 'sr1', (public.create_support_request('Listen to my song', 'Tell me if the chorus works for you.', 'https://soundcloud.com/ama/song', 'music', 'listen', 3)).id;
select pg_temp.act_as_admin();
select pg_temp.check('creating a request spends credits and waits for review',
  pg_temp.q(:A, 'select credits from public.support_wallet()')::int = 0
  and (select status = 'pending' from public.support_requests where id = (select id from t where k = 'sr1')));
select pg_temp.must_fail('not enough credits for a second request', :A,
  $$select public.create_support_request('Another one', 'Second request without credits.', 'https://example.com', 'app', 'try', 3)$$, 'SP008');
select pg_temp.must_fail('bad link rejected', :B, $$select public.create_support_request('Bad link', 'A javascript link should fail.', 'javascript:alert(1)', 'app', 'try', 3)$$, 'SP006');
select pg_temp.must_fail('target outside settings rejected', :B, $$select public.create_support_request('Tiny goal', 'Target of one is below the minimum.', 'https://example.com', 'app', 'try', 1)$$, 'SP006');
select pg_temp.check('pending requests are hidden from others',
  pg_temp.q(:B, format('select count(*) from public.support_requests where id = %L', (select id from t where k = 'sr1')))::int = 0
  and pg_temp.q(null, format('select count(*) from public.support_requests where id = %L', (select id from t where k = 'sr1')))::int = 0
  and pg_temp.q(:A, format('select count(*) from public.support_requests where id = %L', (select id from t where k = 'sr1')))::int = 1);
select pg_temp.must_fail('clients cannot insert requests directly', :B,
  $$insert into public.support_requests (creator_id, title, description, url, category, ask, target) values ('00000000-0000-0000-0000-00000000000b', 'x', 'y', 'https://e.com', 'app', 'try', 3)$$, '42501');
select pg_temp.must_fail('clients cannot mint credits', :B,
  $$insert into public.support_ledger (user_id, credits, reason) values ('00000000-0000-0000-0000-00000000000b', 999, 'admin')$$, '42501');
select pg_temp.must_fail('clients cannot edit requests', :A, $$update public.support_requests set supporter_count = 100$$, '42501');

-- admin is enforced in the database
select pg_temp.must_fail('non-admin cannot moderate', :B, format($$select public.admin_support_moderate(%L, 'approve')$$, (select id from t where k = 'sr1')), '42501');
select pg_temp.must_fail('non-admin cannot adjust credits', :B, $$select public.admin_support_adjust_credits('00000000-0000-0000-0000-00000000000b', 100, 'free money')$$, '42501');
select pg_temp.must_fail('non-admin cannot read reports', :B, 'select count(*) from public.support_reports', '42501');
select pg_temp.must_fail('non-admin cannot read the audit log', :B, 'select * from public.admin_audit(10)', '42501');
select pg_temp.must_fail('nobody can make themselves admin', :B, $$insert into public.app_admins (user_id) values ('00000000-0000-0000-0000-00000000000b')$$, '42501');
select pg_temp.check('is_admin is false for normal users', pg_temp.q(:B, 'select public.is_admin()')::boolean = false);
select pg_temp.act_as_admin();
insert into public.app_admins (user_id, note) values (:D, 'test admin');
select pg_temp.check('is_admin is true for admins', pg_temp.q(:D, 'select public.is_admin()')::boolean);
select pg_temp.act_as(:D);
select public.admin_support_moderate((select id from t where k = 'sr1'), 'approve', 'looks fine');
select public.admin_support_moderate((select id from t where k = 'sr1'), 'feature');
select pg_temp.act_as_admin();
select pg_temp.check('admin approve + feature', (select status = 'active' and featured from public.support_requests where id = (select id from t where k = 'sr1')));
select pg_temp.check('admin actions are audit-logged', (select count(*) = 2 from public.admin_audit_log where admin_id = :D and target_id = (select id from t where k = 'sr1')));

-- supporting
select pg_temp.must_fail('cannot support your own request', :A, format('select public.open_support(%L)', (select id from t where k = 'sr1')), 'SP001');
select pg_temp.must_fail('must open the link before confirming', :C, format('select * from public.confirm_support(%L)', (select id from t where k = 'sr1')), 'SP002');
select pg_temp.act_as(:B);
select public.open_support((select id from t where k = 'sr1'));
select pg_temp.act_as_admin();
select pg_temp.must_fail('confirming instantly is refused', :B, format('select * from public.confirm_support(%L)', (select id from t where k = 'sr1')), 'SP004');
update public.support_visits set opened_at = now() - interval '12 seconds' where user_id = :B;
create temp table sr_out as select pg_temp.q(:B, format('select credits || ''/'' || reputation from public.confirm_support(%L)', (select id from t where k = 'sr1'))) as earned;
select pg_temp.check('support earns credits and reputation',
  (select earned = '1/2' from sr_out)
  and pg_temp.q(:B, 'select credits || ''/'' || reputation || ''/'' || helped from public.support_wallet()') = '6/2/1'
  and (select supporter_count = 1 from public.support_requests where id = (select id from t where k = 'sr1')));
select pg_temp.must_fail('support once only', :B, format('select * from public.confirm_support(%L)', (select id from t where k = 'sr1')), 'SP003');
select pg_temp.check('written feedback earns a bonus',
  pg_temp.q(:B, format($$select credits from public.leave_support_feedback(%L, 'loved', 'Great chorus, start it earlier.')$$, (select id from t where k = 'sr1')))::int = 1);
select pg_temp.must_fail('feedback once only', :B, format($$select * from public.leave_support_feedback(%L, 'nice', 'again')$$, (select id from t where k = 'sr1')), 'SP003');
select pg_temp.check('feedback is private to the creator',
  pg_temp.q(:A, format('select count(*) from public.support_feedback(%L)', (select id from t where k = 'sr1')))::int = 1
  and pg_temp.q(:C, format('select count(*) from public.support_feedback(%L)', (select id from t where k = 'sr1')))::int = 0);
select pg_temp.check('ledgers are private',
  pg_temp.q(:C, $$select count(*) from public.support_ledger where user_id = '00000000-0000-0000-0000-00000000000b'$$)::int = 0
  and pg_temp.q(:C, $$select count(*) from public.support_visits where user_id = '00000000-0000-0000-0000-00000000000b'$$)::int = 0);

-- discovery
select pg_temp.check('For you skips what you already supported',
  pg_temp.q(:B, format($$select count(*) from public.support_discover('for_you') where id = %L$$, (select id from t where k = 'sr1')))::int = 0
  and pg_temp.q(:C, format($$select count(*) from public.support_discover('for_you') where id = %L$$, (select id from t where k = 'sr1')))::int = 1);
select pg_temp.check('For you never shows your own request',
  pg_temp.q(:A, format($$select count(*) from public.support_discover('for_you') where id = %L$$, (select id from t where k = 'sr1')))::int = 0
  and pg_temp.q(:A, format($$select count(*) from public.support_discover('mine') where id = %L$$, (select id from t where k = 'sr1')))::int = 1);
select pg_temp.check('category filter and search',
  pg_temp.q(:C, $$select count(*) from public.support_discover('new', 'music', 'chorus')$$)::int = 1
  and pg_temp.q(:C, $$select count(*) from public.support_discover('new', 'app', null)$$)::int = 0
  and pg_temp.q(:C, $$select count(*) from public.support_discover('new', null, '50%_off')$$)::int = 0);

-- completion (target 3)
select pg_temp.act_as(:C);
select public.open_support((select id from t where k = 'sr1'));
select pg_temp.act_as(:D);
select public.open_support((select id from t where k = 'sr1'));
select pg_temp.act_as_admin();
update public.support_visits set opened_at = now() - interval '2 minutes' where user_id in (:C, :D);
select pg_temp.q(:C, format('select credits from public.confirm_support(%L)', (select id from t where k = 'sr1')));
select pg_temp.q(:D, format('select credits from public.confirm_support(%L)', (select id from t where k = 'sr1')));
select pg_temp.check('reaching the goal completes the request',
  (select status = 'completed' and supporter_count = 3 and completed_at is not null from public.support_requests where id = (select id from t where k = 'sr1'))
  and pg_temp.q(:B, format($$select count(*) from public.support_discover('completed') where id = %L$$, (select id from t where k = 'sr1')))::int = 1);
select pg_temp.check('profile stats are public numbers', pg_temp.q(null, $$select helped || '/' || reputation from public.support_profile_stats('00000000-0000-0000-0000-00000000000b')$$) = '1/3');

-- reports, suspicious activity, credits, reject refund
select pg_temp.act_as(:C);
select public.report_support_request((select id from t where k = 'sr1'), 'Looks like spam');
select pg_temp.act_as_admin();
select pg_temp.must_fail('report once', :C, format($$select public.report_support_request(%L, 'again')$$, (select id from t where k = 'sr1')), 'SP007');
select pg_temp.check('admin sees reports', pg_temp.q(:D, 'select count(*) from public.admin_support_reports()')::int = 1);
select pg_temp.check('quick confirmations are flagged for admins',
  pg_temp.q(:D, $$select count(*) from public.admin_support_suspicious() where kind = 'quick-confirm' and user_id = '00000000-0000-0000-0000-00000000000b'$$)::int = 1);
select pg_temp.act_as(:D);
select public.admin_support_adjust_credits(:A, 5, 'test top-up');
select pg_temp.act_as(:A);
insert into t select 'sr2', (public.create_support_request('Try my app signup', 'Is signing up quick enough for you?', 'https://example.com/signup', 'app', 'try', 5)).id;
select pg_temp.act_as(:D);
select public.admin_support_moderate((select id from t where k = 'sr2'), 'reject', 'duplicate');
select pg_temp.act_as_admin();
select pg_temp.check('rejecting refunds the credits', pg_temp.q(:A, 'select credits from public.support_wallet()')::int = 5);
select pg_temp.must_fail('admins cannot overdraw a balance', :D, $$select public.admin_support_adjust_credits('00000000-0000-0000-0000-00000000000a', -50, 'too much')$$, 'SP006');
select pg_temp.check('reputation entries cannot be negative',
  (select count(*) = 1 from pg_constraint where conrelid = 'public.support_ledger'::regclass and pg_get_constraintdef(oid) like '%reputation >= 0%'));
select pg_temp.check('every admin action is in the audit log', pg_temp.q(:D, 'select count(*) from public.admin_audit(50)')::int = 4);

-- ------------------------------------------------------------ verification
-- :D is an admin (added in the support hub section).

select pg_temp.must_fail('people cannot verify themselves', :B,
  $$insert into public.profile_verifications (user_id, verification_type) values ('00000000-0000-0000-0000-00000000000b', 'creator')$$, '42501');
select pg_temp.must_fail('non-admin cannot call verify', :B, $$select public.admin_verify_user('00000000-0000-0000-0000-00000000000b', 'creator')$$, '42501');
select pg_temp.must_fail('non-admin cannot look up users', :B, $$select * from public.admin_user_lookup('ama_mensah')$$, '42501');
select pg_temp.act_as(:D);
select public.admin_verify_user(:B, 'creator', 'Checked their channel');
select pg_temp.act_as_admin();
select pg_temp.check('admin verifies a user', pg_temp.q(null, $$select verification_type from public.profile_verifications where user_id = '00000000-0000-0000-0000-00000000000b'$$) = 'creator');
select pg_temp.must_fail('the admin note is private', :B, $$select note from public.profile_verifications$$, '42501');
select pg_temp.must_fail('verified people cannot edit their verification', :B,
  $$update public.profile_verifications set verification_type = 'amigo' where user_id = '00000000-0000-0000-0000-00000000000b'$$, '42501');
select pg_temp.must_fail('verified people cannot remove it either', :B,
  $$delete from public.profile_verifications where user_id = '00000000-0000-0000-0000-00000000000b'$$, '42501');
select pg_temp.must_fail('profile edits cannot touch verification', :B,
  $$update public.profiles set verified = true where id = '00000000-0000-0000-0000-00000000000b'$$, '42703');
select pg_temp.must_fail('unknown verification type rejected', :D, $$select public.admin_verify_user('00000000-0000-0000-0000-00000000000b', 'king')$$, 'SP006');
select pg_temp.check('admin lookup shows type and note',
  pg_temp.q(:D, $$select verification_type || '|' || note from public.admin_user_lookup('@LEO_PARK')$$) = 'creator|Checked their channel');
select pg_temp.act_as(:D);
select public.admin_unverify_user(:B, 'test over');
select pg_temp.act_as_admin();
select pg_temp.check('admin removes verification', (select count(*) = 0 from public.profile_verifications where user_id = :B));
select pg_temp.must_fail('removing twice is an error', :D, $$select public.admin_unverify_user('00000000-0000-0000-0000-00000000000b')$$, 'SP006');
select pg_temp.check('verification changes are audit-logged',
  (select count(*) = 2 from public.admin_audit_log where target_id = :B and action in ('user.verify', 'user.unverify')));

-- ----------------------------------------------------------- owner account

select pg_temp.must_fail('owner list is not reachable by users', :A, 'select count(*) from admin_private.owner_accounts', '42501');
select pg_temp.must_fail('owner list is not reachable by anon', null, 'select count(*) from admin_private.owner_accounts', '42501');
select pg_temp.must_fail('users cannot register an owner email', :A,
  $$insert into admin_private.owner_accounts (email) values ('ama@example.com')$$, '42501');
select pg_temp.must_fail('owner grant function not callable by users', :A,
  $$select admin_private.apply_owner_account('00000000-0000-0000-0000-00000000000a')$$, '42501');
select pg_temp.act_as_admin();
insert into admin_private.owner_accounts (email) values ('owner@amigo.test');
-- Someone signs up with the owner address but never confirms it: nothing.
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000000f1', 'Owner@Amigo.test', '{"display_name":"Owner"}');
select pg_temp.check('unconfirmed owner email gets nothing',
  not exists (select 1 from public.app_admins where user_id = '00000000-0000-0000-0000-0000000000f1')
  and not exists (select 1 from public.profile_verifications where user_id = '00000000-0000-0000-0000-0000000000f1'));
update auth.users set email_confirmed_at = now() where id = '00000000-0000-0000-0000-0000000000f1';
select pg_temp.check('confirmed owner account becomes admin + Official Amigo account',
  exists (select 1 from public.app_admins where user_id = '00000000-0000-0000-0000-0000000000f1')
  and (select verification_type = 'amigo_team' from public.profile_verifications where user_id = '00000000-0000-0000-0000-0000000000f1'));
select pg_temp.check('owner is admin when signed in', pg_temp.q('00000000-0000-0000-0000-0000000000f1', 'select public.is_admin()')::boolean);
-- Registering an owner email for an account that already exists applies immediately.
update auth.users set email_confirmed_at = now() where id = :C;
insert into admin_private.owner_accounts (email) values ('zoe@example.com');
select pg_temp.check('registering an existing confirmed account applies at once',
  exists (select 1 from public.app_admins where user_id = :C));
select pg_temp.check('other accounts stay normal', not exists (select 1 from public.app_admins where user_id = :A)
  and not exists (select 1 from public.profile_verifications where user_id = :A));

-- ---------------------------------------------------------------- messages

-- A ↔ B talk; C is an outsider (and an admin by now); D is an admin.
create temp table dm_t (k text primary key, v text);
grant all on dm_t to authenticated, anon;
select pg_temp.must_fail('anon cannot open conversations', null, $$select public.dm_open('00000000-0000-0000-0000-00000000000b')$$, '42501');
select pg_temp.must_fail('cannot message yourself', :A, $$select public.dm_open('00000000-0000-0000-0000-00000000000a')$$, 'DM002');
select pg_temp.must_fail('cannot message nobody', :A, $$select public.dm_open(gen_random_uuid())$$, 'DM002');
insert into dm_t values ('conv', pg_temp.q(:A, $$select public.dm_open('00000000-0000-0000-0000-00000000000b')$$));
select pg_temp.check('the pair has one conversation (B opening it finds the same)',
  pg_temp.q(:B, $$select public.dm_open('00000000-0000-0000-0000-00000000000a')$$) = (select v from dm_t where k = 'conv'));
select pg_temp.check('both are participants', (select count(*) = 2 from public.dm_participants where conversation_id = (select v::uuid from dm_t where k = 'conv')));

-- Device keys
select pg_temp.must_fail('device keys must name your own user', :A,
  $$select public.e2e_upload_keys('AAADEV', '{"user_id":"@00000000-0000-0000-0000-00000000000b:amigo.world","device_id":"AAADEV","keys":{"ed25519:AAADEV":"x"}}', null, null)$$, 'DM006');
select pg_temp.must_fail('device keys must name the device', :A,
  $$select public.e2e_upload_keys('AAADEV', '{"user_id":"@00000000-0000-0000-0000-00000000000a:amigo.world","device_id":"OTHER","keys":{"ed25519:AAADEV":"x"}}', null, null)$$, 'DM006');
select pg_temp.check('upload device + one-time keys',
  pg_temp.q(:A, $$select public.e2e_upload_keys('AAADEV',
    '{"user_id":"@00000000-0000-0000-0000-00000000000a:amigo.world","device_id":"AAADEV","algorithms":["m.olm.v1.curve25519-aes-sha2","m.megolm.v1.aes-sha2"],"keys":{"ed25519:AAADEV":"edA","curve25519:AAADEV":"cvA"},"signatures":{}}',
    '{"signed_curve25519:K1":{"key":"k1"},"signed_curve25519:K2":{"key":"k2"}}',
    '{"signed_curve25519:F1":{"key":"f1","fallback":true}}') -> 'one_time_key_counts' ->> 'signed_curve25519'$$)::int = 2);
select pg_temp.must_fail('identity keys of a device cannot be swapped', :A,
  $$select public.e2e_upload_keys('AAADEV', '{"user_id":"@00000000-0000-0000-0000-00000000000a:amigo.world","device_id":"AAADEV","keys":{"ed25519:AAADEV":"evil","curve25519:AAADEV":"cvA"}}', null, null)$$, 'DM006');
select pg_temp.check('public device keys readable by signed-in users',
  pg_temp.q(:C, $$select public.e2e_query_keys(array['@00000000-0000-0000-0000-00000000000a:amigo.world']) #>> '{device_keys,@00000000-0000-0000-0000-00000000000a:amigo.world,AAADEV,keys,ed25519:AAADEV}'$$) = 'edA');
select pg_temp.must_fail('one-time keys are not directly readable', :B, $$select count(*) from public.e2e_one_time_keys$$, '42501');
select pg_temp.check('claim hands out a one-time key once',
  pg_temp.q(:B, $$select public.e2e_claim_keys('{"@00000000-0000-0000-0000-00000000000a:amigo.world":{"AAADEV":"signed_curve25519"}}')::text$$) like '%signed_curve25519:K%');
select pg_temp.q(:B, $$select public.e2e_claim_keys('{"@00000000-0000-0000-0000-00000000000a:amigo.world":{"AAADEV":"signed_curve25519"}}')::text$$);
select pg_temp.check('then the fallback key (kept)',
  pg_temp.q(:B, $$select public.e2e_claim_keys('{"@00000000-0000-0000-0000-00000000000a:amigo.world":{"AAADEV":"signed_curve25519"}}')::text$$) like '%signed_curve25519:F1%'
  and (select count(*) = 1 from public.e2e_one_time_keys where user_id = :A));
select pg_temp.check('key counts: one-time keys used up, fallback marked used',
  pg_temp.q(:A, $$select public.e2e_key_counts('AAADEV')::text$$)::jsonb = '{"signed_curve25519":0,"unused_fallback":false}');
select pg_temp.q(:B, $$select public.e2e_upload_keys('BBBDEV', '{"user_id":"@00000000-0000-0000-0000-00000000000b:amigo.world","device_id":"BBBDEV","keys":{"ed25519:BBBDEV":"edB","curve25519:BBBDEV":"cvB"}}', null, null)::text$$);

-- Messages: ciphertext only
select pg_temp.must_fail('plaintext body rejected', :A,
  format($$select * from public.dm_send(%L, 'AAADEV', '{"algorithm":"m.megolm.v1.aes-sha2","ciphertext":"x","session_id":"s","body":"hello"}')$$, (select v from dm_t where k = 'conv')), 'DM005');
select pg_temp.must_fail('unencrypted algorithm rejected', :A,
  format($$select * from public.dm_send(%L, 'AAADEV', '{"algorithm":"none","ciphertext":"hello","session_id":"s"}')$$, (select v from dm_t where k = 'conv')), 'DM005');
select pg_temp.must_fail('must send from your own registered device', :A,
  format($$select * from public.dm_send(%L, 'BBBDEV', '{"algorithm":"m.megolm.v1.aes-sha2","ciphertext":"x","session_id":"s"}')$$, (select v from dm_t where k = 'conv')), 'DM005');
select pg_temp.must_fail('outsiders cannot send into a conversation', :C,
  format($$select * from public.dm_send(%L, 'AAADEV', '{"algorithm":"m.megolm.v1.aes-sha2","ciphertext":"x","session_id":"s"}')$$, (select v from dm_t where k = 'conv')), 'DM003');
select pg_temp.must_fail('no direct inserts into dm_messages', :A,
  format($$insert into public.dm_messages (conversation_id, sender_id, sender_device_id, content) values (%L, '00000000-0000-0000-0000-00000000000a', 'AAADEV', '{"algorithm":"m.megolm.v1.aes-sha2","ciphertext":"x","session_id":"s"}')$$, (select v from dm_t where k = 'conv')), '42501');
select pg_temp.q(:A, format($$select id::text from public.dm_send(%L, 'AAADEV', '{"algorithm":"m.megolm.v1.aes-sha2","ciphertext":"CIPHERTEXT-1","session_id":"s1","sender_key":"cvA","device_id":"AAADEV"}')$$, (select v from dm_t where k = 'conv')));
select pg_temp.check('participant reads the ciphertext', pg_temp.q(:B, $$select content ->> 'ciphertext' from public.dm_messages limit 1$$) = 'CIPHERTEXT-1');
select pg_temp.check('outsider sees no conversations, participants or messages',
  pg_temp.q(:C, $$select (select count(*) from public.dm_messages) + (select count(*) from public.dm_conversations) + (select count(*) from public.dm_participants)$$)::int = 0);
select pg_temp.check('admins cannot read conversations either',
  pg_temp.q(:D, $$select (select count(*) from public.dm_messages) + (select count(*) from public.dm_conversations)$$)::int = 0);
select pg_temp.check('no column anywhere could hold a plaintext body',
  not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name like 'dm_%'
              and column_name in ('body', 'text', 'plaintext', 'message')));

-- Inbox, unread, receipts
select pg_temp.check('B has 1 unread', pg_temp.q(:B, $$select unread_count from public.dm_inbox()$$)::int = 1);
select pg_temp.check('A has 0 unread (own message)', pg_temp.q(:A, $$select unread_count from public.dm_inbox()$$)::int = 0);
select pg_temp.q(:B, $$select public.dm_mark_delivered()::text$$);
select pg_temp.check('delivered marker visible to the sender', pg_temp.q(:A, $$select (peer_last_delivered_at >= last_message_at)::text from public.dm_inbox()$$) = 'true');
select pg_temp.q(:B, format($$select public.dm_mark_read(%L)::text$$, (select v from dm_t where k = 'conv')));
select pg_temp.check('read marker visible to the sender; unread cleared',
  pg_temp.q(:A, $$select (peer_last_read_at >= last_message_at)::text from public.dm_inbox()$$) = 'true'
  and pg_temp.q(:B, $$select unread_count from public.dm_inbox()$$)::int = 0);
select pg_temp.must_fail('markers are not client-writable', :B,
  $$update public.dm_participants set last_read_at = now() where user_id = '00000000-0000-0000-0000-00000000000a'$$, '42501');

-- To-device mail (how conversation keys travel)
select pg_temp.must_fail('room keys must be Olm-encrypted', :A,
  $$select public.e2e_send_to_device('m.room.encrypted', '{"@00000000-0000-0000-0000-00000000000b:amigo.world":{"BBBDEV":{"algorithm":"m.megolm.v1.aes-sha2","room_key":"PLAINTEXT"}}}')$$, 'DM007');
select pg_temp.must_fail('plaintext m.room_key events not allowed', :A,
  $$select public.e2e_send_to_device('m.room_key', '{"@00000000-0000-0000-0000-00000000000b:amigo.world":{"BBBDEV":{"session_key":"x"}}}')$$, 'DM007');
select pg_temp.must_fail('cannot mail strangers', :C,
  $$select public.e2e_send_to_device('m.room.encrypted', '{"@00000000-0000-0000-0000-00000000000b:amigo.world":{"BBBDEV":{"algorithm":"m.olm.v1.curve25519-aes-sha2","ciphertext":{}}}}')$$, 'DM007');
select pg_temp.q(:A, $$select public.e2e_send_to_device('m.room.encrypted', '{"@00000000-0000-0000-0000-00000000000b:amigo.world":{"BBBDEV":{"algorithm":"m.olm.v1.curve25519-aes-sha2","sender_key":"cvA","ciphertext":{"cvB":{"type":0,"body":"OLM"}}}}}')::text$$);
select pg_temp.check('recipient reads its mail; others cannot',
  pg_temp.q(:B, $$select count(*) from public.e2e_to_device$$)::int = 1
  and pg_temp.q(:A, $$select count(*) from public.e2e_to_device$$)::int = 0
  and pg_temp.q(:D, $$select count(*) from public.e2e_to_device$$)::int = 0);
select pg_temp.q(:B, $$select public.e2e_ack_to_device('BBBDEV', (select max(id) from public.e2e_to_device))::text$$);
select pg_temp.check('acknowledged mail is deleted', (select count(*) = 0 from public.e2e_to_device where recipient_id = :B));
select pg_temp.check('device changes listed for conversation partners only',
  pg_temp.q(:A, $$select count(*) from public.e2e_device_changes('-infinity') where user_id = '@00000000-0000-0000-0000-00000000000b:amigo.world'$$)::int = 1
  and pg_temp.q(:C, $$select count(*) from public.e2e_device_changes('-infinity') where user_id = '@00000000-0000-0000-0000-00000000000b:amigo.world'$$)::int = 0);

-- Blocking
select pg_temp.q(:B, $$select public.dm_block('00000000-0000-0000-0000-00000000000a')::text$$);
select pg_temp.must_fail('blocked person cannot send', :A,
  format($$select * from public.dm_send(%L, 'AAADEV', '{"algorithm":"m.megolm.v1.aes-sha2","ciphertext":"x","session_id":"s"}')$$, (select v from dm_t where k = 'conv')), 'DM004');
select pg_temp.must_fail('the blocker cannot send either', :B,
  format($$select * from public.dm_send(%L, 'BBBDEV', '{"algorithm":"m.megolm.v1.aes-sha2","ciphertext":"x","session_id":"s"}')$$, (select v from dm_t where k = 'conv')), 'DM004');
select pg_temp.check('blocked side sees can_send=false but not who blocked',
  pg_temp.q(:A, $$select can_send::text || '/' || blocked_by_me::text from public.dm_inbox()$$) = 'false/false'
  and pg_temp.q(:A, $$select count(*) from public.user_blocks$$)::int = 0);
select pg_temp.check('blocker sees their block', pg_temp.q(:B, $$select blocked_by_me::text from public.dm_inbox()$$) = 'true');
select pg_temp.must_fail('blocks are not client-writable', :A, $$delete from public.user_blocks$$, '42501');
select pg_temp.q(:B, $$select public.dm_unblock('00000000-0000-0000-0000-00000000000a')::text$$);
select pg_temp.check('unblocked: can send again', pg_temp.q(:A, $$select can_send::text from public.dm_inbox()$$) = 'true');

-- Reports
select pg_temp.must_fail('outsiders cannot report a conversation', :C,
  format($$select public.dm_report(%L, 'spam', '', '[]')$$, (select v from dm_t where k = 'conv')), 'DM003');
select pg_temp.must_fail('report reason checked', :B,
  format($$select public.dm_report(%L, 'boring', '', '[]')$$, (select v from dm_t where k = 'conv')), 'DM008');
select pg_temp.q(:B, format($$select public.dm_report(%L, 'harassment', 'please look', '[{"id":"m1","text":"revealed by reporter"}]')::text$$, (select v from dm_t where k = 'conv')));
select pg_temp.must_fail('reports are not readable by users', :B, $$select count(*) from public.dm_reports$$, '42501');
select pg_temp.must_fail('report list is admin-only', :A, $$select count(*) from public.admin_dm_reports()$$, '42501');
select pg_temp.check('admin sees the report with the reporter-revealed evidence only',
  pg_temp.q(:D, $$select evidence #>> '{0,text}' from public.admin_dm_reports() limit 1$$) = 'revealed by reporter');

-- Attachments bucket
select pg_temp.act_as(:A);
insert into storage.objects (bucket_id, name) values ('dm-attachments', (select v from dm_t where k = 'conv') || '/blob1');
select pg_temp.act_as_admin();
select pg_temp.check('participant uploads encrypted attachment; other participant can fetch it',
  pg_temp.q(:B, $$select count(*) from storage.objects where bucket_id = 'dm-attachments'$$)::int = 1);
select pg_temp.check('outsider cannot see attachments', pg_temp.q(:C, $$select count(*) from storage.objects where bucket_id = 'dm-attachments'$$)::int = 0);
select pg_temp.must_fail('outsider cannot upload into a conversation', :C,
  format($$insert into storage.objects (bucket_id, name) values ('dm-attachments', %L)$$, (select v from dm_t where k = 'conv') || '/x'), '42501');
select pg_temp.check('dm-attachments bucket is private', (select not public from storage.buckets where id = 'dm-attachments'));

-- Devices
select pg_temp.q(:A, $$select public.e2e_delete_device('AAADEV')::text$$);
select pg_temp.check('signing a device out removes its keys', (select count(*) = 0 from public.e2e_devices where user_id = :A)
  and (select count(*) = 0 from public.e2e_one_time_keys where user_id = :A));

-- ------------------------------------------------------ messaging security

select pg_temp.q(:A, $$select public.e2e_upload_keys('AAA2', '{"user_id":"@00000000-0000-0000-0000-00000000000a:amigo.world","device_id":"AAA2","keys":{"ed25519:AAA2":"edA2","curve25519:AAA2":"cvA2"},"signatures":{"@00000000-0000-0000-0000-00000000000a:amigo.world":{"ed25519:AAA2":"selfsig"}}}', null, null)::text$$);

-- Cross-signing keys
select pg_temp.must_fail('cross-signing keys must be your own', :A,
  $$select public.e2e_upload_signing_keys('{"user_id":"@00000000-0000-0000-0000-00000000000b:amigo.world","usage":["master"],"keys":{"ed25519:MK":"MK"}}', null, null)$$, 'DM011');
select pg_temp.must_fail('cross-signing key usage must match its slot', :A,
  $$select public.e2e_upload_signing_keys('{"user_id":"@00000000-0000-0000-0000-00000000000a:amigo.world","usage":["self_signing"],"keys":{"ed25519:MK":"MK"}}', null, null)$$, 'DM011');
select pg_temp.q(:A, $$select public.e2e_upload_signing_keys(
  '{"user_id":"@00000000-0000-0000-0000-00000000000a:amigo.world","usage":["master"],"keys":{"ed25519:MKA":"MKA"},"signatures":{}}',
  '{"user_id":"@00000000-0000-0000-0000-00000000000a:amigo.world","usage":["self_signing"],"keys":{"ed25519:SSA":"SSA"},"signatures":{}}',
  '{"user_id":"@00000000-0000-0000-0000-00000000000a:amigo.world","usage":["user_signing"],"keys":{"ed25519:USA":"USA"},"signatures":{}}')::text$$);
select pg_temp.check('anyone signed in sees the public master + self-signing key',
  pg_temp.q(:C, $$select (public.e2e_query_keys(array['@00000000-0000-0000-0000-00000000000a:amigo.world']) #>> '{master_keys,@00000000-0000-0000-0000-00000000000a:amigo.world,keys,ed25519:MKA}')
                    || (public.e2e_query_keys(array['@00000000-0000-0000-0000-00000000000a:amigo.world']) #>> '{self_signing_keys,@00000000-0000-0000-0000-00000000000a:amigo.world,keys,ed25519:SSA}')$$) = 'MKASSA');
select pg_temp.check('the user-signing key is only returned to its owner',
  pg_temp.q(:C, $$select public.e2e_query_keys(array['@00000000-0000-0000-0000-00000000000a:amigo.world']) -> 'user_signing_keys' ? '@00000000-0000-0000-0000-00000000000a:amigo.world'$$) = 'false'
  and pg_temp.q(:A, $$select public.e2e_query_keys(array['@00000000-0000-0000-0000-00000000000a:amigo.world']) -> 'user_signing_keys' ? '@00000000-0000-0000-0000-00000000000a:amigo.world'$$) = 'true');
select pg_temp.must_fail('cross-signing keys not directly readable', :A, $$select count(*) from public.e2e_cross_signing_keys$$, '42501');

-- Signatures
select pg_temp.must_fail('only your own signatures are accepted', :A,
  $$select public.e2e_upload_signatures('{"@00000000-0000-0000-0000-00000000000a:amigo.world":{"AAA2":{"signatures":{"@00000000-0000-0000-0000-00000000000b:amigo.world":{"ed25519:X":"forged"}}}}}')$$, 'DM011');
select pg_temp.q(:A, $$select public.e2e_upload_signatures('{"@00000000-0000-0000-0000-00000000000a:amigo.world":{"AAA2":{"signatures":{"@00000000-0000-0000-0000-00000000000a:amigo.world":{"ed25519:SSA":"ssig"}}}}}')::text$$);
select pg_temp.check('self-signing signature merged into the device (earlier signatures kept)',
  (select device_keys #>> '{signatures,@00000000-0000-0000-0000-00000000000a:amigo.world,ed25519:SSA}' = 'ssig'
      and device_keys #>> '{signatures,@00000000-0000-0000-0000-00000000000a:amigo.world,ed25519:AAA2}' = 'selfsig'
   from public.e2e_devices where user_id = :A and device_id = 'AAA2'));
select pg_temp.q(:A, $$select public.e2e_upload_keys('AAA2', '{"user_id":"@00000000-0000-0000-0000-00000000000a:amigo.world","device_id":"AAA2","keys":{"ed25519:AAA2":"edA2","curve25519:AAA2":"cvA2"},"signatures":{"@00000000-0000-0000-0000-00000000000a:amigo.world":{"ed25519:AAA2":"selfsig"}}}', null, null)::text$$);
select pg_temp.check('re-uploading device keys keeps the cross-signing signature',
  (select device_keys #>> '{signatures,@00000000-0000-0000-0000-00000000000a:amigo.world,ed25519:SSA}' = 'ssig' from public.e2e_devices where user_id = :A and device_id = 'AAA2'));
select pg_temp.q(:B, $$select public.e2e_upload_signing_keys('{"user_id":"@00000000-0000-0000-0000-00000000000b:amigo.world","usage":["master"],"keys":{"ed25519:MKB":"MKB"},"signatures":{}}', null, null)::text$$);
select pg_temp.q(:A, $$select public.e2e_upload_signatures('{"@00000000-0000-0000-0000-00000000000b:amigo.world":{"MKB":{"signatures":{"@00000000-0000-0000-0000-00000000000a:amigo.world":{"ed25519:USA":"A-verified-B"}}}}}')::text$$);
select pg_temp.check('"A verified B" is visible to A only',
  pg_temp.q(:A, $$select public.e2e_query_keys(array['@00000000-0000-0000-0000-00000000000b:amigo.world'])::text$$) like '%A-verified-B%'
  and pg_temp.q(:B, $$select public.e2e_query_keys(array['@00000000-0000-0000-0000-00000000000b:amigo.world'])::text$$) not like '%A-verified-B%'
  and pg_temp.q(:C, $$select public.e2e_query_keys(array['@00000000-0000-0000-0000-00000000000b:amigo.world'])::text$$) not like '%A-verified-B%');
select pg_temp.must_fail('signing an unknown key is refused', :A,
  $$select public.e2e_upload_signatures('{"@00000000-0000-0000-0000-00000000000b:amigo.world":{"NOPE":{"signatures":{"@00000000-0000-0000-0000-00000000000a:amigo.world":{"ed25519:USA":"x"}}}}}')$$, 'DM011');

-- Verification relay
select pg_temp.q(:A, $$select public.e2e_send_to_device('m.key.verification.request', '{"@00000000-0000-0000-0000-00000000000b:amigo.world":{"BBBDEV":{"from_device":"AAA2","methods":["m.sas.v1"],"transaction_id":"t1"}}}')::text$$);
select pg_temp.check('emoji-verification messages are relayed', pg_temp.q(:B, $$select count(*) from public.e2e_to_device where event_type = 'm.key.verification.request'$$)::int = 1);
select pg_temp.must_fail('secrets never travel in plaintext (m.secret.send refused)', :A,
  $$select public.e2e_send_to_device('m.secret.send', '{"@00000000-0000-0000-0000-00000000000a:amigo.world":{"AAA2":{"secret":"x"}}}')$$, 'DM007');

-- Your devices
select pg_temp.q(:A, $$select public.e2e_touch_device('AAA2', 'Chrome on Windows')::text$$);
select pg_temp.check('your devices: name and last active, for you only',
  pg_temp.q(:A, $$select display_name || '/' || (last_seen_at is not null) from public.e2e_my_devices() where device_id = 'AAA2'$$) = 'Chrome on Windows/true'
  and pg_temp.q(:B, $$select count(*) from public.e2e_my_devices() where device_id = 'AAA2'$$)::int = 0);
select pg_temp.must_fail('device names are private', :B, $$select display_name from public.e2e_devices$$, '42501');
select pg_temp.q(:A, $$select public.e2e_remove_device('AAA2')::text$$);
select pg_temp.check('removed device: keys gone', (select count(*) = 0 from public.e2e_devices where user_id = :A and device_id = 'AAA2'));
select pg_temp.must_fail('removed device cannot come back under the same id', :A,
  $$select public.e2e_upload_keys('AAA2', '{"user_id":"@00000000-0000-0000-0000-00000000000a:amigo.world","device_id":"AAA2","keys":{"ed25519:AAA2":"edA2"}}', null, null)$$, 'DM009');
select pg_temp.q(:A, $$select public.e2e_remove_device('BBBDEV')::text$$);
select pg_temp.check('removing only ever touches your own devices (A "removing" BBBDEV leaves B''s device alone)',
  (select count(*) = 1 from public.e2e_devices where user_id = :B and device_id = 'BBBDEV')
  and not exists (select 1 from public.e2e_revoked_devices where user_id = :B));

-- Key backup
select pg_temp.must_fail('backup must use the megolm backup algorithm', :A,
  $$select public.e2e_backup_create('plaintext', '{"public_key":"PUB"}')$$, 'DM011');
insert into dm_t values ('bv', pg_temp.q(:A, $$select public.e2e_backup_create('m.megolm_backup.v1.curve25519-aes-sha2', '{"public_key":"PUB","signatures":{}}')$$));
select pg_temp.must_fail('backed-up keys must be encrypted (no plaintext session key)', :A,
  format($$select public.e2e_backup_put(%L, '{"!r:amigo.world":{"sessions":{"s1":{"first_message_index":0,"session_data":{"ciphertext":"c","ephemeral":"e","mac":"m","session_key":"PLAINTEXT"}}}}}')$$, (select v from dm_t where k = 'bv')), 'DM011');
select pg_temp.q(:A, format($$select public.e2e_backup_put(%L, '{"!r:amigo.world":{"sessions":{"s1":{"first_message_index":5,"forwarded_count":0,"is_verified":true,"session_data":{"ciphertext":"c5","ephemeral":"e","mac":"m"}}}}}')::text$$, (select v from dm_t where k = 'bv')));
select pg_temp.q(:A, format($$select public.e2e_backup_put(%L, '{"!r:amigo.world":{"sessions":{"s1":{"first_message_index":9,"forwarded_count":0,"is_verified":true,"session_data":{"ciphertext":"c9","ephemeral":"e","mac":"m"}}}}}')::text$$, (select v from dm_t where k = 'bv')));
select pg_temp.check('backup keeps the better copy of a key', (select session_data ->> 'ciphertext' = 'c5' from public.e2e_backup_keys where session_id = 's1'));
select pg_temp.check('owner restores their encrypted keys',
  pg_temp.q(:A, format($$select public.e2e_backup_get(%L) #>> '{!r:amigo.world,sessions,s1,session_data,ciphertext}'$$, (select v from dm_t where k = 'bv'))) = 'c5');
select pg_temp.check('nobody else can fetch someone''s backup (not even admins)',
  pg_temp.q(:B, format($$select public.e2e_backup_get(%L)::text$$, (select v from dm_t where k = 'bv'))) = '{}'
  and pg_temp.q(:D, format($$select public.e2e_backup_get(%L)::text$$, (select v from dm_t where k = 'bv'))) = '{}'
  and pg_temp.q(:D, $$select coalesce(public.e2e_backup_current()::text, 'none')$$) = 'none');
select pg_temp.must_fail('backup tables not directly readable', :D, $$select count(*) from public.e2e_backup_keys$$, '42501');
select pg_temp.q(:A, $$select public.e2e_backup_create('m.megolm_backup.v1.curve25519-aes-sha2', '{"public_key":"PUB2"}')$$);
select pg_temp.must_fail('writing to a replaced backup version is refused', :A,
  format($$select public.e2e_backup_put(%L, '{}')$$, (select v from dm_t where k = 'bv')), 'DM010');
select pg_temp.check('a new backup replaces the old one and its keys', (select count(*) = 0 from public.e2e_backup_keys where session_id = 's1'));

-- Message report review
select pg_temp.must_fail('only admins review message reports', :A,
  format($$select public.admin_dm_report_set_status(%L, 'reviewed')$$, (select id from public.dm_reports limit 1)), '42501');
select pg_temp.q(:D, format($$select public.admin_dm_report_set_status(%L, 'reviewed')::text$$, (select id from public.dm_reports limit 1)));
select pg_temp.check('admin marks a report reviewed (audit-logged)',
  pg_temp.q(:D, $$select status || '/' || (reviewed_by_username is not null) from public.admin_dm_reports() limit 1$$) = 'reviewed/true'
  and exists (select 1 from public.admin_audit_log where action = 'dm_report.reviewed'));
select pg_temp.check('admins still can''t read any conversation',
  pg_temp.q(:D, $$select (select count(*) from public.dm_messages) + (select count(*) from public.dm_conversations) + (select count(*) from public.e2e_to_device)$$)::int = 0);

-- ----------------------------------------------------------------- moments

-- A posts; B follows A; C doesn't; D is an admin.
delete from public.follows where follower_id in (:B, :C) and followee_id = :A;
insert into public.follows (follower_id, followee_id) values (:B, :A);
delete from public.user_blocks;
create temp table mo_t (k text primary key, v text);
grant all on mo_t to authenticated, anon;
select pg_temp.must_fail('anon cannot post Moments', null, $$select public.create_moment('hi', 'coral', null, null, null, 'everyone')$$, '42501');
select pg_temp.must_fail('empty Moment rejected', :A, $$select public.create_moment('  ', 'coral', null, null, null, 'everyone')$$, 'MO001');
select pg_temp.must_fail('unknown background rejected', :A, $$select public.create_moment('hi', 'neon', null, null, null, 'everyone')$$, 'MO001');
select pg_temp.must_fail('photo must be in your own folder', :A, $$select public.create_moment('', 'coral', '00000000-0000-0000-0000-00000000000b/x.jpg', 10, 10, 'everyone')$$, 'MO003');
insert into mo_t values ('pub', pg_temp.q(:A, $$select public.create_moment('hello everyone', 'ocean', null, null, null, 'everyone')$$));
insert into mo_t values ('fol', pg_temp.q(:A, $$select public.create_moment('', 'coral', '00000000-0000-0000-0000-00000000000a/m.jpg', 1080, 1920, 'followers')$$));
select pg_temp.check('Moments expire 24 hours after posting', (select expires_at - created_at = interval '24 hours' from public.moments where id = (select v::uuid from mo_t where k = 'pub')));
select pg_temp.check('a follower sees both', pg_temp.q(:B, $$select count(*) from public.moments_feed() where author_id = '00000000-0000-0000-0000-00000000000a'$$)::int = 2);
select pg_temp.check('a non-follower sees only the public one',
  pg_temp.q(:C, $$select count(*) from public.moments_feed() where author_id = '00000000-0000-0000-0000-00000000000a'$$)::int = 1
  and pg_temp.q(:C, $$select count(*) from public.moments where author_id = '00000000-0000-0000-0000-00000000000a'$$)::int = 1);
select pg_temp.must_fail('anon sees no Moments', null, $$select count(*) from public.moments$$, '42501');
select pg_temp.must_fail('no direct writes', :A, $$update public.moments set expires_at = now() + interval '10 days'$$, '42501');
select pg_temp.must_fail('non-follower can''t mark a followers-only Moment seen', :C,
  format($$select public.mark_moment_seen(%L)$$, (select v from mo_t where k = 'fol')), 'MO002');

-- Views, reactions, viewers
select pg_temp.q(:B, format($$select public.mark_moment_seen(%L)::text$$, (select v from mo_t where k = 'pub')));
select pg_temp.q(:B, format($$select public.mark_moment_seen(%L)::text$$, (select v from mo_t where k = 'pub')));
select pg_temp.check('seen once (and shows as seen)', pg_temp.q(:B, format($$select seen::text from public.moments_feed() where id = %L$$, (select v from mo_t where k = 'pub'))) = 'true'
  and (select count(*) = 1 from public.moment_views where moment_id = (select v::uuid from mo_t where k = 'pub')));
select pg_temp.must_fail('only the listed reactions', :B, format($$select public.react_to_moment(%L, '💩')$$, (select v from mo_t where k = 'pub')), 'MO001');
select pg_temp.q(:B, format($$select public.react_to_moment(%L, '🔥')::text$$, (select v from mo_t where k = 'pub')));
select pg_temp.q(:C, format($$select public.react_to_moment(%L, '❤️')::text$$, (select v from mo_t where k = 'pub')));
select pg_temp.must_fail('can''t react to your own', :A, format($$select public.react_to_moment(%L, '❤️')$$, (select v from mo_t where k = 'pub')), 'MO003');
select pg_temp.check('author sees view count', pg_temp.q(:A, format($$select view_count from public.moments_feed() where id = %L$$, (select v from mo_t where k = 'pub')))::int = 2);
select pg_temp.check('others don''t see view counts', pg_temp.q(:B, format($$select coalesce(view_count::text, 'none') from public.moments_feed() where id = %L$$, (select v from mo_t where k = 'pub'))) = 'none');
select pg_temp.check('author lists viewers with reactions',
  pg_temp.q(:A, format($$select string_agg(reaction, '' order by reaction) from public.moment_viewers(%L)$$, (select v from mo_t where k = 'pub'))) = '❤️🔥');
select pg_temp.must_fail('only the author lists viewers', :B, format($$select * from public.moment_viewers(%L)$$, (select v from mo_t where k = 'pub')), 'MO003');
select pg_temp.must_fail('views/reactions not directly readable', :A, $$select count(*) from public.moment_views$$, '42501');
select pg_temp.q(:B, format($$select public.react_to_moment(%L, null)::text$$, (select v from mo_t where k = 'pub')));
select pg_temp.check('reaction can be removed', pg_temp.q(:B, format($$select coalesce(my_reaction, 'none') from public.moments_feed() where id = %L$$, (select v from mo_t where k = 'pub'))) = 'none');

-- Blocking hides Moments both ways
select pg_temp.q(:C, $$select public.dm_block('00000000-0000-0000-0000-00000000000a')::text$$);
select pg_temp.check('blocked: neither sees the other''s Moments', pg_temp.q(:C, $$select count(*) from public.moments_feed() where author_id = '00000000-0000-0000-0000-00000000000a'$$)::int = 0);
select pg_temp.q(:C, $$select public.dm_unblock('00000000-0000-0000-0000-00000000000a')::text$$);

-- Expiry
update public.moments set created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour' where id = (select v::uuid from mo_t where k = 'pub');
select pg_temp.check('expired Moments disappear for everyone, author included',
  pg_temp.q(:B, $$select count(*) from public.moments_feed() where author_id = '00000000-0000-0000-0000-00000000000a'$$)::int = 1
  and pg_temp.q(:A, $$select count(*) from public.moments_feed() where author_id = '00000000-0000-0000-0000-00000000000a'$$)::int = 1);
select pg_temp.must_fail('expired: can''t react any more', :B, format($$select public.react_to_moment(%L, '🔥')$$, (select v from mo_t where k = 'pub')), 'MO002');
update public.moments set created_at = now(), expires_at = now() + interval '24 hours' where id = (select v::uuid from mo_t where k = 'pub');

-- Reports + admin removal
select pg_temp.must_fail('can''t report your own', :A, format($$select public.report_moment(%L, 'spam', '')$$, (select v from mo_t where k = 'pub')), 'MO003');
select pg_temp.q(:C, format($$select public.report_moment(%L, 'spam', 'buy now')::text$$, (select v from mo_t where k = 'pub')));
select pg_temp.must_fail('reports are admin-only', :B, $$select count(*) from public.admin_moment_reports()$$, '42501');
select pg_temp.check('admin sees the reported Moment', pg_temp.q(:D, $$select body from public.admin_moment_reports() limit 1$$) = 'hello everyone');
select pg_temp.must_fail('only admins remove Moments', :B, format($$select public.admin_remove_moment(%L, '')$$, (select v from mo_t where k = 'pub')), '42501');
select pg_temp.q(:D, format($$select public.admin_remove_moment(%L, 'spam link')::text$$, (select v from mo_t where k = 'pub')));
select pg_temp.check('removed Moment is gone for everyone', pg_temp.q(:B, format($$select count(*) from public.moments_feed() where id = %L$$, (select v from mo_t where k = 'pub')))::int = 0
  and pg_temp.q(:A, format($$select count(*) from public.moments_feed() where id = %L$$, (select v from mo_t where k = 'pub')))::int = 0);
select pg_temp.check('removal is audit-logged and closes the report',
  exists (select 1 from public.admin_audit_log where action = 'moment.remove' and summary like 'removed a Moment by @% — spam link')
  and pg_temp.q(:D, $$select status || '/' || removed from public.admin_moment_reports() limit 1$$) = 'reviewed/true');
select pg_temp.check('admins get no path to Moment replies (they are direct messages)',
  pg_temp.q(:D, $$select count(*) from public.dm_messages$$)::int = 0);

-- Delete your own
select pg_temp.must_fail('can''t delete someone else''s Moment', :B, format($$select public.delete_moment(%L)$$, (select v from mo_t where k = 'fol')), 'MO003');
insert into mo_t values ('delpath', pg_temp.q(:A, format($$select public.delete_moment(%L)$$, (select v from mo_t where k = 'fol'))));
select pg_temp.check('author deletes their Moment (returns the photo path for cleanup)',
  (select v = '00000000-0000-0000-0000-00000000000a/m.jpg' from mo_t where k = 'delpath')
  and not exists (select 1 from public.moments where id = (select v::uuid from mo_t where k = 'fol')));

-- Storage
select pg_temp.check('moment-media bucket is private', (select not public from storage.buckets where id = 'moment-media'));
insert into mo_t values ('ph', pg_temp.q(:A, $$select public.create_moment('', 'coral', '00000000-0000-0000-0000-00000000000a/f.jpg', 10, 10, 'followers')$$));
insert into storage.objects (bucket_id, name) values ('moment-media', '00000000-0000-0000-0000-00000000000a/f.jpg');
select pg_temp.check('followers can fetch the photo; others can''t',
  pg_temp.q(:B, $$select count(*) from storage.objects where bucket_id = 'moment-media'$$)::int = 1
  and pg_temp.q(:C, $$select count(*) from storage.objects where bucket_id = 'moment-media'$$)::int = 0);
select pg_temp.must_fail('upload only into your own folder', :B,
  $$insert into storage.objects (bucket_id, name) values ('moment-media', '00000000-0000-0000-0000-00000000000a/evil.jpg')$$, '42501');
select pg_temp.must_fail('purge is not callable by users', :A, $$select public.purge_expired_moments()$$, '42501');

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
select pg_temp.must_fail('trigger functions not callable by users', :A, $$select public.mentioned_usernames('@x')$$, '42501');
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
