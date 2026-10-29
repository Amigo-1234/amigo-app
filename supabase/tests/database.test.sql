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

-- Key backup: written only through the verifying API (server secret), by a device of yours that
-- is not removed, carries a signature from your current self-signing key, and presents a one-time
-- challenge it was issued; the keys must be the ones the API checked. The API checks the actual
-- Ed25519 signatures (scripts/test/e2e-proof.test.mjs); here: everything Postgres enforces.
insert into public.push_server (key_hash) values (encode(sha256(convert_to('test-server-secret', 'UTF8')), 'hex'))
  on conflict (id) do update set key_hash = excluded.key_hash;
-- AAA3: a new device of A's, signed only by itself; AAA2 was removed above.
select pg_temp.q(:A, $$select public.e2e_upload_keys('AAA3', '{"user_id":"@00000000-0000-0000-0000-00000000000a:amigo.world","device_id":"AAA3","keys":{"ed25519:AAA3":"edA3","curve25519:AAA3":"cvA3"},"signatures":{"@00000000-0000-0000-0000-00000000000a:amigo.world":{"ed25519:AAA3":"selfsig3"}}}', null, null)::text$$);
create function pg_temp.challenge(p_uid uuid, p_device text) returns text language sql as $$
  select pg_temp.q(p_uid, format('select public.e2e_proof_challenge(%L)', p_device)) $$;
create function pg_temp.create_sql(p_device text, p_nonce text, p_hash text, p_pub text) returns text language sql as $$
  select format($f$select public.e2e_backup_create_verified('test-server-secret', %L, %L, %L, 'm.megolm_backup.v1.curve25519-aes-sha2', %L)$f$,
                p_device, p_nonce, p_hash, json_build_object('public_key', p_pub)::text) $$;
create function pg_temp.put_sql(p_device text, p_nonce text, p_hash text, p_version text, p_rooms text) returns text language sql as $$
  select format($f$select public.e2e_backup_put_verified('test-server-secret', %L, %L, %L, %L, %L)::text$f$, p_device, p_nonce, p_hash, p_version, p_rooms) $$;
create function pg_temp.room(p_cipher text, p_index int, p_verified boolean) returns text language sql as $$
  select json_build_object('!r:amigo.world', json_build_object('sessions', json_build_object('s1', json_build_object(
    'first_message_index', p_index, 'forwarded_count', 0, 'is_verified', p_verified,
    'session_data', json_build_object('ciphertext', p_cipher, 'ephemeral', 'e', 'mac', 'm')))))::text $$;

select pg_temp.must_fail('backup: the old unverified write functions are gone', :A,
  $$select public.e2e_backup_create('AAA3', 'm.megolm_backup.v1.curve25519-aes-sha2', '{"public_key":"PUB"}'::jsonb)$$, '42883');
select pg_temp.must_fail('backup: a challenge is only for your own existing device', :A, $$select public.e2e_proof_challenge('NOSUCHDEV')$$, 'DM012');
select pg_temp.must_fail('backup: no challenge for a removed device', :A, $$select public.e2e_proof_challenge('AAA2')$$, 'DM009');
select pg_temp.must_fail('backup: signed out gets no challenge', null, $$select public.e2e_proof_challenge('AAA3')$$, '42501');
select pg_temp.must_fail('backup: key material is for the server only', :A, $$select public.e2e_proof_material(null, 'AAA3')$$, '42501');
select pg_temp.must_fail('backup: key material needs an approved identity (no signing keys yet = refused)', :C,
  $$select public.e2e_proof_material('test-server-secret', 'CCDEV')$$, 'DM012');
select pg_temp.must_fail('backup: writes need the server secret (a signed-in person can''t call them)', :A,
  format($$select public.e2e_backup_create_verified(null, 'AAA3', %L, %L, 'm.megolm_backup.v1.curve25519-aes-sha2', '{"public_key":"PUB"}')$$,
         pg_temp.challenge(:A, 'AAA3'), public.e2e_proof_hash(:A, 'AAA3')), '42501');
select pg_temp.must_fail('backup: a device not signed by the self-signing key is refused, even through the server', :A,
  pg_temp.create_sql('AAA3', pg_temp.challenge(:A, 'AAA3'), public.e2e_proof_hash(:A, 'AAA3'), 'PUB'), 'DM012');
select pg_temp.q(:A, $$select public.e2e_upload_signatures('{"@00000000-0000-0000-0000-00000000000a:amigo.world":{"AAA3":{"signatures":{"@00000000-0000-0000-0000-00000000000a:amigo.world":{"ed25519:SSA":"ssig-dev"}}}}}')::text$$);
select pg_temp.check('backup: the server gets the device''s public keys and the hash of exactly those',
  pg_temp.q(:A, $$select (m ->> 'user') || '|' || (m -> 'device_keys' ->> 'device_id') || '|' || (m -> 'self_signing' -> 'keys' ->> 'ed25519:SSA') || '|' || (m ->> 'hash')
                   from public.e2e_proof_material('test-server-secret', 'AAA3') m$$)
  = '@00000000-0000-0000-0000-00000000000a:amigo.world|AAA3|SSA|' || public.e2e_proof_hash(:A, 'AAA3'));
select pg_temp.must_fail('backup: the key hash is internal', :A, $$select public.e2e_proof_hash('00000000-0000-0000-0000-00000000000a', 'AAA3')$$, '42501');
select pg_temp.must_fail('backup: a made-up challenge is refused', :A, pg_temp.create_sql('AAA3', repeat('0', 64), public.e2e_proof_hash(:A, 'AAA3'), 'PUB'), 'DM016');
select pg_temp.q(:A, $$select public.e2e_upload_keys('AAA4', '{"user_id":"@00000000-0000-0000-0000-00000000000a:amigo.world","device_id":"AAA4","keys":{"ed25519:AAA4":"edA4","curve25519:AAA4":"cvA4"},"signatures":{}}', null, null)::text$$);
select pg_temp.must_fail('backup: a challenge issued to another of your devices is refused', :A,
  pg_temp.create_sql('AAA3', pg_temp.challenge(:A, 'AAA4'), public.e2e_proof_hash(:A, 'AAA3'), 'PUB'), 'DM016');
insert into dm_t values ('n1', pg_temp.challenge(:A, 'AAA3'));
select pg_temp.must_fail('backup: refused if the keys changed after the server checked them', :A,
  pg_temp.create_sql('AAA3', (select v from dm_t where k = 'n1'), 'stale-hash', 'PUB'), 'DM015');
select pg_temp.must_fail('backup must use the megolm backup algorithm', :A,
  format($$select public.e2e_backup_create_verified('test-server-secret', 'AAA3', %L, %L, 'plaintext', '{"public_key":"PUB"}')$$,
         pg_temp.challenge(:A, 'AAA3'), public.e2e_proof_hash(:A, 'AAA3')), 'DM011');
insert into dm_t values ('bv', pg_temp.q(:A, pg_temp.create_sql('AAA3', (select v from dm_t where k = 'n1'), public.e2e_proof_hash(:A, 'AAA3'), 'PUB')));
select pg_temp.check('backup: created with a valid challenge (a refused attempt didn''t use it up)', (select v from dm_t where k = 'bv') is not null);
select pg_temp.must_fail('backup: a challenge works once (no replays)', :A,
  pg_temp.create_sql('AAA3', (select v from dm_t where k = 'n1'), public.e2e_proof_hash(:A, 'AAA3'), 'PUB'), 'DM016');
insert into dm_t values ('n2', pg_temp.challenge(:A, 'AAA3'));
update public.e2e_proof_challenges set expires_at = now() - interval '1 second' where nonce = (select v from dm_t where k = 'n2');
select pg_temp.must_fail('backup: an expired challenge is refused', :A,
  pg_temp.put_sql('AAA3', (select v from dm_t where k = 'n2'), public.e2e_proof_hash(:A, 'AAA3'), (select v from dm_t where k = 'bv'), '{}'), 'DM016');
select pg_temp.must_fail('backup: another person can''t write as your device', :B,
  pg_temp.put_sql('AAA3', pg_temp.challenge(:A, 'AAA3'), public.e2e_proof_hash(:A, 'AAA3'), (select v from dm_t where k = 'bv'), '{}'), 'DM012');
select pg_temp.must_fail('backed-up keys must be encrypted (no plaintext session key)', :A,
  pg_temp.put_sql('AAA3', pg_temp.challenge(:A, 'AAA3'), public.e2e_proof_hash(:A, 'AAA3'), (select v from dm_t where k = 'bv'),
    '{"!r:amigo.world":{"sessions":{"s1":{"first_message_index":0,"session_data":{"ciphertext":"c","ephemeral":"e","mac":"m","session_key":"PLAINTEXT"}}}}}'), 'DM011');
select pg_temp.q(:A, pg_temp.put_sql('AAA3', pg_temp.challenge(:A, 'AAA3'), public.e2e_proof_hash(:A, 'AAA3'), (select v from dm_t where k = 'bv'), pg_temp.room('c9', 9, true)));
select pg_temp.q(:A, pg_temp.put_sql('AAA3', pg_temp.challenge(:A, 'AAA3'), public.e2e_proof_hash(:A, 'AAA3'), (select v from dm_t where k = 'bv'), pg_temp.room('c5', 5, true)));
select pg_temp.q(:A, pg_temp.put_sql('AAA3', pg_temp.challenge(:A, 'AAA3'), public.e2e_proof_hash(:A, 'AAA3'), (select v from dm_t where k = 'bv'), pg_temp.room('c7', 7, true)));
select pg_temp.check('backup keeps the better copy of a key', (select session_data ->> 'ciphertext' = 'c5' from public.e2e_backup_keys where session_id = 's1'));
select pg_temp.check('the copy it replaced is archived (a worse copy archives nothing)',
  (select string_agg(session_data ->> 'ciphertext', ',') = 'c9' and bool_and(replaced_by_device = 'AAA3') from public.e2e_backup_keys_replaced where session_id = 's1'));
