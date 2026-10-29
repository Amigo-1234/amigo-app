-- =============================================================================
-- Business profiles (MVP). On top of 20261028120000 media release; independent of
-- the football-predictions migration.
--
-- A business is owned by one person (one each) and has its own handle (/b/:handle),
-- name, category, description, logo, cover and optional website, email and phone.
-- The owner stays private: nothing another user can read links a business, its posts
-- or its files to a person.
--   * Business posts have no personal author: posts.author_id is null and
--     posts.business_id is set (exactly one of the two). They are top-level and public;
--     created and deleted by the owner only (create_business_post, delete_post).
--     Likes and replies stay personal. Mentions, likes and replies on a business post
--     notify nobody (notify() skips a missing recipient).
--   * businesses.owner_id is not readable by users (column grants); owners reach their
--     own business through my_business().
--   * Files: keys start with the business ("b/<business>/<purpose>/..."), and
--     post_media.owner_id is no longer readable.
-- Nothing is possible until an admin turns business_settings.enabled on (default off),
-- after the app that understands business posts is deployed.
--
-- Error codes: BZ001 not eligible · BZ002 handle · BZ003 name · BZ004 not found /
-- not yours · BZ005 handle changed too recently · BZ006 already have one ·
-- BZ007 suspended · RL001 slow down.
-- =============================================================================

-- ------------------------------------------------------------------ settings

create table public.business_settings (
  id          integer primary key default 1 check (id = 1),
  enabled     boolean not null default false,
  updated_at  timestamptz not null default now()
);
insert into public.business_settings (id) values (1);
revoke all on public.business_settings from anon, authenticated;
alter table public.business_settings enable row level security;

-- ---------------------------------------------------------------- businesses

