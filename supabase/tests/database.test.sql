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