select pg_temp.check('owner restores their encrypted keys',
  pg_temp.q(:A, format($$select public.e2e_backup_get(%L) #>> '{!r:amigo.world,sessions,s1,session_data,ciphertext}'$$, (select v from dm_t where k = 'bv'))) = 'c5');
select pg_temp.check('nobody else can fetch someone''s backup (not even admins)',
  pg_temp.q(:B, format($$select public.e2e_backup_get(%L)::text$$, (select v from dm_t where k = 'bv'))) = '{}'
  and pg_temp.q(:D, format($$select public.e2e_backup_get(%L)::text$$, (select v from dm_t where k = 'bv'))) = '{}'
  and pg_temp.q(:D, $$select coalesce(public.e2e_backup_current()::text, 'none')$$) = 'none'
  and pg_temp.q(:B, $$select public.e2e_backup_versions()::text$$) = '[]');
select pg_temp.must_fail('backup tables not directly readable', :D, $$select count(*) from public.e2e_backup_keys$$, '42501');
select pg_temp.must_fail('replaced-key archive not directly readable', :A, $$select count(*) from public.e2e_backup_keys_replaced$$, '42501');
select pg_temp.must_fail('challenges not directly readable', :A, $$select count(*) from public.e2e_proof_challenges$$, '42501');
select pg_temp.must_fail('backups cannot be deleted by signed-in people', :A, $$select public.e2e_backup_delete()$$, '42501');
insert into dm_t values ('bv2', pg_temp.q(:A, pg_temp.create_sql('AAA3', pg_temp.challenge(:A, 'AAA3'), public.e2e_proof_hash(:A, 'AAA3'), 'PUB2')));
select pg_temp.must_fail('writing to a replaced backup version is refused', :A,
  pg_temp.put_sql('AAA3', pg_temp.challenge(:A, 'AAA3'), public.e2e_proof_hash(:A, 'AAA3'), (select v from dm_t where k = 'bv'), '{}'), 'DM010');
select pg_temp.check('a new backup becomes current', pg_temp.q(:A, $$select public.e2e_backup_current() ->> 'version'$$) = (select v from dm_t where k = 'bv2'));
select pg_temp.check('the old backup and its keys are kept, listed (superseded) and restorable by the owner',
  pg_temp.q(:A, $$select string_agg((v ->> 'auth_data')::jsonb ->> 'public_key' || ':' || (v ->> 'superseded_at' is not null) || ':' || (v ->> 'count'), ',')
                  from jsonb_array_elements(public.e2e_backup_versions()) v$$) = 'PUB2:false:0,PUB:true:1'
  and pg_temp.q(:A, format($$select public.e2e_backup_get(%L) #>> '{!r:amigo.world,sessions,s1,session_data,ciphertext}'$$, (select v from dm_t where k = 'bv'))) = 'c5');

-- Identity: the same keys can be uploaded again (an interrupted setup finishing); a different
-- key needs the verified route (fresh sign-in, checked by api/e2e-identity.ts).
select pg_temp.q(:A, $$select public.e2e_upload_signing_keys(
  '{"user_id":"@00000000-0000-0000-0000-00000000000a:amigo.world","usage":["master"],"keys":{"ed25519:MKA":"MKA"},"signatures":{}}',
  '{"user_id":"@00000000-0000-0000-0000-00000000000a:amigo.world","usage":["self_signing"],"keys":{"ed25519:SSA":"SSA"},"signatures":{}}', null)::text$$);
select pg_temp.check('identity: uploading the same keys again still works', (select count(*) = 3 from public.e2e_cross_signing_keys where user_id = :A));
select pg_temp.must_fail('identity: a different master key can''t be uploaded directly', :A, $$select public.e2e_upload_signing_keys(
  '{"user_id":"@00000000-0000-0000-0000-00000000000a:amigo.world","usage":["master"],"keys":{"ed25519:MK-EVIL":"MK-EVIL"},"signatures":{}}', null, null)$$, 'DM014');
select pg_temp.must_fail('identity: nor a different self-signing key', :A, $$select public.e2e_upload_signing_keys(null,
  '{"user_id":"@00000000-0000-0000-0000-00000000000a:amigo.world","usage":["self_signing"],"keys":{"ed25519:SS-EVIL":"SS-EVIL"},"signatures":{}}', null)$$, 'DM014');
select pg_temp.must_fail('identity: replacing needs the server secret', :A, $$select public.e2e_replace_identity(null, '00000000-0000-0000-0000-00000000000a', 'AAA3',
  '{"user_id":"@00000000-0000-0000-0000-00000000000a:amigo.world","usage":["master"],"keys":{"ed25519:MKA2":"MKA2"}}',
  '{"user_id":"@00000000-0000-0000-0000-00000000000a:amigo.world","usage":["self_signing"],"keys":{"ed25519:SSA2":"SSA2"}}', null)$$, '42501');
select pg_temp.must_fail('identity: the freshly signed-in session must be the token''s own user', :A, $$select public.e2e_replace_identity('test-server-secret', '00000000-0000-0000-0000-00000000000b', 'AAA3',
  '{"user_id":"@00000000-0000-0000-0000-00000000000a:amigo.world","usage":["master"],"keys":{"ed25519:MKA2":"MKA2"}}',
  '{"user_id":"@00000000-0000-0000-0000-00000000000a:amigo.world","usage":["self_signing"],"keys":{"ed25519:SSA2":"SSA2"}}', null)$$, '42501');
select pg_temp.q(:A, $$select public.e2e_replace_identity('test-server-secret', '00000000-0000-0000-0000-00000000000a', 'AAA3',
  '{"user_id":"@00000000-0000-0000-0000-00000000000a:amigo.world","usage":["master"],"keys":{"ed25519:MKA2":"MKA2"}}',
  '{"user_id":"@00000000-0000-0000-0000-00000000000a:amigo.world","usage":["self_signing"],"keys":{"ed25519:SSA2":"SSA2"}}', null)::text$$);
select pg_temp.check('identity: replaced through the verified route, recorded for the owner only',
  (select key -> 'keys' ? 'ed25519:SSA2' from public.e2e_cross_signing_keys where user_id = :A and key_type = 'self_signing')
  and pg_temp.q(:A, $$select (e ->> 'kind') || ':' || (e ->> 'device_id') from jsonb_array_elements(public.e2e_my_security_events()) e limit 1$$) = 'identity_reset:AAA3'
  and pg_temp.q(:B, $$select public.e2e_my_security_events()::text$$) = '[]'
  and (select old_master = 'ed25519:MKA' and new_master = 'ed25519:MKA2' from public.e2e_security_events where user_id = :A));
select pg_temp.must_fail('security events not directly readable', :A, $$select count(*) from public.e2e_security_events$$, '42501');
select pg_temp.must_fail('backup: a device approved under the old identity is no longer trusted', :A,
  pg_temp.put_sql('AAA3', pg_temp.challenge(:A, 'AAA3'), public.e2e_proof_hash(:A, 'AAA3'), (select v from dm_t where k = 'bv2'), '{}'), 'DM012');
select pg_temp.check('identity: existing backups are untouched by a reset', (select count(*) = 2 from public.e2e_backup_versions where user_id = :A));

-- Edits and reactions: labelled by the sender ('edit' | 'reaction'), content still encrypted.
-- Edits only by the message's sender, within 15 minutes of server time; reactions at any age;
-- no label (an app from before labels) is treated as a possible edit.
create function pg_temp.annotate(p_uid uuid, p_id text, p_device text, p_target text, p_kind text) returns text language sql as $$
  select pg_temp.q(p_uid, format($f$select id::text from public.dm_send_v3(%L, %L, %L, '{"algorithm":"m.megolm.v1.aes-sha2","ciphertext":"x","session_id":"s"}', %L, %L)$f$,
    p_id, (select v from dm_t where k = 'conv'), p_device, p_target, p_kind)) $$;
insert into dm_t values ('m1', pg_temp.q(:A, format($$select id::text from public.dm_send_v3('00000000-0000-0000-0000-0000000000e1', %L, 'AAA3', '{"algorithm":"m.megolm.v1.aes-sha2","ciphertext":"orig","session_id":"s"}')$$, (select v from dm_t where k = 'conv'))));
select pg_temp.annotate(:A, '00000000-0000-0000-0000-0000000000e2', 'AAA3', (select v from dm_t where k = 'm1'), 'edit');
select pg_temp.annotate(:B, '00000000-0000-0000-0000-0000000000f1', 'BBBDEV', (select v from dm_t where k = 'm1'), 'reaction');
select pg_temp.check('edit within 15 minutes accepted; a reaction too; both labelled',
  (select string_agg(relates_kind, ',' order by relates_kind) = 'edit,reaction' from public.dm_messages where relates_to = (select v::uuid from dm_t where k = 'm1')));
select pg_temp.check('receivers get the label with each row',
  pg_temp.q(:B, format($$select string_agg(m ->> 'relates_kind', ',' order by m ->> 'relates_kind') from jsonb_array_elements(public.dm_thread(%L) -> 'messages') m where m ->> 'relates_to' is not null$$,
    (select v from dm_t where k = 'conv'))) = 'edit,reaction');
select pg_temp.must_fail('only the sender can edit a message', :B,
  format($$select * from public.dm_send_v3('00000000-0000-0000-0000-0000000000f2', %L, 'BBBDEV', '{"algorithm":"m.megolm.v1.aes-sha2","ciphertext":"x","session_id":"s"}', %L, 'edit')$$,
    (select v from dm_t where k = 'conv'), (select v from dm_t where k = 'm1')), 'DM006');
select pg_temp.must_fail('an unknown label is refused', :A,
  format($$select * from public.dm_send_v3('00000000-0000-0000-0000-0000000000e9', %L, 'AAA3', '{"algorithm":"m.megolm.v1.aes-sha2","ciphertext":"x","session_id":"s"}', %L, 'delete')$$,
    (select v from dm_t where k = 'conv'), (select v from dm_t where k = 'm1')), 'DM005');
select pg_temp.must_fail('a label needs a message to relate to', :A,
  format($$select * from public.dm_send_v3('00000000-0000-0000-0000-0000000000e8', %L, 'AAA3', '{"algorithm":"m.megolm.v1.aes-sha2","ciphertext":"x","session_id":"s"}', null, 'reaction')$$,
    (select v from dm_t where k = 'conv')), 'DM005');
update public.dm_messages set created_at = now() - interval '16 minutes' where id = (select v::uuid from dm_t where k = 'm1');
select pg_temp.must_fail('a late edit is refused by the server', :A,
  format($$select * from public.dm_send_v3('00000000-0000-0000-0000-0000000000e3', %L, 'AAA3', '{"algorithm":"m.megolm.v1.aes-sha2","ciphertext":"late","session_id":"s"}', %L, 'edit')$$,
    (select v from dm_t where k = 'conv'), (select v from dm_t where k = 'm1')), 'DM013');
select pg_temp.must_fail('an unlabelled late change to your own message (older app) is refused: it may be an edit', :A,
  format($$select * from public.dm_send_v3('00000000-0000-0000-0000-0000000000e4', %L, 'AAA3', '{"algorithm":"m.megolm.v1.aes-sha2","ciphertext":"late","session_id":"s"}', %L)$$,
    (select v from dm_t where k = 'conv'), (select v from dm_t where k = 'm1')), 'DM013');
select pg_temp.annotate(:A, '00000000-0000-0000-0000-0000000000e5', 'AAA3', (select v from dm_t where k = 'm1'), 'reaction');
select pg_temp.annotate(:A, '00000000-0000-0000-0000-0000000000e6', 'AAA3', (select v from dm_t where k = 'm1'), 'reaction');
select pg_temp.check('reacting to and un-reacting from your own old message works', (select count(*) = 2 from public.dm_messages where id in ('00000000-0000-0000-0000-0000000000e5', '00000000-0000-0000-0000-0000000000e6')));
select pg_temp.annotate(:B, '00000000-0000-0000-0000-0000000000f3', 'BBBDEV', (select v from dm_t where k = 'm1'), 'reaction');
select pg_temp.annotate(:B, '00000000-0000-0000-0000-0000000000f4', 'BBBDEV', (select v from dm_t where k = 'm1'), null);
select pg_temp.check('the other person can react to an old message (labelled, or from an older app)',
  (select count(*) = 2 from public.dm_messages where id in ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000f4')));
select pg_temp.check('a retry of an edit accepted in time still answers (idempotent)',
  pg_temp.annotate(:A, '00000000-0000-0000-0000-0000000000e2', 'AAA3', (select v from dm_t where k = 'm1'), 'edit') = '00000000-0000-0000-0000-0000000000e2');
delete from public.dm_messages where id = (select v::uuid from dm_t where k = 'm1');

-- Media cleanup queue: only the server (with the secret); items are leased, and leave the queue
-- only when the caller confirms the file is gone.
-- (Earlier tests may have queued files already; the server takes up to 20 at a time.)
select pg_temp.check('cleanup queue: test starts with a small queue', (select count(*) <= 18 from public.media_cleanup_queue where bucket = 'r2'));
insert into public.media_cleanup_queue (bucket, path, reason) values ('r2', 'u/x/one', 'test'), ('r2', 'u/x/two', 'test');
select pg_temp.must_fail('cleanup queue: a signed-in person without the secret is refused', :A, $$select count(*) from public.media_cleanup_take(null, 5)$$, '42501');
select pg_temp.must_fail('cleanup queue: a wrong secret is refused', :A, $$select count(*) from public.media_cleanup_take('guess', 5)$$, '42501');
select pg_temp.must_fail('cleanup queue: signed out is refused', null, $$select count(*) from public.media_cleanup_take('test-server-secret', 5)$$, '42501');
select pg_temp.must_fail('cleanup queue: the old secret-less function is gone', :A, $$select count(*) from public.media_cleanup_take(5)$$, '42883');
select pg_temp.must_fail('cleanup queue: confirming needs the secret too', :A, $$select public.media_cleanup_done(null, '[]')$$, '42501');
create temp table lease as select * from public.media_cleanup_take('test-server-secret', 20) where item_path like 'u/x/%';
select pg_temp.check('cleanup queue: the server leases queued files', (select count(*) = 2 from lease));
select pg_temp.check('cleanup queue: leased files stay queued until confirmed', (select count(*) = 2 from public.media_cleanup_queue where reason = 'test' and claim_token is not null and attempts = 1));
select pg_temp.check('cleanup queue: a second worker doesn''t get files already leased',
  pg_temp.q(:A, $$select count(*) from public.media_cleanup_take('test-server-secret', 20) where item_path like 'u/x/%'$$)::int = 0);
select pg_temp.check('cleanup queue: a wrong lease can''t confirm anything',
  pg_temp.q(:A, format($$select public.media_cleanup_done('test-server-secret', %L)$$, (select json_agg(json_build_object('id', item_id, 'claim', gen_random_uuid())) from lease)::text))::int = 0);
select pg_temp.check('cleanup queue: confirming one file removes just that one',
  pg_temp.q(:A, format($$select public.media_cleanup_done('test-server-secret', %L)$$, (select json_agg(json_build_object('id', item_id, 'claim', claim)) from lease where item_path = 'u/x/one')::text))::int = 1);
select pg_temp.check('cleanup queue: the unconfirmed file (its delete failed) is still queued', (select count(*) = 1 from public.media_cleanup_queue where path = 'u/x/two'));
update public.media_cleanup_queue set claimed_at = now() - interval '11 minutes' where path = 'u/x/two';
select pg_temp.check('cleanup queue: after the lease runs out it is retried',
  pg_temp.q(:A, $$select string_agg(item_path, ',') from public.media_cleanup_take('test-server-secret', 20) where item_path like 'u/x/%'$$) = 'u/x/two');
select pg_temp.check('cleanup queue: …counting the attempt', (select attempts = 2 from public.media_cleanup_queue where path = 'u/x/two'));
update public.media_cleanup_queue set claimed_at = null, attempts = 10 where path = 'u/x/two';
select pg_temp.check('cleanup queue: after 10 attempts it is left for a person to look at',
  pg_temp.q(:A, $$select count(*) from public.media_cleanup_take('test-server-secret', 20) where item_path like 'u/x/%'$$)::int = 0
  and exists (select 1 from public.media_cleanup_queue where path = 'u/x/two'));
delete from public.media_cleanup_queue where reason = 'test';
delete from public.push_server;

-- Media release (20261028120000): deleted posts, takedowns kept for review, unsend, expired
-- Moments, old 'moment-media' rows, unused uploads, and the daily clean-up's own role.
create temp table mr (k text primary key, v text);
create function pg_temp.mr_file(p_key text, p_owner uuid, p_purpose text, p_status text default 'attached', p_conv uuid default null, p_age interval default '0') returns text language sql as $$
  insert into public.media_objects (path, owner_id, purpose, conversation_id, mime, byte_size, status, created_at)
  values (p_owner || '/' || p_purpose || '/' || coalesce(p_conv || '/', '') || md5(p_key) || case when p_purpose = 'dm' then '.bin' else '.jpg' end,
          p_owner, p_purpose, p_conv, case when p_purpose = 'dm' then 'application/octet-stream' else 'image/jpeg' end, 100, p_status, now() - p_age)
  returning path $$;
create function pg_temp.mr_post(p_key text, p_author uuid) returns uuid language plpgsql as $$
declare id uuid; f text;
begin
  insert into public.posts (author_id, body) values (p_author, 'media release ' || p_key) returning posts.id into id;
  f := pg_temp.mr_file(p_key, p_author, 'post');
  insert into public.post_media (post_id, owner_id, kind, storage_path, mime_type) values (id, p_author, 'image', f, 'image/jpeg');
  insert into mr values (p_key, id::text), (p_key || ':file', f);
  return id;
end $$;
create function pg_temp.queued(p_path text) returns bigint language sql as $$
  select count(*) from public.media_cleanup_queue where bucket = 'r2' and path = p_path $$;
create function pg_temp.mrv(p_key text) returns text language sql as $$ select v from mr where k = p_key $$;
-- Runs p_sql as the daily clean-up's role; returns the result, or the error code.
create function pg_temp.as_janitor(p_sql text) returns text language plpgsql as $$
declare r text;
begin
  perform set_config('role', 'media_janitor', true);
  begin
    execute p_sql into r;
  exception when others then r := 'ERR:' || sqlstate;
  end;
  perform pg_temp.act_as_admin();
  return r;
end $$;

-- Deleted posts
select pg_temp.mr_post('p1', :A);
insert into public.media_objects (path, owner_id, purpose, mime, byte_size, status, variant_of)
values (regexp_replace(pg_temp.mrv('p1:file'), '\.jpg$', '-sm.jpg'), :A, 'post', 'image/jpeg', 50, 'attached', pg_temp.mrv('p1:file'));
select pg_temp.q(:A, format('select public.delete_post(%L)::text', pg_temp.mrv('p1')));
select pg_temp.check('deleting a post releases its photo and its smaller copy (both queued once)',
  pg_temp.queued(pg_temp.mrv('p1:file')) = 1 and pg_temp.queued(regexp_replace(pg_temp.mrv('p1:file'), '\.jpg$', '-sm.jpg')) = 1
  and not exists (select 1 from public.media_objects where path like left(pg_temp.mrv('p1:file'), -4) || '%'));
select pg_temp.must_fail('deleting it again is refused (nothing queued twice)', :A, format('select public.delete_post(%L)', pg_temp.mrv('p1')), 'P0002');
select pg_temp.check('…still queued once', pg_temp.queued(pg_temp.mrv('p1:file')) = 1);
select pg_temp.mr_post('p2', :A);
select pg_temp.must_fail('someone else can''t delete your post', :B, format('select public.delete_post(%L)', pg_temp.mrv('p2')), 'P0002');
select pg_temp.check('…and its photo stays', pg_temp.queued(pg_temp.mrv('p2:file')) = 0 and exists (select 1 from public.media_objects where path = pg_temp.mrv('p2:file')));

-- Admin takedowns: kept for review, then released
select pg_temp.mr_post('p3', :A);
select pg_temp.q(:D, format('select public.admin_remove_post(%L, ''test'')::text', pg_temp.mrv('p3')));
select pg_temp.check('a takedown keeps the photo and records when',
  pg_temp.queued(pg_temp.mrv('p3:file')) = 0 and exists (select 1 from public.media_objects where path = pg_temp.mrv('p3:file'))
  and (select taken_down_at is not null and deleted_at is not null from public.posts where id = pg_temp.mrv('p3')::uuid));
select pg_temp.check('admins can see a taken-down photo; other people can''t',
  pg_temp.q(:D, format('select public.media_can_read(%L)::text', pg_temp.mrv('p3:file'))) = 'true'
  and pg_temp.q(:B, format('select public.media_can_read(%L)::text', pg_temp.mrv('p3:file'))) = 'false');
select pg_temp.check('an author-deleted post''s photo isn''t readable by admins (it''s gone)',
  pg_temp.q(:D, format('select public.media_can_read(%L)::text', pg_temp.mrv('p1:file'))) = 'false');
select public.media_release_due(50);
select pg_temp.check('within the retention period nothing is released', pg_temp.queued(pg_temp.mrv('p3:file')) = 0);
update public.posts set taken_down_at = now() - public.media_takedown_retention() - interval '1 day' where id = pg_temp.mrv('p3')::uuid;
insert into public.content_reports (reporter_id, target_type, target_id, reason) values (:B, 'post', pg_temp.mrv('p3')::uuid, 'spam');
select public.media_release_due(50);
select pg_temp.check('past retention, an open report keeps it', pg_temp.queued(pg_temp.mrv('p3:file')) = 0);
update public.content_reports set status = 'reviewed' where target_id = pg_temp.mrv('p3')::uuid;
select pg_temp.must_fail('only admins can hold removed media', :B, format('select public.admin_set_removed_media_hold(%L, ''appeal'')', pg_temp.mrv('p3')), '42501');
select pg_temp.must_fail('…and only on a taken-down post', :D, format('select public.admin_set_removed_media_hold(%L, ''appeal'')', pg_temp.mrv('p2')), 'SP005');
select pg_temp.q(:D, format('select public.admin_set_removed_media_hold(%L, ''appeal in progress'')::text', pg_temp.mrv('p3')));
select public.media_release_due(50);
select pg_temp.check('a hold keeps it past retention', pg_temp.queued(pg_temp.mrv('p3:file')) = 0);
select pg_temp.q(:D, format('select public.admin_set_removed_media_hold(%L, '''')::text', pg_temp.mrv('p3')));
select pg_temp.check('placing and lifting a hold are both audit-logged',
  (select count(*) = 2 from public.admin_audit_log where target_id = pg_temp.mrv('p3')::uuid and action in ('post.media_hold', 'post.media_hold_released')));
select public.media_release_due(50);
select pg_temp.check('with no hold and no open report, it''s released after retention', pg_temp.queued(pg_temp.mrv('p3:file')) = 1);

-- Unsend
insert into mr values ('conv2', pg_temp.q(:A, $$select public.dm_open('00000000-0000-0000-0000-00000000000c')$$));
insert into mr values
  ('fa', pg_temp.mr_file('fa', :A, 'dm', 'pending', (select v::uuid from dm_t where k = 'conv'))),
  ('fb', pg_temp.mr_file('fb', :B, 'dm', 'pending', (select v::uuid from dm_t where k = 'conv'))),
  ('fc', pg_temp.mr_file('fc', :A, 'dm', 'pending', pg_temp.mrv('conv2')::uuid));
insert into mr values ('m5', pg_temp.q(:A, format($$select id::text from public.dm_send_v3('00000000-0000-0000-0000-0000000005a1', %L, 'AAA3', '{"algorithm":"m.megolm.v1.aes-sha2","ciphertext":"x","session_id":"s"}')$$, (select v from dm_t where k = 'conv'))));
select pg_temp.must_fail('someone else can''t unsend your message (nothing released)', :B,
  format('select public.dm_unsend(%L, %L)', pg_temp.mrv('m5'), array[pg_temp.mrv('fa')]), 'DM006');
select pg_temp.check('…the photo is still there', pg_temp.queued(pg_temp.mrv('fa')) = 0);
select pg_temp.q(:A, format('select public.dm_unsend(%L, %L)::text', pg_temp.mrv('m5'), array[pg_temp.mrv('fa'), pg_temp.mrv('fb'), pg_temp.mrv('fc'), 'not/a/file.bin']));
select pg_temp.check('unsend releases only your own photo in that conversation',
  pg_temp.queued(pg_temp.mrv('fa')) = 1 and pg_temp.queued(pg_temp.mrv('fb')) = 0 and pg_temp.queued(pg_temp.mrv('fc')) = 0
  and exists (select 1 from public.media_objects where path = pg_temp.mrv('fb')) and exists (select 1 from public.media_objects where path = pg_temp.mrv('fc')));
insert into mr values ('m6', pg_temp.q(:A, format($$select id::text from public.dm_send_v3('00000000-0000-0000-0000-0000000005a2', %L, 'AAA3', '{"algorithm":"m.megolm.v1.aes-sha2","ciphertext":"x","session_id":"s"}')$$, (select v from dm_t where k = 'conv'))));
select pg_temp.q(:A, format('select public.dm_unsend(%L)::text', pg_temp.mrv('m6')));
select pg_temp.check('an older app''s unsend (no photo list) still works', not exists (select 1 from public.dm_messages where id = pg_temp.mrv('m6')::uuid));
insert into mr select 'many' || g, pg_temp.mr_file('many' || g, :A, 'dm', 'pending', (select v::uuid from dm_t where k = 'conv')) from generate_series(1, 11) g;
insert into mr values ('m7', pg_temp.q(:A, format($$select id::text from public.dm_send_v3('00000000-0000-0000-0000-0000000005a3', %L, 'AAA3', '{"algorithm":"m.megolm.v1.aes-sha2","ciphertext":"x","session_id":"s"}')$$, (select v from dm_t where k = 'conv'))));
select pg_temp.q(:A, format('select public.dm_unsend(%L, %L)::text', pg_temp.mrv('m7'), (select array_agg(v order by k) from mr where k like 'many%')));
select pg_temp.check('at most 10 photos per unsend', (select count(*) = 10 from mr where k like 'many%' and pg_temp.queued(v) = 1));

-- Expired Moments and old 'moment-media' rows
insert into mr values ('mo', pg_temp.mr_file('mo', :B, 'moment'));
insert into public.moments (author_id, media_path, created_at, expires_at) values (:B, pg_temp.mrv('mo'), now() - interval '26 hours', now() - interval '2 hours');
select pg_temp.check('an expired Moment''s photo is queued once, as r2, and no moment-media row is written',
  pg_temp.queued(pg_temp.mrv('mo')) = 1 and not exists (select 1 from public.media_cleanup_queue where bucket = 'moment-media' and path = pg_temp.mrv('mo')));
insert into mr values ('kept', pg_temp.mr_file('kept', :B, 'moment'));
insert into public.media_cleanup_queue (bucket, path, reason) values
  ('moment-media', :B || '/moment/' || md5('legacy-unused') || '.jpg', 'moment expired'),
  ('moment-media', pg_temp.mrv('kept'), 'moment expired'),
  ('moment-media', 'some/other/legacy.jpg', 'moment expired');
insert into mr values ('legacy', (select public.media_requeue_legacy_moment_media()::text));
select pg_temp.check('requeue moves only R2 Moment keys no longer in use; leaves the rest',
  pg_temp.queued(:B || '/moment/' || md5('legacy-unused') || '.jpg') = 1
  and exists (select 1 from public.media_cleanup_queue where bucket = 'moment-media' and path = pg_temp.mrv('kept'))
  and exists (select 1 from public.media_cleanup_queue where bucket = 'moment-media' and path = 'some/other/legacy.jpg')
  and (pg_temp.mrv('legacy')::jsonb ->> 'moved')::int = 1);

-- Unused uploads
insert into mr values
  ('stale', pg_temp.mr_file('stale', :C, 'post', 'pending', null, '2 days')),
  ('fresh', pg_temp.mr_file('fresh', :C, 'post', 'pending', null, '1 hour')),
  ('olddm', pg_temp.mr_file('olddm', :A, 'dm', 'pending', (select v::uuid from dm_t where k = 'conv'), '2 days')),
  ('oldused', pg_temp.mr_file('oldused', :C, 'avatar', 'attached', null, '2 days'));
select public.media_release_due(50);
select pg_temp.check('unused uploads over a day old are released for anyone; fresh, message and attached files stay',
  pg_temp.queued(pg_temp.mrv('stale')) = 1 and pg_temp.queued(pg_temp.mrv('fresh')) = 0
  and pg_temp.queued(pg_temp.mrv('olddm')) = 0 and pg_temp.queued(pg_temp.mrv('oldused')) = 0);

-- The daily clean-up's role, and sharing leases with the upload route
select pg_temp.check('the clean-up role can release what''s due', pg_temp.as_janitor('select public.media_janitor_release()::text') like '{%');
select pg_temp.check('…but can''t read the queue or the registry',
  pg_temp.as_janitor('select count(*)::text from public.media_cleanup_queue') = 'ERR:42501'
  and pg_temp.as_janitor('select count(*)::text from public.media_objects') = 'ERR:42501');
select pg_temp.check('…nor call the internal functions or anything else',
  pg_temp.as_janitor('select count(*)::text from public.media_cleanup_lease(5)') = 'ERR:42501'
  and pg_temp.as_janitor('select public.media_release_due(5)::text') = 'ERR:42501'
  and pg_temp.as_janitor($$select public.delete_post('00000000-0000-0000-0000-000000000000')::text$$) = 'ERR:42501'
  and pg_temp.as_janitor('select public.media_requeue_legacy_moment_media()::text') = 'ERR:42501');
select pg_temp.must_fail('signed-in people can''t run the clean-up', :A, 'select public.media_janitor_take(5)', '42501');
select pg_temp.must_fail('…nor release what''s due', :A, 'select public.media_janitor_release()', '42501');
select pg_temp.must_fail('…nor confirm', :A, $$select public.media_janitor_done('[]')$$, '42501');
select pg_temp.must_fail('signed out: neither', null, 'select public.media_janitor_take(5)', '42501');
select pg_temp.must_fail('the internal release is not callable by users', :D, 'select public.media_release_due(5)', '42501');
select pg_temp.must_fail('…nor the requeue', :D, 'select public.media_requeue_legacy_moment_media()', '42501');
create temp table jl (item_id bigint, item_path text, claim uuid);
insert into jl select * from public.media_janitor_take(20);
select pg_temp.check('the clean-up leases queued files', (select count(*) >= 1 from jl));
insert into public.push_server (key_hash) values (encode(sha256(convert_to('test-server-secret', 'UTF8')), 'hex'))
  on conflict (id) do update set key_hash = excluded.key_hash;
select pg_temp.check('the upload route doesn''t get files the clean-up has leased',
  not exists (select 1 from public.media_cleanup_take('test-server-secret', 20) t join jl on jl.item_id = t.item_id));
select pg_temp.check('a delete that failed (not confirmed) stays queued, then comes back after the lease',
  (select count(*) from public.media_janitor_take(20) t join jl on jl.item_id = t.item_id) = 0);
update public.media_cleanup_queue set claimed_at = now() - interval '11 minutes' where id in (select item_id from jl);
create temp table jl2 as select * from public.media_janitor_take(20);
select pg_temp.check('…counting the attempt', (select count(*) = (select count(*) from jl) from jl2 join jl using (item_id))
  and (select bool_and(q.attempts = 2) from public.media_cleanup_queue q join jl on q.id = jl.item_id));
select pg_temp.check('confirming with the current lease removes them',
  public.media_janitor_done((select jsonb_agg(jsonb_build_object('id', item_id, 'claim', claim)) from (select * from jl2 limit 20) x)) >= 1);
select pg_temp.check('a stale lease confirms nothing',
  public.media_janitor_done((select jsonb_agg(jsonb_build_object('id', item_id, 'claim', claim)) from (select * from jl limit 20) x)) = 0);
delete from public.push_server;

-- Business profiles (20261028130000). A runs a business; B and C are other people; D is an admin.
create temp table bz (k text primary key, v text);
grant all on bz to authenticated, anon;
create function pg_temp.bzv(p_key text) returns text language sql as $$ select v from bz where k = p_key $$;
update auth.users set email_confirmed_at = now() where id in (:A, :C);

-- Off until an admin turns it on
select pg_temp.must_fail('business: off by default', :A, $$select public.create_business('acme_shop', 'Acme Shop', 'retail')$$, 'BZ001');
select pg_temp.must_fail('business: only admins turn it on', :A, $$select public.admin_set_businesses_enabled(true)$$, '42501');
select pg_temp.q(:D, $$select public.admin_set_businesses_enabled(true)::text$$);

-- Eligibility, one each, handle and name rules, rate limit
select pg_temp.must_fail('business: an unverified email can''t create one', :B, $$select public.create_business('bee_shop', 'Bee', 'retail')$$, 'BZ001');
insert into public.account_suspensions (user_id, reason) values (:C, 'test');
select pg_temp.must_fail('business: a suspended account can''t create one', :C, $$select public.create_business('cee_shop', 'Cee', 'retail')$$, 'BZ001');
delete from public.account_suspensions where user_id = :C;
select pg_temp.must_fail('business: reserved handles refused', :A, $$select public.create_business('admin', 'Acme', 'retail')$$, 'BZ002');
select pg_temp.must_fail('business: badly formed handles refused', :A, $$select public.create_business('A!', 'Acme', 'retail')$$, 'BZ002');
select pg_temp.must_fail('business: names can''t claim to be Amigo', :A, $$select public.create_business('acme_shop', 'Official Amigo Store', 'retail')$$, 'BZ003');
select pg_temp.must_fail('business: unknown category refused', :A, $$select public.create_business('acme_shop', 'Acme', 'casino')$$, '22023');
select pg_temp.must_fail('business: website must be https', :A, $$select public.create_business('acme_shop', 'Acme', 'retail', '', 'http://acme.test')$$, '22023');
insert into bz values ('biz', pg_temp.q(:A, $$select public.create_business('Acme_Shop', 'Acme Shop', 'retail', 'Good things', 'https://acme.example.com', 'Hello@Acme.example.com', '+234 801 234 5678')::text$$));
select pg_temp.check('business: a verified person creates one (handle lower-cased, email lower-cased)',
  (select handle = 'acme_shop' and contact_email = 'hello@acme.example.com' and owner_id = :A from public.businesses where id = pg_temp.bzv('biz')::uuid));
select pg_temp.must_fail('business: one per person', :A, $$select public.create_business('acme_two', 'Acme Two', 'retail')$$, 'BZ006');
select pg_temp.must_fail('business: handles are unique', :C, $$select public.create_business('acme_shop', 'Copy', 'retail')$$, 'BZ002');
select pg_temp.check('business: a handle may match a personal username (separate /b/ space)',
  pg_temp.q(:C, format('select public.create_business(%L, %L, %L)::text', (select username from public.profiles where id = :B), 'Leo Things', 'other')) is not null);
select pg_temp.q(:C, $$select public.delete_business()::text$$);
select pg_temp.q(:C, $$select public.create_business('cee_one', 'Cee', 'other')::text$$);
select pg_temp.q(:C, $$select public.delete_business()::text$$);
select pg_temp.q(:C, $$select public.create_business('cee_two', 'Cee', 'other')::text$$);
select pg_temp.q(:C, $$select public.delete_business()::text$$);
select pg_temp.must_fail('business: at most 3 created a day', :C, $$select public.create_business('cee_three', 'Cee', 'other')$$, 'RL001');

-- Editing (owner only), the 30-day handle rule
select pg_temp.q(:A, $$select public.update_business('Acme Shop & Co', 'food_drink', 'Fresh', 'https://acme.example.com', null, null)::text$$);
select pg_temp.check('business: the owner edits it', (select name = 'Acme Shop & Co' and category = 'food_drink' and contact_email is null from public.businesses where id = pg_temp.bzv('biz')::uuid));
select pg_temp.must_fail('business: a handle change within 30 days is refused', :A,
  $$select public.update_business('Acme', 'retail', '', null, null, null, 'acme_new')$$, 'BZ005');
update public.businesses set handle_changed_at = now() - interval '31 days' where id = pg_temp.bzv('biz')::uuid;
select pg_temp.q(:A, $$select public.update_business('Acme', 'retail', '', null, null, null, 'acme_new')::text$$);
select pg_temp.check('business: …and allowed after 30 days', (select handle = 'acme_new' and handle_changed_at > now() - interval '1 minute' from public.businesses where id = pg_temp.bzv('biz')::uuid));
select pg_temp.must_fail('business: someone without one can''t edit', :B, $$select public.update_business('X', 'retail', '', null, null, null)$$, 'BZ004');

-- The owner stays private
select pg_temp.must_fail('privacy: the owner column isn''t readable', :B, $$select owner_id from public.businesses$$, '42501');
select pg_temp.check('privacy: the public columns are', pg_temp.q(:B, $$select handle from public.businesses where handle = 'acme_new'$$) = 'acme_new');
select pg_temp.check('privacy: by handle, not marked as mine for others; mine for the owner',
  pg_temp.q(:B, $$select mine::text from public.business_by_handle('acme_new')$$) = 'false'
  and pg_temp.q(:A, $$select mine::text from public.business_by_handle('ACME_NEW')$$) = 'true');
select pg_temp.check('privacy: my_business answers only the owner, never with owner_id',
  pg_temp.q(:B, $$select (public.my_business() -> 'business')::text$$) = 'null'
  and pg_temp.q(:A, $$select public.my_business() -> 'business' ->> 'handle'$$) = 'acme_new'
  and pg_temp.q(:A, $$select (public.my_business() -> 'business') ? 'owner_id'$$) = 'false');

-- Business posts
insert into bz values ('bp', pg_temp.q(:A, $$select public.create_business_post('Fresh bread today')::text$$));
select pg_temp.check('posts: created with no personal author',
  (select author_id is null and business_id = pg_temp.bzv('biz')::uuid and visibility = 'public' from public.posts where id = pg_temp.bzv('bp')::uuid));
select pg_temp.check('privacy: others see the post with no author and the business attached',
  pg_temp.q(:B, format('select coalesce(author_id::text, %L) || %L || business_id from public.posts where id = %L', 'none', '|', pg_temp.bzv('bp'))) = 'none|' || pg_temp.bzv('biz'));
select pg_temp.must_fail('privacy: post_media.owner_id isn''t readable', :B, $$select owner_id from public.post_media limit 1$$, '42501');
select pg_temp.check('posts: …while the media columns the app uses still are', pg_temp.q(:B, $$select count(storage_path)::text from public.post_media$$) is not null);
select pg_temp.must_fail('posts: someone else can''t post as the business', :B, $$select public.create_business_post('fake')$$, 'BZ004');
select pg_temp.must_fail('posts: no direct insert with a business', :A,
  format($$insert into public.posts (author_id, business_id, body) values ('00000000-0000-0000-0000-00000000000a', %L, 'x')$$, pg_temp.bzv('biz')), '42501');
select pg_temp.must_fail('posts: nor as nobody', :A,
  format($$insert into public.posts (author_id, business_id, body) values (null, %L, 'x')$$, pg_temp.bzv('biz')), '42501');
select pg_temp.check('posts: not on the owner''s personal profile', not exists (select 1 from public.posts where author_id = :A and id = pg_temp.bzv('bp')::uuid));
insert into bz values ('reply', pg_temp.q(:B, format('select id::text from public.create_post(%L, %L)', 'Looks good!', pg_temp.bzv('bp'))));
select pg_temp.q(:B, format('select public.set_post_like(%L, true)::text', pg_temp.bzv('bp')));
select pg_temp.check('posts: replies and likes stay personal and notify nobody',
  (select author_id = :B from public.posts where id = pg_temp.bzv('reply')::uuid)
  and (select like_count = 1 and reply_count = 1 from public.posts where id = pg_temp.bzv('bp')::uuid)
  and not exists (select 1 from public.notifications where post_id in (pg_temp.bzv('bp')::uuid, pg_temp.bzv('reply')::uuid)));
select pg_temp.q(:A, $$select public.create_business_post('post ' || g)::text from generate_series(1, 9) g limit 1$$);
do $$ begin for g in 2..9 loop perform pg_temp.q('00000000-0000-0000-0000-00000000000a', format('select public.create_business_post(%L)::text', 'post ' || g)); end loop; end $$;
select pg_temp.must_fail('posts: at most 10 in 10 minutes per business', :A, $$select public.create_business_post('one too many')$$, 'RL001');

-- Feeds
select pg_temp.check('feed: business posts are in Latest',
  pg_temp.q(:B, format('select count(*)::text from public.feed_posts(%L, 100) where id = %L', 'latest', pg_temp.bzv('bp'))) = '1');
select pg_temp.check('feed: …not in Following before you follow', pg_temp.q(:B, format('select count(*)::text from public.feed_posts(%L, 100) where id = %L', 'following', pg_temp.bzv('bp'))) = '0');

-- Following
select pg_temp.must_fail('follow: not your own business', :A, format('select public.follow_business(%L, true)', pg_temp.bzv('biz')), 'BZ004');
select pg_temp.q(:B, format('select public.follow_business(%L, true)::text', pg_temp.bzv('biz')));
select pg_temp.q(:B, format('select public.follow_business(%L, true)::text', pg_temp.bzv('biz')));
select pg_temp.check('follow: counted once, however often', (select follower_count = 1 from public.businesses where id = pg_temp.bzv('biz')::uuid));
select pg_temp.check('feed: …then in Following', pg_temp.q(:B, format('select count(*)::text from public.feed_posts(%L, 100) where id = %L', 'following', pg_temp.bzv('bp'))) = '1');
select pg_temp.check('follow: listed for the app', pg_temp.q(:B, $$select string_agg(x::text, ',') from public.my_followed_businesses() x$$) = pg_temp.bzv('biz'));
select pg_temp.must_fail('follow: the follow list isn''t readable directly', :A, $$select count(*) from public.business_follows$$, '42501');
select pg_temp.q(:B, format('select public.follow_business(%L, false)::text', pg_temp.bzv('biz')));
select pg_temp.check('follow: unfollow lowers the count', (select follower_count = 0 from public.businesses where id = pg_temp.bzv('biz')::uuid));
insert into public.business_action_log (user_id, action) select :B, 'follow' from generate_series(1, 100);
select pg_temp.must_fail('follow: at most 100 an hour', :B, format('select public.follow_business(%L, true)', pg_temp.bzv('biz')), 'RL001');
delete from public.business_action_log where user_id = :B;
select pg_temp.q(:B, format('select public.follow_business(%L, true)::text', pg_temp.bzv('biz')));

-- Discovery
select pg_temp.check('search: by name, handle and category',
  pg_temp.q(:B, $$select count(*)::text from public.search_businesses('acme')$$) = '1'
  and pg_temp.q(:B, $$select count(*)::text from public.search_businesses('ACME_N')$$) = '1'
  and pg_temp.q(:B, $$select count(*)::text from public.search_businesses('', 'retail')$$) = '1'
  and pg_temp.q(:B, $$select count(*)::text from public.search_businesses('', 'health')$$) = '0'
  and pg_temp.q(:B, $$select following::text from public.search_businesses('acme')$$) = 'true');
select pg_temp.check('search: wildcards in the query are literal', pg_temp.q(:B, $$select count(*)::text from public.search_businesses('%')$$) = '0');

-- Reports and moderation
select pg_temp.q(:B, format('select public.report_content(%L, %L, %L)::text', 'post', pg_temp.bzv('bp'), 'spam'));
select pg_temp.must_fail('report: the owner can''t report their business''s post', :A, format('select public.report_content(%L, %L, %L)', 'post', pg_temp.bzv('bp'), 'spam'), 'RP001');
select pg_temp.q(:B, format('select public.report_content(%L, %L, %L)::text', 'business', pg_temp.bzv('biz'), 'spam'));
select pg_temp.must_fail('report: …nor their own business', :A, format('select public.report_content(%L, %L, %L)', 'business', pg_temp.bzv('biz'), 'spam'), 'RP001');
select pg_temp.check('report: admins see the business post and the business, with who runs it',
  pg_temp.q(:D, format('select target_label || %L || target_author_username from public.admin_content_reports(%L) where target_id = %L', '|', 'open', pg_temp.bzv('bp'))) = 'Business post|' || (select username from public.profiles where id = :A)
  and pg_temp.q(:D, format('select target_label from public.admin_content_reports(%L) where target_id = %L', 'open', pg_temp.bzv('biz'))) = 'Business');
insert into bz values ('bp2', pg_temp.q(:A, $$select id::text from public.posts where business_id is not null and body = 'post 2'$$));
select pg_temp.q(:D, format('select public.admin_remove_post(%L, %L)::text', pg_temp.bzv('bp2'), 'test'));
select pg_temp.check('moderation: admins can take down a business post (audit-logged)',
  (select taken_down_at is not null from public.posts where id = pg_temp.bzv('bp2')::uuid)
  and exists (select 1 from public.admin_audit_log where target_id = pg_temp.bzv('bp2')::uuid and summary like '%/b/acme_new%'));
select pg_temp.must_fail('moderation: only admins suspend', :B, format('select public.admin_set_business_status(%L, true)', pg_temp.bzv('biz')), '42501');
select pg_temp.q(:D, format('select public.admin_set_business_status(%L, true, %L)::text', pg_temp.bzv('biz'), 'test'));
select pg_temp.check('moderation: a suspended business and its posts disappear for others',
  pg_temp.q(:B, $$select count(*)::text from public.business_by_handle('acme_new')$$) = '0'
  and pg_temp.q(:B, format('select count(*)::text from public.posts where id = %L', pg_temp.bzv('bp'))) = '0'
  and pg_temp.q(:B, format('select count(*)::text from public.feed_posts(%L, 100) where id = %L', 'latest', pg_temp.bzv('bp'))) = '0'
  and pg_temp.q(:B, $$select count(*)::text from public.search_businesses('acme')$$) = '0');
select pg_temp.check('moderation: …admins still see it', pg_temp.q(:D, $$select count(*)::text from public.business_by_handle('acme_new')$$) = '1');
select pg_temp.must_fail('moderation: a suspended business can''t be edited', :A, $$select public.update_business('X', 'retail', '', null, null, null)$$, 'BZ007');
select pg_temp.must_fail('moderation: …or deleted by its owner', :A, $$select public.delete_business()$$, 'BZ007');
select pg_temp.must_fail('moderation: …or post', :A, $$select public.create_business_post('x')$$, 'BZ007');
select pg_temp.must_fail('moderation: …or delete its posts', :A, format('select public.delete_post(%L)', pg_temp.bzv('bp')), 'P0002');
select pg_temp.check('moderation: …which stay for review', (select deleted_at is null from public.posts where id = pg_temp.bzv('bp')::uuid));
select pg_temp.q(:D, format('select public.admin_set_business_status(%L, false)::text', pg_temp.bzv('biz')));
select pg_temp.check('moderation: restore brings it back; both actions logged',
  pg_temp.q(:B, $$select count(*)::text from public.business_by_handle('acme_new')$$) = '1'
  and (select count(*) = 2 from public.admin_audit_log where target_id = pg_temp.bzv('biz')::uuid and action in ('business.suspend', 'business.restore')));

-- Media: business keys, logo/cover lifecycle, post photos
insert into bz values ('logo1', pg_temp.q(:A, format($$select public.media_begin_upload('business_logo', 'image/png', 1000, null, %L)$$, pg_temp.bzv('biz'))));
select pg_temp.check('media: business files are named after the business, not the person',
  pg_temp.bzv('logo1') like 'b/' || pg_temp.bzv('biz') || '/business_logo/%' and pg_temp.bzv('logo1') not like '%00000000-0000-0000-0000-00000000000a%');
select pg_temp.must_fail('media: only the owner uploads for a business', :B,
  format($$select public.media_begin_upload('business_logo', 'image/png', 1000, null, %L)$$, pg_temp.bzv('biz')), 'MD001');
select pg_temp.must_fail('media: business purposes need the business', :A, $$select public.media_begin_upload('business_logo', 'image/png', 1000)$$, 'MD001');
select pg_temp.must_fail('media: …and personal ones refuse it', :A,
  format($$select public.media_begin_upload('post', 'image/png', 1000, null, %L)$$, pg_temp.bzv('biz')), 'MD001');
select pg_temp.q(:A, format('select public.set_business_image(%L, %L)::text', 'logo', pg_temp.bzv('logo1')));
select pg_temp.check('media: the logo is set and readable by others',
  (select logo_url = '/api/media/' || pg_temp.bzv('logo1') from public.businesses where id = pg_temp.bzv('biz')::uuid)
  and pg_temp.q(:B, format('select public.media_can_read(%L)::text', pg_temp.bzv('logo1'))) = 'true');
select pg_temp.must_fail('media: someone else''s upload can''t become the logo', :A,
  format('select public.set_business_image(%L, %L)', 'logo', 'b/' || pg_temp.bzv('biz') || '/business_logo/' || md5('x') || '.png'), 'MD001');
insert into bz values ('logo2', pg_temp.q(:A, format($$select public.media_begin_upload('business_logo', 'image/png', 1000, null, %L)$$, pg_temp.bzv('biz'))));
select pg_temp.q(:A, format('select public.set_business_image(%L, %L)::text', 'logo', pg_temp.bzv('logo2')));
select pg_temp.check('media: replacing the logo queues the old file', pg_temp.queued(pg_temp.bzv('logo1')) = 1 and pg_temp.queued(pg_temp.bzv('logo2')) = 0);
insert into bz values ('cover', pg_temp.q(:A, format($$select public.media_begin_upload('business_cover', 'image/jpeg', 1000, null, %L)$$, pg_temp.bzv('biz'))));
select pg_temp.q(:A, format('select public.set_business_image(%L, %L)::text', 'cover', pg_temp.bzv('cover')));
select pg_temp.q(:A, format('select public.set_business_image(%L, null)::text', 'cover'));
select pg_temp.check('media: removing the cover queues it', pg_temp.queued(pg_temp.bzv('cover')) = 1 and (select cover_url is null from public.businesses where id = pg_temp.bzv('biz')::uuid));
insert into bz values ('pf', pg_temp.q(:A, format($$select public.media_begin_upload('business_post', 'image/jpeg', 1000, null, %L)$$, pg_temp.bzv('biz'))));
update public.media_objects set status = 'attached' where path = pg_temp.bzv('pf');
update public.posts set created_at = now() - interval '1 hour' where business_id = pg_temp.bzv('biz')::uuid;
insert into bz values ('bp3', pg_temp.q(:A, format($$select public.create_business_post('with photo', %L)::text$$,
  jsonb_build_array(jsonb_build_object('kind', 'image', 'storage_path', pg_temp.bzv('pf'), 'mime_type', 'image/jpeg', 'width', 10, 'height', 10)))));
select pg_temp.must_fail('media: a business post can''t use a personal or another business''s file', :A,
  format($$select public.create_business_post('x', %L)$$, jsonb_build_array(jsonb_build_object('kind', 'image', 'storage_path',
    '00000000-0000-0000-0000-00000000000a/post/' || md5('p') || '.jpg', 'mime_type', 'image/jpeg'))), 'MD001');
select pg_temp.check('media: a business post''s photo is readable with the post', pg_temp.q(:B, format('select public.media_can_read(%L)::text', pg_temp.bzv('pf'))) = 'true');
select pg_temp.must_fail('posts: someone else can''t delete a business post', :B, format('select public.delete_post(%L)', pg_temp.bzv('bp3')), 'P0002');
select pg_temp.q(:A, format('select public.delete_post(%L)::text', pg_temp.bzv('bp3')));
select pg_temp.check('posts: the owner deletes it; its photo is queued', pg_temp.queued(pg_temp.bzv('pf')) = 1);

-- Deleting the business
select pg_temp.q(:A, $$select public.delete_business()::text$$);
select pg_temp.check('business: deleting it removes its posts and follows, and queues its logo',
  not exists (select 1 from public.businesses where id = pg_temp.bzv('biz')::uuid)
  and not exists (select 1 from public.posts where business_id = pg_temp.bzv('biz')::uuid or id = pg_temp.bzv('bp')::uuid)
  and not exists (select 1 from public.business_follows where business_id = pg_temp.bzv('biz')::uuid)
  and pg_temp.queued(pg_temp.bzv('logo2')) = 1);
select pg_temp.check('grants: nothing new is callable by everyone, nor by signed-out users except the two policy helpers',
  not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and has_function_privilege('public', p.oid, 'execute'))
  and (select count(*) = 2 from pg_proc p where p.pronamespace = 'public'::regnamespace
         and p.proname in ('business_is_active', 'viewer_follows_business', 'create_business', 'my_business', 'business_by_handle', 'search_businesses', 'follow_business', 'create_business_post', 'admin_businesses')
         and has_function_privilege('anon', p.oid, 'execute')));
select pg_temp.q(:D, $$select public.admin_set_businesses_enabled(false)::text$$);

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

-- ----------------------------------------------------------- predictions
-- Admins here: :D, :C (owner). :A and :B are invited to the beta; '...0e' is not.

select pg_temp.act_as_admin();
insert into public.worlds (slug, title, starts_at, ends_at) values
  ('pl-ars-che', 'Arsenal v Chelsea', now() + interval '1 hour', now() + interval '5 hours'),
  ('ucl-rma-bay', 'Real Madrid v Bayern', now() + interval '1 day', now() + interval '1 day 5 hours'),
  ('pl-liv-mun', 'Liverpool v Man Utd', now() + interval '2 days', now() + interval '2 days 5 hours'),
  ('pl-new-tot', 'Newcastle v Spurs', now() + interval '3 days', now() + interval '3 days 5 hours');
insert into t select 'pw1', id from public.worlds where slug = 'pl-ars-che';
insert into t select 'pw2', id from public.worlds where slug = 'ucl-rma-bay';
insert into t select 'pw3', id from public.worlds where slug = 'pl-liv-mun';
insert into t select 'pw4', id from public.worlds where slug = 'pl-new-tot';
create temp table pr_t (k text primary key, v text);
grant all on pr_t to public;

-- Only admins create questions.
select pg_temp.must_fail('anon cannot use predictions', null, $$select public.prediction_today()$$, '42501');
select pg_temp.must_fail('members cannot create questions', :A,
  format($$select public.admin_create_question(%L, 'premier-league', 'Who wins?', array['Arsenal','Draw','Chelsea'], now() + interval '30 minutes')$$, (select id from t where k = 'pw1')), '42501');
select pg_temp.must_fail('tables are closed to clients', :A,
  format($$insert into public.prediction_questions (world_id, competition, drop_date, prompt, options, locks_at) values (%L, 'premier-league', current_date, 'Who wins?', array['a','b'], now() + interval '1 hour')$$, (select id from t where k = 'pw1')), '42501');

insert into t values ('q1', pg_temp.q(:D, format($$select public.admin_create_question(%L, 'premier-league', 'Who wins at the Emirates?',
  array['Arsenal','Draw','Chelsea'], now() + interval '30 minutes', (now() at time zone 'Africa/Lagos')::date)$$, (select id from t where k = 'pw1')))::uuid);
insert into t values ('q2', pg_temp.q(:D, format($$select public.admin_create_question(%L, 'champions-league', 'Who goes through?',
  array['Real Madrid','Bayern'], now() + interval '20 hours', (now() at time zone 'Africa/Lagos')::date, false)$$, (select id from t where k = 'pw2')))::uuid);
insert into t values ('q3', pg_temp.q(:D, format($$select public.admin_create_question(%L, 'premier-league', 'Who wins at Anfield?',
  array['Liverpool','Draw','Man Utd'], now() + interval '40 hours', (now() at time zone 'Africa/Lagos')::date, false)$$, (select id from t where k = 'pw3')))::uuid);
insert into t values ('q4', pg_temp.q(:D, format($$select public.admin_create_question(%L, 'premier-league', 'Who wins at St James''?',
  array['Newcastle','Draw','Spurs'], now() + interval '64 hours', (now() at time zone 'Africa/Lagos')::date, false)$$, (select id from t where k = 'pw4')))::uuid);
select pg_temp.check('admins create questions (locks stored as UTC instants)',
  (select count(*) = 4 from public.prediction_questions)
  and (select locks_at = now() + interval '30 minutes' and drop_date = (now() at time zone 'Africa/Lagos')::date from public.prediction_questions where id = (select id from t where k = 'q1')));

select pg_temp.must_fail('one question per World', :D,
  format($$select public.admin_create_question(%L, 'premier-league', 'Another one?', array['a','b'], now() + interval '1 hour', null, false)$$, (select id from t where k = 'pw1')), 'PR005');
select pg_temp.act_as_admin();
insert into public.worlds (slug, title, starts_at, ends_at) values ('pl-spare', 'Spare', now() + interval '1 hour', now() + interval '5 hours');
insert into t select 'pw5', id from public.worlds where slug = 'pl-spare';
select pg_temp.must_fail('one main Daily Drop per day', :D,
  format($$select public.admin_create_question(%L, 'premier-league', 'Second main?', array['a','b'], now() + interval '1 hour', (now() at time zone 'Africa/Lagos')::date)$$, (select id from t where k = 'pw5')), 'PR005');
select pg_temp.must_fail('only Premier League and Champions League for now', :D,
  format($$select public.admin_create_question(%L, 'npfl', 'Who wins?', array['a','b'], now() + interval '1 hour', null, false)$$, (select id from t where k = 'pw5')), 'PR005');
select pg_temp.must_fail('two or three options', :D,
  format($$select public.admin_create_question(%L, 'premier-league', 'Who wins?', array['a'], now() + interval '1 hour', null, false)$$, (select id from t where k = 'pw5')), 'PR005');
select pg_temp.must_fail('options must differ', :D,
  format($$select public.admin_create_question(%L, 'premier-league', 'Who wins?', array['Draw','draw '], now() + interval '1 hour', null, false)$$, (select id from t where k = 'pw5')), 'PR005');
select pg_temp.must_fail('kick-off must be in the future', :D,
  format($$select public.admin_create_question(%L, 'premier-league', 'Who wins?', array['a','b'], now() - interval '1 minute', null, false)$$, (select id from t where k = 'pw5')), 'PR005');
select pg_temp.must_fail('kick-off must be before the World ends', :D,
  format($$select public.admin_create_question(%L, 'premier-league', 'Who wins?', array['a','b'], now() + interval '6 hours', null, false)$$, (select id from t where k = 'pw5')), 'PR005');

-- The allowlist.
select pg_temp.must_fail('not invited: no Daily Drop', :A, $$select public.prediction_today()$$, 'PR004');
select pg_temp.must_fail('not invited: no picks', :A, format($$select public.submit_pick(%L, 0)$$, (select id from t where k = 'q1')), 'PR004');
select pg_temp.must_fail('not invited: no table', :A, $$select * from public.prediction_table()$$, 'PR004');
select pg_temp.must_fail('nobody invites themselves', :A, $$select public.admin_set_prediction_beta_member('00000000-0000-0000-0000-00000000000a', true)$$, '42501');
select pg_temp.must_fail('the allowlist table is closed', :A, $$insert into public.prediction_beta_members (user_id) values ('00000000-0000-0000-0000-00000000000a')$$, '42501');
select pg_temp.q(:D, $$select public.admin_set_prediction_beta_member('00000000-0000-0000-0000-00000000000a', true)$$);
select pg_temp.q(:D, $$select public.admin_set_prediction_beta_member('00000000-0000-0000-0000-00000000000a', true)$$);
select pg_temp.q(:D, $$select public.admin_set_prediction_beta_member('00000000-0000-0000-0000-00000000000b', true)$$);
select pg_temp.check('admins invite people; inviting twice is one row and one audit entry',
  (select count(*) = 2 from public.prediction_beta_members)
  and (select count(*) = 2 from public.admin_audit_log where action = 'prediction.beta_add'));
select pg_temp.check('the allowlist only gates predictions: uninvited people still see Worlds',
  pg_temp.q('00000000-0000-0000-0000-00000000000e', $$select count(*) from public.worlds where slug = 'pl-ars-che'$$)::int = 1);

-- Unpublished questions are admin-only.
select pg_temp.check('unpublished: members see nothing', pg_temp.q(:A, $$select public.prediction_today()$$) is null
  and pg_temp.q(:A, format($$select public.prediction_for_world(%L)$$, (select id from t where k = 'pw1'))) is null);
select pg_temp.must_fail('unpublished: no picks', :A, format($$select public.submit_pick(%L, 0)$$, (select id from t where k = 'q1')), 'PR004');
select pg_temp.check('unpublished: admins preview it', (pg_temp.q(:D, $$select public.prediction_today()$$)::jsonb ->> 'published') = 'false');
select pg_temp.q(:D, format($$select public.admin_update_question(%L, 'Who wins at the Emirates on Saturday?', array['Arsenal','Draw','Chelsea'])$$, (select id from t where k = 'q1')));
select pg_temp.q(:D, format($$select public.admin_publish_question(%L)$$, k.id)) from t k where k.k in ('q1', 'q2', 'q3', 'q4');
select pg_temp.must_fail('members cannot publish', :A, format($$select public.admin_publish_question(%L)$$, (select id from t where k = 'q1')), '42501');

-- Picks.
select pg_temp.q(:A, format($$select public.submit_pick(%L, 0)$$, (select id from t where k = 'q1')));
select pg_temp.q(:B, format($$select public.submit_pick(%L, 2)$$, (select id from t where k = 'q1')));
select pg_temp.q(:A, format($$select public.submit_pick(%L, 0)$$, (select id from t where k = 'q1')));
select pg_temp.check('the same pick twice is one pick, not a change',
  (select count(*) = 2 from public.predictions where question_id = (select id from t where k = 'q1'))
  and (select change_count = 0 and option = 0 from public.predictions where question_id = (select id from t where k = 'q1') and user_id = :A));
select pg_temp.q(:A, format($$select public.submit_pick(%L, 1)$$, (select id from t where k = 'q1')));
select pg_temp.q(:A, format($$select public.submit_pick(%L, 0)$$, (select id from t where k = 'q1')));
select pg_temp.check('changing a pick replaces it and is counted',
  (select count(*) = 1 and min(change_count) = 2 and min(option) = 0 from public.predictions where question_id = (select id from t where k = 'q1') and user_id = :A));
select pg_temp.must_fail('option out of range', :A, format($$select public.submit_pick(%L, 3)$$, (select id from t where k = 'q1')), 'PR002');
select pg_temp.must_fail('negative option', :A, format($$select public.submit_pick(%L, -1)$$, (select id from t where k = 'q1')), 'PR002');
select pg_temp.must_fail('two-way question has no third option', :A, format($$select public.submit_pick(%L, 2)$$, (select id from t where k = 'q2')), 'PR002');
select pg_temp.must_fail('no direct writes to picks', :A,
  format($$insert into public.predictions (question_id, user_id, option) values (%L, '00000000-0000-0000-0000-00000000000a', 1)$$, (select id from t where k = 'q2')), '42501');
select pg_temp.must_fail('no direct reads of picks', :B, $$select count(*) from public.predictions$$, '42501');
select pg_temp.must_fail('no reads of the questions table', :B, $$select count(*) from public.prediction_questions$$, '42501');
select pg_temp.act_as_admin();
update public.predictions set change_count = 10 where question_id = (select id from t where k = 'q1') and user_id = :A;
select pg_temp.must_fail('at most 10 changes', :A, format($$select public.submit_pick(%L, 1)$$, (select id from t where k = 'q1')), 'PR003');
select pg_temp.act_as_admin();
update public.predictions set change_count = 2 where question_id = (select id from t where k = 'q1') and user_id = :A;
insert into public.account_suspensions (user_id, reason) values (:B, 'test suspension');
select pg_temp.must_fail('suspended accounts cannot pick', :B, format($$select public.submit_pick(%L, 0)$$, (select id from t where k = 'q2')), 'AS001');
select pg_temp.act_as_admin();
delete from public.account_suspensions where user_id = :B;
select pg_temp.must_fail('a question can''t be edited once people have picked', :D,
  format($$select public.admin_update_question(%L, 'Changed?', array['a','b','c'])$$, (select id from t where k = 'q1')), 'PR005');

-- Hidden before kick-off.
insert into pr_t values ('b_view', pg_temp.q(:B, format($$select public.prediction_for_world(%L)$$, (select id from t where k = 'pw1'))));
insert into pr_t values ('d_view', pg_temp.q(:D, format($$select public.prediction_for_world(%L)$$, (select id from t where k = 'pw1'))));
select pg_temp.check('before kick-off: your own pick, nobody else''s, no counts (not even for admins)',
  (select (v::jsonb ->> 'myPick') = '2' and (v::jsonb ->> 'counts') is null and (v::jsonb ->> 'revealed') = 'false' and (v::jsonb ->> 'status') = 'open'
     from pr_t where k = 'b_view')
  and (select (v::jsonb ->> 'counts') is null and (v::jsonb ->> 'myPick') is null from pr_t where k = 'd_view'));
select pg_temp.check('the Daily Drop is today''s main question (Lagos date)',
  (pg_temp.q(:A, $$select public.prediction_today()$$)::jsonb ->> 'id')::uuid = (select id from t where k = 'q1'));

-- Locked at kick-off by the database clock (the transaction's now() is fixed, so move kick-off instead).
select pg_temp.act_as_admin();
update public.prediction_questions set locks_at = now() where id = (select id from t where k = 'q1');
select pg_temp.must_fail('no new pick at kick-off', :C, format($$select public.submit_pick(%L, 1)$$, (select id from t where k = 'q1')), 'PR001');
select pg_temp.must_fail('no change at kick-off', :A, format($$select public.submit_pick(%L, 1)$$, (select id from t where k = 'q1')), 'PR001');
select pg_temp.must_fail('no re-submit of the same pick at kick-off', :A, format($$select public.submit_pick(%L, 0)$$, (select id from t where k = 'q1')), 'PR001');
do $$ begin
  update public.predictions set option = 1 where question_id = (select id from t where k = 'q1') and user_id = '00000000-0000-0000-0000-00000000000a';
  raise exception 'FAIL a pick was changed after kick-off by a direct write';
exception when sqlstate 'PR001' then raise notice 'ok  the table itself refuses late writes (any role)';
end $$;
select pg_temp.check('picks are unchanged after the lock',
  (select string_agg(option::text, ',' order by user_id) = '0,2' from public.predictions where question_id = (select id from t where k = 'q1')));
insert into pr_t values ('b_after', pg_temp.q(:B, format($$select public.prediction_for_world(%L)$$, (select id from t where k = 'pw1'))));
select pg_temp.check('after kick-off: counts per option',
  (select (v::jsonb -> 'counts') = '[1, 0, 1]'::jsonb and (v::jsonb ->> 'status') = 'locked' from pr_t where k = 'b_after'));
select pg_temp.must_fail('members cannot settle', :A,
  format($$select public.admin_settle_question(%L, 0, 'https://www.premierleague.com/match/1')$$, (select id from t where k = 'q1')), '42501');
select pg_temp.must_fail('members cannot see the admin to-do list', :A, $$select public.admin_unsettled_questions()$$, '42501');
select pg_temp.check('admins see what needs a result',
  (select jsonb_array_length(v) = 1 and (v -> 0 ->> 'id')::uuid = (select id from t where k = 'q1')
     from (select pg_temp.q(:D, 'select public.admin_unsettled_questions()')::jsonb as v) x));

-- Results.
select pg_temp.must_fail('no result before kick-off', :D,
  format($$select public.admin_settle_question(%L, 0, 'https://www.uefa.com/match/1')$$, (select id from t where k = 'q2')), 'PR005');
select pg_temp.must_fail('a result needs an https source', :D,
  format($$select public.admin_settle_question(%L, 0, 'http://example.com')$$, (select id from t where k = 'q1')), 'PR005');
select pg_temp.must_fail('the result must be an option', :D,
  format($$select public.admin_settle_question(%L, 3, 'https://www.premierleague.com/match/1')$$, (select id from t where k = 'q1')), 'PR002');
select pg_temp.q(:D, format($$select public.admin_settle_question(%L, 0, 'https://www.premierleague.com/match/1', 'Full time 2-1')$$, (select id from t where k = 'q1')));
select pg_temp.must_fail('settled once only (use a correction)', :D,
  format($$select public.admin_settle_question(%L, 2, 'https://www.premierleague.com/match/1')$$, (select id from t where k = 'q1')), 'PR005');
select pg_temp.check('one point per correct pick, computed on the server',
  pg_temp.q(:A, $$select points || '/' || played || '/' || rank from public.prediction_table('all') where user_id = '00000000-0000-0000-0000-00000000000a'$$) = '1/1/1'
  and pg_temp.q(:A, $$select points || '/' || played || '/' || rank from public.prediction_table('all') where user_id = '00000000-0000-0000-0000-00000000000b'$$) = '0/1/2');
select pg_temp.check('your points on the question',
  (pg_temp.q(:A, format($$select public.prediction_for_world(%L)$$, (select id from t where k = 'pw1')))::jsonb ->> 'myPoints') = '1');

-- Corrections (48 hours).
select pg_temp.must_fail('a correction needs a reason', :D,
  format($$select public.admin_correct_question(%L, 2, 'https://www.premierleague.com/match/1', '')$$, (select id from t where k = 'q1')), 'PR005');
select pg_temp.must_fail('a correction must change the result', :D,
  format($$select public.admin_correct_question(%L, 0, 'https://www.premierleague.com/match/1', 'typo')$$, (select id from t where k = 'q1')), 'PR005');
select pg_temp.q(:D, format($$select public.admin_correct_question(%L, 2, 'https://www.bbc.co.uk/sport/football/1', 'Wrong team entered')$$, (select id from t where k = 'q1')));
select pg_temp.check('a correction re-scores everyone',
  pg_temp.q(:A, $$select points from public.prediction_table('all') where user_id = '00000000-0000-0000-0000-00000000000a'$$)::int = 0
  and pg_temp.q(:A, $$select points || '/' || rank from public.prediction_table('all') where user_id = '00000000-0000-0000-0000-00000000000b'$$) = '1/1');
select pg_temp.check('the correction is recorded with before and after',
  exists (select 1 from public.admin_audit_log where action = 'prediction.correct' and target_id = (select id from t where k = 'q1')
            and admin_id = :D and details ->> 'from' = '0' and details ->> 'to' = '2' and details ->> 'previous_source' = 'https://www.premierleague.com/match/1'));
select pg_temp.act_as_admin();
update public.prediction_questions set settled_at = now() - interval '49 hours' where id = (select id from t where k = 'q1');
select pg_temp.must_fail('no correction after 48 hours', :D,
  format($$select public.admin_correct_question(%L, 0, 'https://www.premierleague.com/match/1', 'Late change')$$, (select id from t where k = 'q1')), 'PR005');
select pg_temp.must_fail('no void after 48 hours', :D, format($$select public.admin_void_question(%L, 'Late void')$$, (select id from t where k = 'q1')), 'PR005');
select pg_temp.act_as_admin();
update public.prediction_questions set settled_at = now() - interval '1 hour' where id = (select id from t where k = 'q1');

-- q2: everyone right (ties). :C is an admin and may play too.
select pg_temp.q(:A, format($$select public.submit_pick(%L, 1)$$, (select id from t where k = 'q2')));
select pg_temp.q(:B, format($$select public.submit_pick(%L, 1)$$, (select id from t where k = 'q2')));
select pg_temp.q(:C, format($$select public.submit_pick(%L, 1)$$, (select id from t where k = 'q2')));
select pg_temp.act_as_admin();
update public.prediction_questions set locks_at = now() - interval '2 hours' where id = (select id from t where k = 'q2');
select pg_temp.q(:D, format($$select public.admin_settle_question(%L, 1, 'https://www.uefa.com/match/1')$$, (select id from t where k = 'q2')));

-- q3: settled, then voided within 48 hours (no points).
select pg_temp.q(:A, format($$select public.submit_pick(%L, 0)$$, (select id from t where k = 'q3')));
select pg_temp.q(:B, format($$select public.submit_pick(%L, 1)$$, (select id from t where k = 'q3')));
select pg_temp.act_as_admin();
update public.prediction_questions set locks_at = now() - interval '3 hours' where id = (select id from t where k = 'q3');
select pg_temp.q(:D, format($$select public.admin_settle_question(%L, 0, 'https://www.premierleague.com/match/3')$$, (select id from t where k = 'q3')));
select pg_temp.check('before the void :A has the point', pg_temp.q(:A, $$select points from public.prediction_table('all') where user_id = '00000000-0000-0000-0000-00000000000a'$$)::int = 2);
select pg_temp.must_fail('a void needs a reason', :D, format($$select public.admin_void_question(%L, null)$$, (select id from t where k = 'q3')), 'PR005');
select pg_temp.q(:D, format($$select public.admin_void_question(%L, 'Abandoned at half time, no official result')$$, (select id from t where k = 'q3')));
insert into pr_t values ('a_void', pg_temp.q(:A, format($$select public.prediction_for_world(%L)$$, (select id from t where k = 'pw3'))));
select pg_temp.check('a void question scores nothing and shows no result',
  (select (v::jsonb ->> 'status') = 'void' and (v::jsonb ->> 'correctOption') is null and (v::jsonb ->> 'myPoints') is null and (v::jsonb ->> 'myPick') = '0' from pr_t where k = 'a_void'));
select pg_temp.must_fail('void is final', :D, format($$select public.admin_correct_question(%L, 1, 'https://x.example/1', 'Changed')$$, (select id from t where k = 'q3')), 'PR005');
select pg_temp.must_fail('no picks on a void question', :A, format($$select public.submit_pick(%L, 1)$$, (select id from t where k = 'q3')), 'PR004');

-- q4: postponed, rescheduled; picks kept.
select pg_temp.q(:A, format($$select public.submit_pick(%L, 2)$$, (select id from t where k = 'q4')));
select pg_temp.q(:D, format($$select public.admin_postpone_question(%L, 'Storm warning, new date to follow')$$, (select id from t where k = 'q4')));
select pg_temp.must_fail('no picks while postponed', :B, format($$select public.submit_pick(%L, 0)$$, (select id from t where k = 'q4')), 'PR001');
select pg_temp.must_fail('no result while postponed', :D,
  format($$select public.admin_settle_question(%L, 0, 'https://www.premierleague.com/match/4')$$, (select id from t where k = 'q4')), 'PR005');
select pg_temp.q(:D, format($$select public.admin_reschedule_question(%L, now() + interval '70 hours', 'New date confirmed by the league')$$, (select id from t where k = 'q4')));
select pg_temp.check('rescheduled before the original kick-off: picks kept and open again',
  (select option = 2 from public.predictions where question_id = (select id from t where k = 'q4') and user_id = :A)
  and (pg_temp.q(:A, format($$select public.prediction_for_world(%L)$$, (select id from t where k = 'pw4')))::jsonb ->> 'status') = 'open');
select pg_temp.q(:B, format($$select public.submit_pick(%L, 0)$$, (select id from t where k = 'q4')));
-- Kick-off passes, then the match is called off and moved.
select pg_temp.act_as_admin();
update public.prediction_questions set locks_at = now() - interval '10 minutes' where id = (select id from t where k = 'q4');
select pg_temp.q(:D, format($$select public.admin_postpone_question(%L, 'Called off at the ground')$$, (select id from t where k = 'q4')));
select pg_temp.q(:D, format($$select public.admin_reschedule_question(%L, now() + interval '70 hours', 'Replayed next week')$$, (select id from t where k = 'q4')));
select pg_temp.must_fail('after the original kick-off, picks stay closed even when rescheduled', :B,
  format($$select public.submit_pick(%L, 1)$$, (select id from t where k = 'q4')), 'PR001');
select pg_temp.check('picks kept through postponement',
  (select count(*) = 2 from public.predictions where question_id = (select id from t where k = 'q4'))
  and (pg_temp.q(:A, format($$select public.prediction_for_world(%L)$$, (select id from t where k = 'pw4')))::jsonb ->> 'status') = 'locked');
select pg_temp.must_fail('the result waits for the new kick-off', :D,
  format($$select public.admin_settle_question(%L, 0, 'https://www.premierleague.com/match/4')$$, (select id from t where k = 'q4')), 'PR005');
select pg_temp.must_fail('a new kick-off must be in the future', :D,
  format($$select public.admin_reschedule_question(%L, now() - interval '1 hour', 'Oops')$$, (select id from t where k = 'q4')), 'PR005');

-- The table: all time and this week, ties share a rank.
select pg_temp.check('all-time table: points, played and shared ranks',
  pg_temp.q(:B, $$select string_agg(display_name || ':' || points || '/' || played || '#' || rank, ' ' order by rank, display_name) from public.prediction_table('all')$$)
    = 'Leo Park:2/2#1 Ama M.:1/2#2 Zoë Laurent:1/1#2');
select pg_temp.act_as_admin();
update public.prediction_questions set drop_date = drop_date - 14 where id = (select id from t where k = 'q2');
select pg_temp.check('weekly table only counts this week''s Drops (Lagos)',
  pg_temp.q(:B, $$select string_agg(display_name || ':' || points || '#' || rank, ' ' order by rank, display_name) from public.prediction_table('week')$$)
    = 'Leo Park:1#1 Ama M.:0#2');
select pg_temp.must_fail('the table is for invited people', '00000000-0000-0000-0000-00000000000e', $$select * from public.prediction_table()$$, 'PR004');
select pg_temp.must_fail('unknown period refused', :A, $$select * from public.prediction_table('month')$$, '22023');

-- The audit trail.
select pg_temp.check('every admin action on a question is recorded',
  (select string_agg(action, ',' order by created_at, action) from public.admin_audit_log where target_id = (select id from t where k = 'q1'))
    = 'prediction.correct,prediction.create,prediction.publish,prediction.settle,prediction.update'
  and (select count(*) = 4 from public.admin_audit_log where target_id = (select id from t where k = 'q4') and action in ('prediction.postpone', 'prediction.reschedule'))
  and exists (select 1 from public.admin_audit_log where action = 'prediction.void' and target_id = (select id from t where k = 'q3') and details ->> 'was_settled' = 'true'));
select pg_temp.q(:D, $$select public.admin_set_prediction_beta_member('00000000-0000-0000-0000-00000000000a', false)$$);
select pg_temp.must_fail('removed from the beta: no access', :A, $$select public.prediction_today()$$, 'PR004');
select pg_temp.check('removal is recorded', exists (select 1 from public.admin_audit_log where action = 'prediction.beta_remove' and target_id = :A));

-- Internal helpers stay internal.
select pg_temp.must_fail('anon cannot pick', null, format($$select public.submit_pick(%L, 0)$$, (select id from t where k = 'q4')), '42501');
select pg_temp.must_fail('question view helper not callable', :B,
  format($$select public.prediction_view(q, '00000000-0000-0000-0000-00000000000a') from public.prediction_questions q where id = %L$$, (select id from t where k = 'q1')), '42501');
select pg_temp.must_fail('membership helper not callable', :B, $$select public.prediction_require_member()$$, '42501');
select pg_temp.must_fail('admin row helper not callable', :D, format($$select public.prediction_admin_get(%L)$$, (select id from t where k = 'q1')), '42501');
select pg_temp.must_fail('lock trigger not callable', :B, $$select public.predictions_guard()$$, '42501');

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