create table public.businesses (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null unique references public.profiles (id) on delete cascade,
  handle             text not null check (handle ~ '^[a-z0-9_]{3,24}$'),
  name               text not null check (char_length(btrim(name)) between 1 and 50),
  category           text not null check (category in (
                       'food_drink', 'retail', 'beauty_wellness', 'health', 'services', 'education', 'technology',
                       'creative_media', 'events_entertainment', 'travel_hospitality', 'nonprofit_community', 'other')),
  description        text not null default '' check (char_length(description) <= 500),
  logo_url           text check (logo_url is null or logo_url ~ '^/api/media/b/[0-9a-f-]{36}/business_logo/[0-9a-f]{32}\.(jpg|png|webp|gif)$'),
  cover_url          text check (cover_url is null or cover_url ~ '^/api/media/b/[0-9a-f-]{36}/business_cover/[0-9a-f]{32}\.(jpg|png|webp|gif)$'),
  website_url        text check (website_url is null or (char_length(website_url) <= 200 and website_url ~* '^https://[a-z0-9.-]+\.[a-z]{2,}(/\S*)?$')),
  contact_email      text check (contact_email is null or (char_length(contact_email) <= 254 and contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  contact_phone      text check (contact_phone is null or contact_phone ~ '^\+?[0-9][0-9 ()-]{5,19}$'),
  status             text not null default 'active' check (status in ('active', 'suspended')),
  suspended_note     text check (suspended_note is null or char_length(suspended_note) <= 300),
  follower_count     integer not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  handle_changed_at  timestamptz not null default now()
);
create unique index businesses_handle_key on public.businesses (handle);
create index businesses_active_category on public.businesses (category, follower_count desc) where status = 'active';
create trigger businesses_touch before update on public.businesses for each row execute function public.touch_updated_at();
alter table public.businesses enable row level security;
revoke all on public.businesses from anon, authenticated;
-- Everything but the owner. (Posts embed the business; owners use my_business().)
grant select (id, handle, name, category, description, logo_url, cover_url, website_url, contact_email, contact_phone,
              status, follower_count, created_at) on public.businesses to authenticated;
create policy "Active businesses are public" on public.businesses for select to authenticated
  using (status = 'active' or public.is_admin());

create table public.business_follows (
  user_id      uuid not null references public.profiles (id) on delete cascade,
  business_id  uuid not null references public.businesses (id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (user_id, business_id)
);
create index business_follows_business on public.business_follows (business_id);
revoke all on public.business_follows from anon, authenticated;
alter table public.business_follows enable row level security;

-- Counts for rate limits (creating a business, following); kept a day.
create table public.business_action_log (
  user_id     uuid not null references public.profiles (id) on delete cascade,
  action      text not null check (action in ('create', 'follow')),
  created_at  timestamptz not null default now()
);
create index business_action_log_recent on public.business_action_log (user_id, action, created_at desc);
revoke all on public.business_action_log from anon, authenticated;
alter table public.business_action_log enable row level security;

create function public.business_follow_count() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    update public.businesses set follower_count = follower_count + 1 where id = new.business_id;
  else
    update public.businesses set follower_count = greatest(follower_count - 1, 0) where id = old.business_id;
  end if;
  return null;
end $$;
create trigger business_follows_count after insert or delete on public.business_follows
  for each row execute function public.business_follow_count();

-- ---------------------------------------------------------------- posts

alter table public.posts
  alter column author_id drop not null,
  add column business_id uuid references public.businesses (id) on delete cascade,
  add constraint posts_one_author check ((author_id is null) <> (business_id is null)),
  add constraint posts_business_shape check (
    business_id is null
    or (parent_id is null and repost_of_id is null and world_id is null and visibility = 'public' and not is_entry));
create index posts_business_created_idx on public.posts (business_id, created_at desc) where business_id is not null;

create function public.business_is_active(p_business uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.businesses where id = p_business and status = 'active')
$$;

create function public.viewer_follows_business(p_business uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.business_follows where user_id = (select auth.uid()) and business_id = p_business)
$$;

drop policy "Visible posts can be read" on public.posts;
create policy "Visible posts can be read" on public.posts
  for select
  to anon, authenticated
  using (
    deleted_at is null
    and (
      visibility = 'public'
      or author_id = (select auth.uid())
      or (visibility = 'followers' and public.viewer_follows(author_id))
    )
    and not public.viewer_blocked_with(author_id)
    and (business_id is null or public.business_is_active(business_id))
  );

-- Business posts come only from create_business_post.
drop policy "People post as themselves" on public.posts;
create policy "People post as themselves" on public.posts
  for insert
  to authenticated
  with check (
    author_id = (select auth.uid())
    and business_id is null
    and (parent_id is null or public.can_view_post(parent_id))
    and (repost_of_id is null or public.can_view_post(repost_of_id))
  );

create or replace function public.can_view_post(p_post_id uuid) returns boolean
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
      and not public.viewer_blocked_with(p.author_id)
      and (p.business_id is null or public.business_is_active(p.business_id))
  );
$$;

-- Following now includes the businesses you follow.
create or replace function public.feed_posts(
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
      or (p.business_id is not null and public.viewer_follows_business(p.business_id))
    )
  order by p.created_at desc, p.id desc
  limit least(greatest(coalesce(p_limit, 20), 1), 100);
$$;

-- Business post photos are named after the business, not the uploader.
alter table public.post_media
  drop constraint post_media_path_owned,
  add constraint post_media_path_owned check (
    storage_path like owner_id::text || '/%' or storage_path ~ '^b/[0-9a-f-]{36}/business_post/');

-- post_media.owner_id is no longer readable (it would name a business post's owner).
revoke select on public.post_media from anon, authenticated;
grant select (id, post_id, position, kind, bucket, storage_path, mime_type, width, height, duration_ms, byte_size, alt, created_at, preview)
  on public.post_media to anon, authenticated;

-- ---------------------------------------------------------------- media

alter table public.media_objects
  add column business_id uuid references public.businesses (id) on delete cascade,
  drop constraint media_objects_purpose_check,
  add constraint media_objects_purpose_check check (purpose in ('avatar', 'post', 'moment', 'dm', 'business_logo', 'business_cover', 'business_post')),
  add constraint media_objects_business_purpose check ((purpose like 'business_%') = (business_id is not null));

drop function public.media_begin_upload(text, text, bigint, uuid);
create function public.media_begin_upload(p_purpose text, p_mime text, p_size bigint, p_conversation uuid default null, p_business uuid default null)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  max_bytes bigint;
  ext text;
  key text;
begin
  if uid is null then raise exception 'sign in first' using errcode = 'MD001'; end if;
  if p_purpose = 'dm' then
    -- Ciphertext only; the real type is inside the encrypted message.
    if p_mime <> 'application/octet-stream' then raise exception 'encrypted uploads only' using errcode = 'MD002'; end if;
    max_bytes := 50 * 1024 * 1024;
    perform public.dm_require_participant(p_conversation);
    if exists (select 1 from public.dm_participants p where p.conversation_id = p_conversation and p.user_id <> uid
                 and public.dm_blocked_between(uid, p.user_id)) then
      raise exception 'blocked' using errcode = 'MD001';
    end if;
    ext := 'bin';
  elsif p_purpose in ('avatar', 'post', 'moment', 'business_logo', 'business_cover', 'business_post') then
    if p_conversation is not null then raise exception 'not allowed' using errcode = 'MD001'; end if;
    if (p_purpose like 'business_%') <> (p_business is not null)
       or (p_business is not null and not exists (
             select 1 from public.businesses b where b.id = p_business and b.owner_id = uid and b.status = 'active')) then
      raise exception 'not allowed' using errcode = 'MD001';
    end if;
    case
      when p_mime in ('image/jpeg', 'image/png', 'image/webp', 'image/gif') then
        max_bytes := case when p_purpose in ('avatar', 'business_logo') then 5 else 10 end * 1024 * 1024;
        ext := case p_mime when 'image/jpeg' then 'jpg' when 'image/png' then 'png' when 'image/webp' then 'webp' else 'gif' end;
      when p_mime in ('video/mp4', 'video/webm', 'video/quicktime') and p_purpose in ('post', 'moment', 'business_post') then
        max_bytes := 50 * 1024 * 1024;
        ext := case p_mime when 'video/mp4' then 'mp4' when 'video/webm' then 'webm' else 'mov' end;
      else raise exception 'unsupported file type' using errcode = 'MD002';
    end case;
  else
    raise exception 'unknown purpose' using errcode = 'MD002';
  end if;
  if p_size is null or p_size <= 0 or p_size > max_bytes then raise exception 'file too large' using errcode = 'MD002'; end if;
  if (select count(*) from public.media_objects where owner_id = uid and variant_of is null and created_at > now() - interval '1 hour') >= 60 then
    raise exception 'upload limit reached, try later' using errcode = 'MD003';
  end if;
  if (select coalesce(sum(byte_size), 0) from public.media_objects where owner_id = uid and created_at > now() - interval '1 day') + p_size
     > 1024::bigint * 1024 * 1024 then
    raise exception 'daily upload limit reached' using errcode = 'MD003';
  end if;
  -- Stale pending uploads (never attached within a day) are dropped and queued for deletion.
  delete from public.media_objects where owner_id = uid and status = 'pending' and purpose <> 'dm' and created_at < now() - interval '1 day';
  -- Business files are named after the business, not the person.
  key := case when p_business is not null then 'b/' || p_business::text else uid::text end
         || '/' || p_purpose || '/' || coalesce(p_conversation::text || '/', '') || replace(gen_random_uuid()::text, '-', '') || '.' || ext;
  insert into public.media_objects (path, owner_id, purpose, conversation_id, business_id, mime, byte_size)
  values (key, uid, p_purpose, p_conversation, p_business, p_mime, p_size);
  return key;
end $$;
revoke execute on function public.media_begin_upload(text, text, bigint, uuid, uuid) from public, anon;
grant execute on function public.media_begin_upload(text, text, bigint, uuid, uuid) to authenticated;

create or replace function public.media_begin_variant(p_original text, p_mime text, p_size bigint) returns text
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  o public.media_objects;
  key text;
begin
  if uid is null then raise exception 'sign in first' using errcode = 'MD001'; end if;
  select * into o from public.media_objects where path = p_original;
  if o.path is null or o.owner_id <> uid or o.variant_of is not null or o.purpose not in ('post', 'moment', 'business_post')
     or o.mime not in ('image/jpeg', 'image/png', 'image/webp') then
    raise exception 'not your upload' using errcode = 'MD001';
  end if;
  if p_mime not in ('image/jpeg', 'image/webp') then raise exception 'unsupported file type' using errcode = 'MD002'; end if;
  if p_size is null or p_size <= 0 or p_size > 2 * 1024 * 1024 then raise exception 'file too large' using errcode = 'MD002'; end if;
  if exists (select 1 from public.media_objects where variant_of = p_original) then
    raise exception 'already has a smaller copy' using errcode = 'MD001';
  end if;
  key := regexp_replace(p_original, '\.[a-z0-9]+$', '') || '-sm.' || case p_mime when 'image/webp' then 'webp' else 'jpg' end;
  -- Attached from the start: it lives and goes with its original.
  insert into public.media_objects (path, owner_id, purpose, business_id, mime, byte_size, status, variant_of)
  values (key, uid, o.purpose, o.business_id, p_mime, p_size, 'attached', p_original);
  return key;
end $$;

create or replace function public.post_media_require_upload() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if public.media_registry_required() then
    perform public.media_attach(new.storage_path,
      case when exists (select 1 from public.posts p where p.id = new.post_id and p.business_id is not null) then 'business_post' else 'post' end);
  end if;
  return new;
end $$;

-- Business logos and covers: readable while the business is active (admins: always).
-- Business post photos follow their post, like personal ones. Otherwise unchanged.
create or replace function public.media_readable(p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is not null and exists (
    select 1 from public.media_objects o
     where o.path = p_path and o.variant_of is null
       and (o.owner_id = (select auth.uid())
            or (o.purpose = 'avatar' and o.status = 'attached')
            or (o.purpose in ('post', 'business_post') and exists (
                  select 1 from public.post_media pm join public.posts p on p.id = pm.post_id
                   where pm.storage_path = o.path and p.deleted_at is null and public.can_view_post(p.id)))
            or (o.purpose in ('post', 'business_post') and public.is_admin() and exists (
                  select 1 from public.post_media pm join public.posts p on p.id = pm.post_id
                   where pm.storage_path = o.path and p.taken_down_at is not null))
            or (o.purpose in ('business_logo', 'business_cover') and o.status = 'attached'
                and (public.business_is_active(o.business_id) or public.is_admin()))
            or (o.purpose = 'moment' and public.moment_media_readable(o.path))
            or (o.purpose = 'dm' and exists (
                  select 1 from public.dm_participants dp
                   where dp.conversation_id = o.conversation_id and dp.user_id = (select auth.uid())))))
$$;

create or replace function public.media_release_post(p_post uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  delete from public.media_objects o
   using public.post_media pm
   where pm.post_id = p_post and o.path = pm.storage_path and o.purpose in ('post', 'business_post') and o.variant_of is null;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------- posts: owner actions

create or replace function public.delete_post(p_post_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.posts
     set deleted_at = now()
   where id = p_post_id
     and (author_id = (select auth.uid())
          -- Not while the business is suspended: its posts stay for review.
          or (business_id is not null and business_id = (select b.id from public.businesses b
                                                          where b.owner_id = (select auth.uid()) and b.status = 'active')))
     and deleted_at is null;
  if not found then
    raise exception 'post not found' using errcode = 'P0002';
  end if;
  perform public.media_release_post(p_post_id);
end $$;

create or replace function public.admin_remove_post(p_post uuid, p_note text default '') returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_admin();
  who text;
begin
  update public.posts po set deleted_at = now(), taken_down_at = now() where po.id = p_post and po.deleted_at is null
  returning coalesce((select '@' || username from public.profiles where id = po.author_id),
                     (select '/b/' || handle from public.businesses where id = po.business_id)) into who;
  if who is null then raise exception 'no such post' using errcode = 'SP005'; end if;
  update public.content_reports set status = 'reviewed', reviewed_by = uid, reviewed_at = now()
   where target_type = 'post' and target_id = p_post and status = 'open';
  perform public.admin_log('post.remove', 'post', p_post,
    format('removed a post by %s%s', who, coalesce(' — ' || nullif(btrim(p_note), ''), '')));
end $$;

-- ---------------------------------------------------------------- reports

alter table public.content_reports
  drop constraint content_reports_target_type_check,
  add constraint content_reports_target_type_check check (target_type in ('post', 'profile', 'world', 'business'));

create or replace function public.report_content(p_type text, p_target uuid, p_reason text, p_note text default '') returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  if p_type = 'post' then
    -- Not your own post, nor your own business's.
    if not exists (select 1 from public.posts p where p.id = p_target and p.deleted_at is null
                     and p.author_id is distinct from uid
                     and not exists (select 1 from public.businesses b where b.id = p.business_id and b.owner_id = uid))
       or not public.can_view_post(p_target) then
      raise exception 'nothing to report' using errcode = 'RP001';
    end if;
  elsif p_type = 'profile' then
    if p_target = uid or not exists (select 1 from public.profiles where id = p_target) then
      raise exception 'nothing to report' using errcode = 'RP001';
    end if;
  elsif p_type = 'world' then
    if not exists (select 1 from public.worlds where id = p_target) then
      raise exception 'nothing to report' using errcode = 'RP001';
    end if;
  elsif p_type = 'business' then
    if not exists (select 1 from public.businesses b where b.id = p_target and b.status = 'active' and b.owner_id <> uid) then
      raise exception 'nothing to report' using errcode = 'RP001';
    end if;
  else
    raise exception 'nothing to report' using errcode = 'RP001';
  end if;
  if (select count(*) from public.content_reports where reporter_id = uid and created_at > now() - interval '1 hour') >= 20 then
    raise exception 'too many reports' using errcode = 'RP002';
  end if;
  begin
    insert into public.content_reports (reporter_id, target_type, target_id, reason, note)
    values (uid, p_type, p_target, p_reason, btrim(coalesce(p_note, '')));
  exception
    when check_violation then raise exception 'invalid report' using errcode = 'RP001';
    -- Already reported and still open: nothing more to do.
    when unique_violation then null;
  end;
end $$;

-- Admins see business reports, and who runs a reported business or wrote a reported business post.
create or replace function public.admin_content_reports(p_status text default 'open') returns table (
  id uuid, reporter_username text, target_type text, target_id uuid, reason text, note text, status text, created_at timestamptz,
  target_label text, target_text text, target_author_id uuid, target_author_username text, target_removed boolean, report_count bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.support_require_admin();
  return query
    select r.id, rp.username, r.target_type, r.target_id, r.reason, r.note, r.status, r.created_at,
           case r.target_type
             when 'post' then case when po.business_id is not null then 'Business post' when po.parent_id is null then 'Post' else 'Reply' end
             when 'profile' then 'Profile'
             when 'business' then 'Business'
             else 'World' end,
           case r.target_type
             when 'post' then left(po.body, 500)
             when 'profile' then left(coalesce(pr.display_name, '') || ' — ' || coalesce(pr.bio, ''), 500)
             when 'business' then left(coalesce(bz.name, '') || ' — ' || coalesce(bz.description, ''), 500)
             else left(coalesce(w.title, '') || ' — ' || coalesce(w.description, ''), 500) end,
           coalesce(po.author_id, pb.owner_id, bz.owner_id, pr.id),
           coalesce(pa.username, pbo.username, bzo.username, pr.username),
           case r.target_type
             when 'post' then po.id is null or po.deleted_at is not null
             when 'business' then bz.id is null or bz.status <> 'active'
             else false end,
           (select count(*) from public.content_reports x where x.target_type = r.target_type and x.target_id = r.target_id and x.status = 'open')
      from public.content_reports r
      join public.profiles rp on rp.id = r.reporter_id
      left join public.posts po on r.target_type = 'post' and po.id = r.target_id
      left join public.profiles pa on pa.id = po.author_id
      left join public.businesses pb on pb.id = po.business_id
      left join public.profiles pbo on pbo.id = pb.owner_id
      left join public.profiles pr on r.target_type = 'profile' and pr.id = r.target_id
      left join public.businesses bz on r.target_type = 'business' and bz.id = r.target_id
      left join public.profiles bzo on bzo.id = bz.owner_id
      left join public.worlds w on r.target_type = 'world' and w.id = r.target_id
     where p_status = 'all' or r.status = p_status
     order by r.created_at desc
     limit 300;
end $$;

-- ---------------------------------------------------------------- owner functions

create function public.business_reserved_handle(p_handle text) returns boolean
language sql immutable set search_path = '' as $$
  select p_handle in ('amigo', 'amigoworld', 'admin', 'support', 'official', 'help', 'team', 'security', 'staff', 'moderator')
$$;

-- Common field checks for create/update (the table's own checks back them up).
create function public.business_check_fields(p_handle text, p_name text) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p_handle !~ '^[a-z0-9_]{3,24}$' or public.business_reserved_handle(p_handle) then
    raise exception 'that handle isn''t available' using errcode = 'BZ002';
  end if;
  if char_length(btrim(coalesce(p_name, ''))) not between 1 and 50 or p_name ~* 'amigo' then
    raise exception 'that name isn''t allowed' using errcode = 'BZ003';
  end if;
end $$;

create function public.create_business(p_handle text, p_name text, p_category text, p_description text default '',
                                       p_website text default null, p_email text default null, p_phone text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  v_handle text := lower(btrim(coalesce(p_handle, '')));
  new_id uuid;
begin
  if uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  if not (select enabled from public.business_settings where id = 1) then
    raise exception 'business profiles aren''t available yet' using errcode = 'BZ001';
  end if;
  if public.is_suspended(uid) or (select email_confirmed_at from auth.users where auth.users.id = uid) is null then
    raise exception 'verify your email first' using errcode = 'BZ001';
  end if;
  if exists (select 1 from public.businesses where owner_id = uid) then
    raise exception 'you already have a business' using errcode = 'BZ006';
  end if;
  if (select count(*) from public.business_action_log l where l.user_id = uid and l.action = 'create' and l.created_at > now() - interval '1 day') >= 3 then
    raise exception 'slow down: try again tomorrow' using errcode = 'RL001';
  end if;
  perform public.business_check_fields(v_handle, p_name);
  begin
    insert into public.businesses (owner_id, handle, name, category, description, website_url, contact_email, contact_phone)
    values (uid, v_handle, btrim(p_name), p_category, btrim(coalesce(p_description, '')),
            nullif(btrim(coalesce(p_website, '')), ''), nullif(lower(btrim(coalesce(p_email, ''))), ''), nullif(btrim(coalesce(p_phone, '')), ''))
    returning businesses.id into new_id;
  exception
    when unique_violation then raise exception 'that handle isn''t available' using errcode = 'BZ002';
    when check_violation then raise exception 'check the details' using errcode = '22023';
  end;
  insert into public.business_action_log (user_id, action) values (uid, 'create');
  delete from public.business_action_log where created_at < now() - interval '1 day';
  return new_id;
end $$;

-- Your business, everything about it (owner only).
create function public.my_business() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'enabled', (select enabled from public.business_settings where id = 1),
    'business', (select to_jsonb(b) - 'owner_id' || jsonb_build_object(
                   'post_count', (select count(*) from public.posts p where p.business_id = b.id and p.deleted_at is null),
                   'can_change_handle_at', b.handle_changed_at + interval '30 days')
                 from public.businesses b where b.owner_id = (select auth.uid())))
$$;

create function public.update_business(p_name text, p_category text, p_description text,
                                       p_website text, p_email text, p_phone text, p_handle text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  b public.businesses;
  v_handle text;
begin
  select * into b from public.businesses where owner_id = uid;
  if b.id is null then raise exception 'no business' using errcode = 'BZ004'; end if;
  if b.status <> 'active' then raise exception 'this business is suspended' using errcode = 'BZ007'; end if;
  v_handle := coalesce(nullif(lower(btrim(coalesce(p_handle, ''))), ''), b.handle);
  perform public.business_check_fields(v_handle, p_name);
  if v_handle <> b.handle and b.handle_changed_at > now() - interval '30 days' then
    raise exception 'you can change the handle once every 30 days' using errcode = 'BZ005';
  end if;
  begin
    update public.businesses
       set handle = v_handle, name = btrim(p_name), category = p_category, description = btrim(coalesce(p_description, '')),
           website_url = nullif(btrim(coalesce(p_website, '')), ''), contact_email = nullif(lower(btrim(coalesce(p_email, ''))), ''),
           contact_phone = nullif(btrim(coalesce(p_phone, '')), ''),
           handle_changed_at = case when v_handle <> b.handle then now() else b.handle_changed_at end
     where id = b.id;
  exception
    when unique_violation then raise exception 'that handle isn''t available' using errcode = 'BZ002';
    when check_violation then raise exception 'check the details' using errcode = '22023';
  end;
end $$;

-- Sets (or with null, removes) the logo or cover: your own pending upload for this business.
-- The file it replaces is released (queued for deletion).
create function public.set_business_image(p_kind text, p_key text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  b public.businesses;
  v_purpose text := case p_kind when 'logo' then 'business_logo' when 'cover' then 'business_cover' end;
  old text;
begin
  select * into b from public.businesses where owner_id = uid;
  if b.id is null then raise exception 'no business' using errcode = 'BZ004'; end if;
  if v_purpose is null then raise exception 'unknown image' using errcode = '22023'; end if;
  if b.status <> 'active' then raise exception 'this business is suspended' using errcode = 'BZ007'; end if;
  if p_key is not null then
    update public.media_objects set status = 'attached'
     where path = p_key and owner_id = uid and business_id = b.id and media_objects.purpose = v_purpose and media_objects.status = 'pending';
    if not found then raise exception 'not your upload' using errcode = 'MD001'; end if;
  end if;
  old := case p_kind when 'logo' then b.logo_url else b.cover_url end;
  if p_kind = 'logo' then
    update public.businesses set logo_url = case when p_key is null then null else '/api/media/' || p_key end where id = b.id;
  else
    update public.businesses set cover_url = case when p_key is null then null else '/api/media/' || p_key end where id = b.id;
  end if;
  if old is not null and old is distinct from '/api/media/' || p_key then
    delete from public.media_objects where path = substr(old, 12) and business_id = b.id;
  end if;
end $$;

-- Removes your business, its posts and files (queued for deletion). Not while it's suspended.
create function public.delete_business() returns void
language plpgsql security definer set search_path = '' as $$
declare b public.businesses;
begin
  select * into b from public.businesses where owner_id = (select auth.uid());
  if b.id is null then raise exception 'no business' using errcode = 'BZ004'; end if;
  if b.status <> 'active' then raise exception 'this business is suspended' using errcode = 'BZ007'; end if;
  delete from public.businesses where id = b.id;
end $$;

-- A top-level public post as your business. Same rules as create_post for text and media,
-- plus 10 per 10 minutes and 50 a day per business.
create function public.create_business_post(p_body text, p_media jsonb default '[]'::jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  b public.businesses;
  body text := btrim(coalesce(p_body, ''));
  media_count integer := coalesce(jsonb_array_length(p_media), 0);
  new_post uuid;
  item jsonb;
  i integer := 0;
begin
  if uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  select * into b from public.businesses where owner_id = uid;
  if b.id is null then raise exception 'no business' using errcode = 'BZ004'; end if;
  if b.status <> 'active' then raise exception 'this business is suspended' using errcode = 'BZ007'; end if;
  if public.is_suspended(uid) then raise exception 'account suspended' using errcode = 'AS001'; end if;
  if body = '' and media_count = 0 then raise exception 'a post needs text or media' using errcode = '22023'; end if;
  if char_length(body) > 500 then raise exception 'posts are limited to 500 characters' using errcode = '22001'; end if;
  if media_count > 4 then raise exception 'at most 4 media items per post' using errcode = '22023'; end if;
  if (select count(*) from public.posts p where p.business_id = b.id and p.created_at > now() - interval '10 minutes') >= 10 then
    raise exception 'slow down: too many posts' using errcode = 'RL001';
  end if;
  if (select count(*) from public.posts p where p.business_id = b.id and p.created_at > now() - interval '1 day') >= 50 then
    raise exception 'daily post limit reached' using errcode = 'RL001';
  end if;
  insert into public.posts (author_id, business_id, body, visibility) values (null, b.id, body, 'public') returning posts.id into new_post;
  for item in select value from jsonb_array_elements(coalesce(p_media, '[]'::jsonb)) loop
    if coalesce(item ->> 'storage_path', '') not like 'b/' || b.id::text || '/business_post/%' then
      raise exception 'not this business''s upload' using errcode = 'MD001';
    end if;
    insert into public.post_media (post_id, owner_id, position, kind, storage_path, mime_type, width, height, byte_size, alt, preview)
    values (new_post, uid, i, (item ->> 'kind')::public.media_kind, item ->> 'storage_path', item ->> 'mime_type',
            (item ->> 'width')::integer, (item ->> 'height')::integer, (item ->> 'byte_size')::bigint,
            nullif(item ->> 'alt', ''), nullif(item ->> 'preview', ''));
    i := i + 1;
  end loop;
  return new_post;
end $$;

-- ---------------------------------------------------------------- public reads

create function public.business_by_handle(p_handle text) returns table (
  id uuid, handle text, name text, category text, description text, logo_url text, cover_url text,
  website_url text, contact_email text, contact_phone text, follower_count integer, post_count bigint,
  created_at timestamptz, following boolean, mine boolean)
language sql stable security definer set search_path = '' as $$
  select b.id, b.handle, b.name, b.category, b.description, b.logo_url, b.cover_url,
         b.website_url, b.contact_email, b.contact_phone, b.follower_count,
         (select count(*) from public.posts p where p.business_id = b.id and p.deleted_at is null),
         b.created_at, public.viewer_follows_business(b.id), b.owner_id = (select auth.uid())
    from public.businesses b
   where b.handle = lower(p_handle) and (b.status = 'active' or public.is_admin())
$$;

create function public.search_businesses(p_query text default '', p_category text default null, p_limit integer default 30)
returns table (id uuid, handle text, name text, category text, description text, logo_url text, follower_count integer, following boolean)
language sql stable security definer set search_path = '' as $$
  select b.id, b.handle, b.name, b.category, left(b.description, 160), b.logo_url, b.follower_count, public.viewer_follows_business(b.id)
    from public.businesses b
   where b.status = 'active'
     and (p_category is null or b.category = p_category)
     and (coalesce(btrim(p_query), '') = ''
          or b.name ilike '%' || replace(replace(replace(btrim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%'
          or b.handle ilike '%' || replace(replace(replace(btrim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%')
   order by b.follower_count desc, b.created_at desc
   limit least(greatest(coalesce(p_limit, 30), 1), 60)
$$;

create function public.follow_business(p_business uuid, p_follow boolean) returns integer
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  if p_follow then
    if not exists (select 1 from public.businesses b where b.id = p_business and b.status = 'active' and b.owner_id <> uid) then
      raise exception 'no such business' using errcode = 'BZ004';
    end if;
    if public.is_suspended(uid) then raise exception 'account suspended' using errcode = 'AS001'; end if;
    if (select count(*) from public.business_action_log l where l.user_id = uid and l.action = 'follow' and l.created_at > now() - interval '1 hour') >= 100 then
      raise exception 'slow down: too many follows' using errcode = 'RL001';
    end if;
    insert into public.business_follows (user_id, business_id) values (uid, p_business) on conflict do nothing;
    if found then insert into public.business_action_log (user_id, action) values (uid, 'follow'); end if;
  else
    delete from public.business_follows where user_id = uid and business_id = p_business;
  end if;
  return (select follower_count from public.businesses where id = p_business);
end $$;

-- The businesses you follow (the app's Following feed).
create function public.my_followed_businesses() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select business_id from public.business_follows where user_id = (select auth.uid())
$$;

-- ---------------------------------------------------------------- admin

create function public.admin_businesses(p_status text default 'all') returns table (
  id uuid, handle text, name text, category text, status text, suspended_note text,
  follower_count integer, post_count bigint, owner_id uuid, owner_username text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.support_require_admin();
  return query
    select b.id, b.handle, b.name, b.category, b.status, b.suspended_note, b.follower_count,
           (select count(*) from public.posts p where p.business_id = b.id and p.deleted_at is null),
           b.owner_id, pr.username, b.created_at
      from public.businesses b join public.profiles pr on pr.id = b.owner_id
     where p_status = 'all' or b.status = p_status
     order by b.created_at desc
     limit 300;
end $$;

create function public.admin_set_business_status(p_business uuid, p_suspend boolean, p_note text default '') returns void
language plpgsql security definer set search_path = '' as $$
declare
  h text;
begin
  perform public.support_require_admin();
  update public.businesses
     set status = case when p_suspend then 'suspended' else 'active' end,
         suspended_note = case when p_suspend then nullif(left(btrim(coalesce(p_note, '')), 300), '') end
   where id = p_business
  returning handle into h;
  if h is null then raise exception 'no such business' using errcode = 'SP005'; end if;
  if p_suspend then
    update public.content_reports set status = 'reviewed', reviewed_by = (select auth.uid()), reviewed_at = now()
     where target_type = 'business' and target_id = p_business and status = 'open';
  end if;
  perform public.admin_log(case when p_suspend then 'business.suspend' else 'business.restore' end, 'business', p_business,
    format('%s /b/%s%s', case when p_suspend then 'suspended' else 'restored' end, h, coalesce(' — ' || nullif(btrim(p_note), ''), '')));
end $$;

-- Turns business profiles on or off for everyone (off by default). Audit-logged.
create function public.admin_set_businesses_enabled(p_enabled boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.support_require_admin();
  update public.business_settings set enabled = p_enabled, updated_at = now() where id = 1;
  perform public.admin_log(case when p_enabled then 'business.enable' else 'business.disable' end, 'business_settings', null,
    case when p_enabled then 'turned business profiles on' else 'turned business profiles off' end);
end $$;

-- ---------------------------------------------------------------- grants

revoke execute on function
  public.business_follow_count(), public.business_is_active(uuid), public.viewer_follows_business(uuid),
  public.business_reserved_handle(text), public.business_check_fields(text, text),
  public.create_business(text, text, text, text, text, text, text), public.my_business(),
  public.update_business(text, text, text, text, text, text, text), public.set_business_image(text, text),
  public.delete_business(), public.create_business_post(text, jsonb), public.business_by_handle(text),
  public.search_businesses(text, text, integer), public.follow_business(uuid, boolean), public.my_followed_businesses(),
  public.admin_businesses(text), public.admin_set_business_status(uuid, boolean, text), public.admin_set_businesses_enabled(boolean)
from public, anon, authenticated;
grant execute on function
  public.create_business(text, text, text, text, text, text, text), public.my_business(),
  public.update_business(text, text, text, text, text, text, text), public.set_business_image(text, text),
  public.delete_business(), public.create_business_post(text, jsonb), public.business_by_handle(text),
  public.search_businesses(text, text, integer), public.follow_business(uuid, boolean), public.my_followed_businesses(),
  public.admin_businesses(text), public.admin_set_business_status(uuid, boolean, text), public.admin_set_businesses_enabled(boolean)
to authenticated;
-- Used by the posts policy and can_view_post (they run as the caller for the policy).
grant execute on function public.business_is_active(uuid), public.viewer_follows_business(uuid) to anon, authenticated;
