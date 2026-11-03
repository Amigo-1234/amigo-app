-- =============================================================================
-- Marketplace, phase 1 (on top of 20261028130000 business profiles; independent of the
-- football-predictions migration). Plan: docs/amigo-2.0-assessment.md.
--
-- Businesses list products and services. One listing model serves both the business's own
-- Products/Services tabs and the Marketplace, so prices and status never drift apart.
--   * Only businesses sell in this phase (listings.business_id); personal sellers come later
--     behind their own switch.
--   * Every write goes through a checked function; the client can only read. Who may manage a
--     business is decided in one place (business_can_manage), so managers can be added later.
--   * Prices are whole minor units (kobo for NGN); null means "price on request".
--   * Photos are business files ("b/<business>/business_listing/..."), attached through the
--     media registry and released through the cleanup queue like post photos.
--   * A business post can share one of its listings (posts.listing_id); the post shows the
--     listing as it is now (sold, reserved, or gone).
--   * Off until an admin turns 'marketplace' on in app_features; admins can use it before that.
--
-- Error codes: MK001 not available / not allowed · MK002 a field is invalid · MK003 no such
-- listing (or not yours) · MK004 removed by Amigo · BZ007 business suspended · RL001 slow down.
-- =============================================================================

-- ------------------------------------------------------------- feature switches

-- General on/off switches for features (business_settings keeps the business one).
create table public.app_features (
  key         text primary key check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  enabled     boolean not null default false,
  updated_at  timestamptz not null default now()
);
insert into public.app_features (key) values ('marketplace');
revoke all on public.app_features from anon, authenticated;
alter table public.app_features enable row level security;

create function public.feature_enabled(p_key text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select enabled from public.app_features where key = p_key), false)
$$;

-- The switches that are on (the app hides what's off).
create function public.enabled_features() returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(key order by key), '{}') from public.app_features where enabled
$$;

create function public.admin_set_feature(p_key text, p_enabled boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.support_require_admin();
  update public.app_features set enabled = p_enabled, updated_at = now() where key = p_key;
  if not found then raise exception 'no such feature' using errcode = '22023'; end if;
  perform public.admin_log(case when p_enabled then 'feature.enable' else 'feature.disable' end, 'feature', null,
    format('turned %s %s', p_key, case when p_enabled then 'on' else 'off' end));
end $$;

-- ------------------------------------------------------------ business details

-- Who may act for a business. Today: its owner, while the business is active. Business managers
-- will be added here only.
create function public.business_can_manage(p_business uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.businesses b
                  where b.id = p_business and b.owner_id = (select auth.uid()) and b.status = 'active')
$$;

-- Area and opening hours. Hours: {"mon": [["09:00","17:00"]], ...}, up to two ranges a day.
alter table public.businesses
  add column area text check (area is null or char_length(btrim(area)) between 2 and 60),
  add column hours jsonb check (hours is null or (jsonb_typeof(hours) = 'object' and pg_column_size(hours) <= 2000));
grant select (area, hours) on public.businesses to authenticated;

create function public.business_hours_valid(p_hours jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select p_hours is null or (
    jsonb_typeof(p_hours) = 'object'
    and not exists (select 1 from jsonb_object_keys(p_hours) k where k not in ('mon','tue','wed','thu','fri','sat','sun'))
    and not exists (
      select 1 from jsonb_each(p_hours) d
       where jsonb_typeof(d.value) <> 'array' or jsonb_array_length(d.value) > 2
          or exists (select 1 from jsonb_array_elements(d.value) r
                      where jsonb_typeof(r) <> 'array' or jsonb_array_length(r) <> 2
                         or (r ->> 0) !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
                         or (r ->> 1) !~ '^([01][0-9]|2[0-4]):[0-5][0-9]$'
                         or (r ->> 0) >= (r ->> 1))))
$$;

create function public.set_business_details(p_area text, p_hours jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare b uuid := (select id from public.businesses where owner_id = (select auth.uid()));
begin
  if b is null then raise exception 'no business' using errcode = 'BZ004'; end if;
  if not public.business_can_manage(b) then raise exception 'this business is suspended' using errcode = 'BZ007'; end if;
  if not public.business_hours_valid(p_hours) then raise exception 'check the opening hours' using errcode = '22023'; end if;
  begin
    update public.businesses set area = nullif(btrim(coalesce(p_area, '')), ''), hours = p_hours where id = b;
  exception when check_violation then raise exception 'check the details' using errcode = '22023';
  end;
end $$;

-- ------------------------------------------------------------------ listings

-- A small, admin-maintained category list (approved 2 Nov 2026; vehicles, property and animals left out on purpose).
create table public.listing_categories (
  id      text primary key check (id ~ '^[a-z][a-z0-9_]{1,40}$'),
  label   text not null,
  kind    text not null check (kind in ('product', 'service')),
  sort    smallint not null default 0,
  active  boolean not null default true
);
insert into public.listing_categories (id, label, kind, sort) values
  ('phones_electronics', 'Phones & electronics', 'product', 10),
  ('computers', 'Computers & accessories', 'product', 20),
  ('fashion', 'Fashion & accessories', 'product', 30),
  ('beauty', 'Beauty & personal care', 'product', 40),
  ('home', 'Home, furniture & appliances', 'product', 50),
  ('food_groceries', 'Food & groceries', 'product', 60),
  ('health_wellness', 'Health & wellness', 'product', 70),
  ('baby_kids', 'Babies & kids', 'product', 80),
  ('sports_outdoors', 'Sports & outdoors', 'product', 90),
  ('vehicle_parts', 'Vehicle parts & accessories', 'product', 100),
  ('books_art', 'Books, art & crafts', 'product', 110),
  ('other_products', 'Other products', 'product', 120),
  ('food_catering', 'Food & catering', 'service', 210),
  ('beauty_services', 'Hair, beauty & grooming', 'service', 220),
  ('events_media', 'Events, photography & media', 'service', 230),
  ('repairs', 'Repairs & maintenance', 'service', 240),
  ('lessons', 'Lessons & tutoring', 'service', 250),
  ('professional', 'Professional services', 'service', 260),
  ('design_tech', 'Design, web & tech', 'service', 270),
  ('delivery', 'Delivery & logistics', 'service', 280),
  ('other_services', 'Other services', 'service', 290);
revoke all on public.listing_categories from anon, authenticated;
grant select on public.listing_categories to authenticated;
alter table public.listing_categories enable row level security;
create policy "Categories are public" on public.listing_categories for select to authenticated using (true);

create table public.listings (
  id                   uuid primary key default gen_random_uuid(),
  business_id          uuid not null references public.businesses (id) on delete cascade,
  kind                 text not null check (kind in ('product', 'service')),
  title                text not null check (char_length(btrim(title)) between 3 and 80),
  description          text not null default '' check (char_length(description) <= 2000),
  category_id          text not null references public.listing_categories (id),
  section              text check (section is null or char_length(btrim(section)) between 1 and 40),
  price_minor          bigint check (price_minor is null or price_minor between 0 and 100000000000),
  currency             text not null default 'NGN' check (currency in ('NGN')),
  price_unit           text not null default 'item' check (price_unit in ('item', 'hour', 'session', 'day', 'from')),
  condition            text check (condition in ('new', 'like_new', 'good', 'fair')),
  status               text not null default 'available' check (status in ('draft', 'available', 'reserved', 'sold', 'removed')),
  area                 text check (area is null or char_length(btrim(area)) between 2 and 60),
  fulfilment           text[] not null default '{}' check (fulfilment <@ array['collection', 'delivery', 'online', 'on_site']),
  delivery_note        text check (delivery_note is null or char_length(delivery_note) <= 300),
  removed_by_admin_at  timestamptz,
  removed_note         text check (removed_note is null or char_length(removed_note) <= 300),
  save_count           integer not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint listings_condition_products check (kind = 'product' or condition is null),
  constraint listings_removed_state check ((removed_by_admin_at is null) or status = 'removed'),
  search               tsvector generated always as (
                         setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
                         setweight(to_tsvector('simple', coalesce(section, '')), 'B') ||
                         setweight(to_tsvector('simple', coalesce(description, '')), 'C')) stored
);
create index listings_browse on public.listings (category_id, created_at desc) where status in ('available', 'reserved');
create index listings_recent on public.listings (created_at desc) where status in ('available', 'reserved');
create index listings_business on public.listings (business_id, status, created_at desc);
create index listings_price on public.listings (price_minor) where status in ('available', 'reserved');
create index listings_search on public.listings using gin (search);
create trigger listings_touch before update on public.listings for each row execute function public.touch_updated_at();
alter table public.listings enable row level security;
revoke all on public.listings from anon, authenticated;
-- Everything but the admin's removal note. (Writes only through the functions below.)
grant select (id, business_id, kind, title, description, category_id, section, price_minor, currency, price_unit, condition,
              status, area, fulfilment, delivery_note, save_count, created_at, updated_at) on public.listings to authenticated;

-- Listed (or sold) by an active business, while the Marketplace is on; the business's own drafts;
-- admins see everything.
create function public.listing_visible(p_status text, p_business uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_admin()
      or (public.feature_enabled('marketplace') and (
            (p_status in ('available', 'reserved', 'sold') and public.business_is_active(p_business))
            or (p_status = 'draft' and public.business_can_manage(p_business))))
$$;
create policy "Listings people can see" on public.listings for select to authenticated
  using (public.listing_visible(status, business_id));

create table public.listing_media (
  listing_id    uuid not null references public.listings (id) on delete cascade,
  position      smallint not null check (position between 0 and 7),
  storage_path  text not null unique check (storage_path ~ '^b/[0-9a-f-]{36}/business_listing/[0-9a-f]{32}\.(jpg|png|webp|gif)$'),
  mime_type     text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'image/gif')),
  width         integer check (width between 1 and 20000),
  height        integer check (height between 1 and 20000),
  alt           text check (alt is null or char_length(alt) <= 300),
  preview       text check (preview is null or char_length(preview) <= 2000),
  primary key (listing_id, position)
);
alter table public.listing_media enable row level security;
revoke all on public.listing_media from anon, authenticated;
grant select on public.listing_media to authenticated;
create policy "Media of listings people can see" on public.listing_media for select to authenticated
  using (exists (select 1 from public.listings l where l.id = listing_id));

-- The business page, now with area, hours and how many listings are open.
drop function public.business_by_handle(text);
create function public.business_by_handle(p_handle text) returns table (
  id uuid, handle text, name text, category text, description text, logo_url text, cover_url text,
  website_url text, contact_email text, contact_phone text, follower_count integer, post_count bigint,
  created_at timestamptz, following boolean, mine boolean, area text, hours jsonb, listing_count bigint)
language sql stable security definer set search_path = '' as $$
  select b.id, b.handle, b.name, b.category, b.description, b.logo_url, b.cover_url,
         b.website_url, b.contact_email, b.contact_phone, b.follower_count,
         (select count(*) from public.posts p where p.business_id = b.id and p.deleted_at is null),
         b.created_at, public.viewer_follows_business(b.id), b.owner_id = (select auth.uid()),
         b.area, b.hours,
         case when public.feature_enabled('marketplace') or public.is_admin()
              then (select count(*) from public.listings l where l.business_id = b.id and l.status in ('available', 'reserved'))
              else 0 end
    from public.businesses b
   where b.handle = lower(p_handle) and (b.status = 'active' or public.is_admin())
$$;

-- Saved listings: private to the person who saved them.
create table public.listing_saves (
  user_id     uuid not null references public.profiles (id) on delete cascade,
  listing_id  uuid not null references public.listings (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, listing_id)
);
create index listing_saves_listing on public.listing_saves (listing_id);
create index listing_saves_recent on public.listing_saves (user_id, created_at desc);
revoke all on public.listing_saves from anon, authenticated;
alter table public.listing_saves enable row level security;

create function public.listing_save_count() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    update public.listings set save_count = save_count + 1 where id = new.listing_id;
  else
    update public.listings set save_count = greatest(save_count - 1, 0) where id = old.listing_id;
  end if;
  return null;
end $$;
create trigger listing_saves_count after insert or delete on public.listing_saves
  for each row execute function public.listing_save_count();

-- Counts for rate limits.
create table public.listing_action_log (
  business_id  uuid references public.businesses (id) on delete cascade,
  user_id      uuid references public.profiles (id) on delete cascade,
  action       text not null check (action in ('create', 'save')),
  created_at   timestamptz not null default now()
);
create index listing_action_log_recent on public.listing_action_log (business_id, action, created_at desc);
create index listing_action_log_user on public.listing_action_log (user_id, action, created_at desc);
revoke all on public.listing_action_log from anon, authenticated;
alter table public.listing_action_log enable row level security;

-- A business post may share one of the business's listings.
alter table public.posts add column listing_id uuid references public.listings (id) on delete set null;
alter table public.posts add constraint posts_listing_business check (listing_id is null or business_id is not null);

-- ----------------------------------------------------------------------- media

alter table public.media_objects
  drop constraint media_objects_purpose_check,
  add constraint media_objects_purpose_check check (purpose in ('avatar', 'post', 'moment', 'dm',
    'business_logo', 'business_cover', 'business_post', 'business_listing'));

create or replace function public.media_begin_upload(p_purpose text, p_mime text, p_size bigint, p_conversation uuid default null, p_business uuid default null)
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
  elsif p_purpose in ('avatar', 'post', 'moment', 'business_logo', 'business_cover', 'business_post', 'business_listing') then
    if p_conversation is not null then raise exception 'not allowed' using errcode = 'MD001'; end if;
    if (p_purpose like 'business_%') <> (p_business is not null)
       or (p_business is not null and not public.business_can_manage(p_business))
       or (p_purpose = 'business_listing' and not (public.feature_enabled('marketplace') or public.is_admin())) then
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

create or replace function public.media_begin_variant(p_original text, p_mime text, p_size bigint) returns text
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  o public.media_objects;
  key text;
begin
  if uid is null then raise exception 'sign in first' using errcode = 'MD001'; end if;
  select * into o from public.media_objects where path = p_original;
  if o.path is null or o.owner_id <> uid or o.variant_of is not null or o.purpose not in ('post', 'moment', 'business_post', 'business_listing')
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

-- Listing photos: your own pending upload for this listing's business.
create function public.listing_media_require_upload() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.storage_path not like 'b/' || (select business_id from public.listings where id = new.listing_id)::text || '/business_listing/%' then
    raise exception 'not this business''s upload' using errcode = 'MD001';
  end if;
  -- A photo the listing already had (attached, this business's) is kept as it is; anything else must be
  -- your own unused upload.
  if public.media_registry_required() and not exists (
       select 1 from public.media_objects o
        where o.path = new.storage_path and o.purpose = 'business_listing' and o.status = 'attached'
          and o.business_id = (select business_id from public.listings where id = new.listing_id)) then
    perform public.media_attach(new.storage_path, 'business_listing');
  end if;
  return new;
end $$;
create trigger listing_media_require_upload before insert on public.listing_media
  for each row execute function public.listing_media_require_upload();

-- Listing photos are readable while the listing is (admins: also while removed, for review).
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
            or (o.purpose = 'business_listing' and exists (
                  select 1 from public.listing_media lm join public.listings l on l.id = lm.listing_id
                   where lm.storage_path = o.path and public.listing_visible(l.status, l.business_id)))
            or (o.purpose = 'moment' and public.moment_media_readable(o.path))
            or (o.purpose = 'dm' and exists (
                  select 1 from public.dm_participants dp
                   where dp.conversation_id = o.conversation_id and dp.user_id = (select auth.uid())))))
$$;

-- Releases a listing's photos (originals; their smaller copies cascade). Internal.
create function public.listing_release_media(p_listing uuid, p_keep text[] default '{}') returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  delete from public.media_objects o
   using public.listing_media lm
   where lm.listing_id = p_listing and o.path = lm.storage_path and o.purpose = 'business_listing'
     and o.variant_of is null and not (lm.storage_path = any (p_keep));
  get diagnostics n = row_count;
  return n;
end $$;

-- ------------------------------------------------------------- writes (owner)

create function public.listing_check(p_kind text, p_category text, p_condition text, p_status text) returns void
language plpgsql stable set search_path = '' as $$
begin
  if not exists (select 1 from public.listing_categories c where c.id = p_category and c.kind = p_kind and c.active) then
    raise exception 'choose a category for this kind of listing' using errcode = 'MK002';
  end if;
  if p_kind = 'service' and p_condition is not null then
    raise exception 'services have no condition' using errcode = 'MK002';
  end if;
  if p_status not in ('draft', 'available', 'reserved', 'sold') then
    raise exception 'invalid status' using errcode = 'MK002';
  end if;
end $$;

-- Replaces a listing's photos with p_media ([{storage_path, mime_type, width, height, alt, preview}], up to 8).
-- Photos no longer used are released; new ones must be this business's own unused uploads.
create function public.listing_put_media(p_listing uuid, p_media jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  item jsonb;
  i integer := 0;
  keep text[];
begin
  if jsonb_typeof(coalesce(p_media, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_media, '[]'::jsonb)) > 8 then
    raise exception 'at most 8 photos' using errcode = 'MK002';
  end if;
  select coalesce(array_agg(value ->> 'storage_path'), '{}') into keep from jsonb_array_elements(coalesce(p_media, '[]'::jsonb));
  -- Photos left out are released; the rest are written again in the new order.
  perform public.listing_release_media(p_listing, keep);
  delete from public.listing_media where listing_id = p_listing;
  for item in select value from jsonb_array_elements(coalesce(p_media, '[]'::jsonb)) loop
    begin
      insert into public.listing_media (listing_id, position, storage_path, mime_type, width, height, alt, preview)
      values (p_listing, i, item ->> 'storage_path', item ->> 'mime_type', (item ->> 'width')::integer, (item ->> 'height')::integer,
              nullif(btrim(coalesce(item ->> 'alt', '')), ''), nullif(item ->> 'preview', ''));
    exception
      when check_violation then raise exception 'check the photos' using errcode = 'MK002';
      when unique_violation then raise exception 'that photo is already used' using errcode = 'MK002';
    end;
    i := i + 1;
  end loop;
end $$;

create function public.create_listing(
  p_kind text, p_title text, p_description text, p_category text, p_price_minor bigint,
  p_price_unit text default 'item', p_condition text default null, p_section text default null,
  p_area text default null, p_fulfilment text[] default '{}', p_delivery_note text default null,
  p_status text default 'available', p_media jsonb default '[]'::jsonb)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  b public.businesses;
  new_id uuid;
begin
  if uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  if not (public.feature_enabled('marketplace') or public.is_admin()) then
    raise exception 'the Marketplace isn''t available yet' using errcode = 'MK001';
  end if;
  select * into b from public.businesses where owner_id = uid;
  if b.id is null then raise exception 'create a business page first' using errcode = 'MK001'; end if;
  if not public.business_can_manage(b.id) then raise exception 'this business is suspended' using errcode = 'BZ007'; end if;
  if public.is_suspended(uid) then raise exception 'account suspended' using errcode = 'AS001'; end if;
  perform public.listing_check(p_kind, p_category, p_condition, p_status);
  if (select count(*) from public.listing_action_log l where l.business_id = b.id and l.action = 'create' and l.created_at > now() - interval '1 day') >= 20 then
    raise exception 'slow down: at most 20 new listings a day' using errcode = 'RL001';
  end if;
  if (select count(*) from public.listings l where l.business_id = b.id and l.status in ('draft', 'available', 'reserved')) >= 200 then
    raise exception 'at most 200 open listings' using errcode = 'RL001';
  end if;
  begin
    insert into public.listings (business_id, kind, title, description, category_id, section, price_minor, price_unit,
                                 condition, status, area, fulfilment, delivery_note)
    values (b.id, p_kind, btrim(p_title), btrim(coalesce(p_description, '')), p_category, nullif(btrim(coalesce(p_section, '')), ''),
            p_price_minor, coalesce(p_price_unit, 'item'), p_condition, p_status,
            coalesce(nullif(btrim(coalesce(p_area, '')), ''), b.area), coalesce(p_fulfilment, '{}'), nullif(btrim(coalesce(p_delivery_note, '')), ''))
    returning listings.id into new_id;
  exception when check_violation then raise exception 'check the details' using errcode = 'MK002';
  end;
  perform public.listing_put_media(new_id, p_media);
  insert into public.listing_action_log (business_id, user_id, action) values (b.id, uid, 'create');
  delete from public.listing_action_log where created_at < now() - interval '1 day';
  return new_id;
end $$;

-- The listing, if it's yours to change (not removed by Amigo).
create function public.listing_require_mine(p_listing uuid) returns public.listings
language plpgsql security definer set search_path = '' as $$
declare l public.listings;
begin
  select * into l from public.listings where id = p_listing;
  if l.id is null or not exists (select 1 from public.businesses b where b.id = l.business_id and b.owner_id = (select auth.uid())) then
    raise exception 'no such listing' using errcode = 'MK003';
  end if;
  if not public.business_can_manage(l.business_id) then raise exception 'this business is suspended' using errcode = 'BZ007'; end if;
  if l.removed_by_admin_at is not null then raise exception 'this listing was removed by Amigo' using errcode = 'MK004'; end if;
  return l;
end $$;

create function public.update_listing(
  p_listing uuid, p_kind text, p_title text, p_description text, p_category text, p_price_minor bigint,
  p_price_unit text, p_condition text, p_section text, p_area text, p_fulfilment text[], p_delivery_note text,
  p_status text, p_media jsonb)
returns void
language plpgsql security definer set search_path = '' as $$
declare l public.listings := public.listing_require_mine(p_listing);
begin
  perform public.listing_check(p_kind, p_category, p_condition, p_status);
  begin
    update public.listings
       set kind = p_kind, title = btrim(p_title), description = btrim(coalesce(p_description, '')), category_id = p_category,
           section = nullif(btrim(coalesce(p_section, '')), ''), price_minor = p_price_minor, price_unit = coalesce(p_price_unit, 'item'),
           condition = p_condition, area = nullif(btrim(coalesce(p_area, '')), ''), fulfilment = coalesce(p_fulfilment, '{}'),
           delivery_note = nullif(btrim(coalesce(p_delivery_note, '')), ''), status = p_status
     where id = l.id;
  exception when check_violation then raise exception 'check the details' using errcode = 'MK002';
  end;
  if p_media is not null then perform public.listing_put_media(l.id, p_media); end if;
end $$;

create function public.set_listing_status(p_listing uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare l public.listings := public.listing_require_mine(p_listing);
begin
  if p_status not in ('draft', 'available', 'reserved', 'sold') then raise exception 'invalid status' using errcode = 'MK002'; end if;
  update public.listings set status = p_status where id = l.id;
end $$;

-- Deletes your listing and releases its photos. Not one Amigo removed (kept for review).
create function public.delete_listing(p_listing uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare l public.listings := public.listing_require_mine(p_listing);
begin
  perform public.listing_release_media(l.id);
  delete from public.listings where id = l.id;
end $$;

-- Your business's listings, every status (for Manage Business).
create function public.my_listings() returns setof public.listings
language sql stable security definer set search_path = '' as $$
  select l.* from public.listings l join public.businesses b on b.id = l.business_id
   where b.owner_id = (select auth.uid())
   order by l.updated_at desc
   limit 500
$$;

-- ------------------------------------------------------------- reads (everyone)

-- Marketplace search: words (prefix match), category, kind, price range, area, condition, sort.
-- Only available and reserved listings from active businesses, while the Marketplace is on.
create function public.search_listings(
  p_query text default '', p_category text default null, p_kind text default null,
  p_min_price bigint default null, p_max_price bigint default null, p_area text default null,
  p_condition text default null, p_business uuid default null, p_sort text default 'newest',
  p_limit integer default 30, p_offset integer default 0)
returns table (id uuid, business_id uuid, business_handle text, business_name text, business_logo text,
               kind text, title text, category_id text, section text, price_minor bigint, currency text, price_unit text,
               condition text, status text, area text, cover_path text, cover_preview text, save_count integer,
               saved boolean, created_at timestamptz, updated_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare
  q tsquery;
  words text[];
begin
  if not (public.feature_enabled('marketplace') or public.is_admin()) then return; end if;
  -- Each word becomes a prefix term: "red sho" matches "red shoes".
  words := array(select w from regexp_split_to_table(lower(left(coalesce(p_query, ''), 100)), '[^[:alnum:]]+') w where w <> '' limit 8);
  if cardinality(words) > 0 then
    q := to_tsquery('simple', array_to_string(array(select quote_literal(w) || ':*' from unnest(words) w), ' & '));
  end if;
  return query
    select l.id, l.business_id, b.handle, b.name, b.logo_url, l.kind, l.title, l.category_id, l.section, l.price_minor, l.currency,
           l.price_unit, l.condition, l.status, l.area,
           (select m.storage_path from public.listing_media m where m.listing_id = l.id order by m.position limit 1),
           (select m.preview from public.listing_media m where m.listing_id = l.id order by m.position limit 1),
           l.save_count,
           exists (select 1 from public.listing_saves s where s.listing_id = l.id and s.user_id = (select auth.uid())),
           l.created_at, l.updated_at
      from public.listings l join public.businesses b on b.id = l.business_id
     where l.status in ('available', 'reserved') and b.status = 'active'
       and (q is null or l.search @@ q)
       and (p_category is null or l.category_id = p_category)
       and (p_kind is null or l.kind = p_kind)
       and (p_min_price is null or l.price_minor >= p_min_price)
       and (p_max_price is null or l.price_minor <= p_max_price)
       and (p_area is null or btrim(p_area) = '' or l.area ilike '%' || replace(replace(replace(btrim(p_area), '\', '\\'), '%', '\%'), '_', '\_') || '%')
       and (p_condition is null or l.condition = p_condition)
       and (p_business is null or l.business_id = p_business)
     order by
       case when p_sort = 'price_asc' then l.price_minor end asc nulls last,
       case when p_sort = 'price_desc' then l.price_minor end desc nulls last,
       case when p_sort = 'relevance' and q is not null then ts_rank(l.search, q) end desc,
       case when p_sort = 'updated' then l.updated_at end desc,
       l.created_at desc, l.id
     limit least(greatest(coalesce(p_limit, 30), 1), 60)
    offset least(greatest(coalesce(p_offset, 0), 0), 600);
end $$;

-- One listing with everything its page shows; null if you can't see it.
create function public.listing_view(p_listing uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
           'listing', to_jsonb(l) - 'search' - 'removed_note' - 'removed_by_admin_at',
           'removed_by_admin', l.removed_by_admin_at is not null,
           'business', jsonb_build_object('id', b.id, 'handle', b.handle, 'name', b.name, 'logo_url', b.logo_url,
                                          'category', b.category, 'area', b.area, 'website_url', b.website_url,
                                          'contact_email', b.contact_email, 'contact_phone', b.contact_phone,
                                          'status', b.status),
           'media', coalesce((select jsonb_agg(jsonb_build_object('storage_path', m.storage_path, 'mime_type', m.mime_type,
                                     'width', m.width, 'height', m.height, 'alt', m.alt, 'preview', m.preview) order by m.position)
                                from public.listing_media m where m.listing_id = l.id), '[]'::jsonb),
           'saved', exists (select 1 from public.listing_saves s where s.listing_id = l.id and s.user_id = (select auth.uid())),
           'mine', b.owner_id = (select auth.uid()))
    from public.listings l join public.businesses b on b.id = l.business_id
   where l.id = p_listing
     and (public.listing_visible(l.status, l.business_id)
          or (b.owner_id = (select auth.uid()) and (public.feature_enabled('marketplace') or public.is_admin())))
$$;

create function public.listing_category_list() returns table (id text, label text, kind text)
language sql stable security definer set search_path = '' as $$
  select c.id, c.label, c.kind from public.listing_categories c where c.active order by c.sort, c.label
$$;

-- --------------------------------------------------------------------- saves

create function public.save_listing(p_listing uuid, p_save boolean) returns integer
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  if p_save then
    if not exists (select 1 from public.listings l where l.id = p_listing and l.status in ('available', 'reserved', 'sold')
                     and public.listing_visible(l.status, l.business_id)) then
      raise exception 'no such listing' using errcode = 'MK003';
    end if;
    if (select count(*) from public.listing_action_log a where a.user_id = uid and a.action = 'save' and a.created_at > now() - interval '1 hour') >= 200 then
      raise exception 'slow down' using errcode = 'RL001';
    end if;
    insert into public.listing_saves (user_id, listing_id) values (uid, p_listing) on conflict do nothing;
    if found then insert into public.listing_action_log (user_id, action) values (uid, 'save'); end if;
  else
    delete from public.listing_saves where user_id = uid and listing_id = p_listing;
  end if;
  return (select save_count from public.listings where id = p_listing);
end $$;

-- Your saved listings, newest first, including ones since sold (shown as sold).
create function public.my_saved_listings() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select s.listing_id from public.listing_saves s join public.listings l on l.id = s.listing_id
   where s.user_id = (select auth.uid()) and public.listing_visible(l.status, l.business_id)
   order by s.created_at desc
   limit 500
$$;

-- ---------------------------------------------------------- business posts

-- Business posts can share one of the business's own open listings.
drop function public.create_business_post(text, jsonb);
create function public.create_business_post(p_body text, p_media jsonb default '[]'::jsonb, p_listing uuid default null) returns uuid
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
  if body = '' and media_count = 0 and p_listing is null then raise exception 'a post needs text or media' using errcode = '22023'; end if;
  if char_length(body) > 500 then raise exception 'posts are limited to 500 characters' using errcode = '22001'; end if;
  if media_count > 4 then raise exception 'at most 4 media items per post' using errcode = '22023'; end if;
  if p_listing is not null and not exists (
       select 1 from public.listings l where l.id = p_listing and l.business_id = b.id and l.status in ('available', 'reserved')
          and (public.feature_enabled('marketplace') or public.is_admin())) then
    raise exception 'share one of your open listings' using errcode = 'MK003';
  end if;
  if (select count(*) from public.posts p where p.business_id = b.id and p.created_at > now() - interval '10 minutes') >= 10 then
    raise exception 'slow down: too many posts' using errcode = 'RL001';
  end if;
  if (select count(*) from public.posts p where p.business_id = b.id and p.created_at > now() - interval '1 day') >= 50 then
    raise exception 'daily post limit reached' using errcode = 'RL001';
  end if;
  insert into public.posts (author_id, business_id, body, visibility, listing_id) values (null, b.id, body, 'public', p_listing)
  returning posts.id into new_post;
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

-- ------------------------------------------------------- reports and moderation

alter table public.content_reports
  drop constraint content_reports_target_type_check,
  add constraint content_reports_target_type_check check (target_type in ('post', 'profile', 'world', 'business', 'listing')),
  drop constraint content_reports_reason_check,
  add constraint content_reports_reason_check check (reason in ('spam', 'harassment', 'inappropriate', 'prohibited', 'other'));

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
  elsif p_type = 'listing' then
    -- One you can see, not your own business's.
    if not exists (select 1 from public.listings l join public.businesses b on b.id = l.business_id
                    where l.id = p_target and b.owner_id <> uid and l.status in ('available', 'reserved', 'sold')
                      and public.listing_visible(l.status, l.business_id)) then
      raise exception 'nothing to report' using errcode = 'RP001';
    end if;
  else
    raise exception 'nothing to report' using errcode = 'RP001';
  end if;
  if p_reason = 'prohibited' and p_type <> 'listing' then raise exception 'invalid report' using errcode = 'RP001'; end if;
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

-- Admins see listing reports too (the business behind it, and who runs it).
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
             when 'listing' then 'Listing'
             else 'World' end,
           case r.target_type
             when 'post' then left(po.body, 500)
             when 'profile' then left(coalesce(pr.display_name, '') || ' — ' || coalesce(pr.bio, ''), 500)
             when 'business' then left(coalesce(bz.name, '') || ' — ' || coalesce(bz.description, ''), 500)
             when 'listing' then left(coalesce(li.title, '') || ' — ' || coalesce(li.description, ''), 500)
             else left(coalesce(w.title, '') || ' — ' || coalesce(w.description, ''), 500) end,
           coalesce(po.author_id, pb.owner_id, bz.owner_id, lb.owner_id, pr.id),
           coalesce(pa.username, pbo.username, bzo.username, lbo.username, pr.username),
           case r.target_type
             when 'post' then po.id is null or po.deleted_at is not null
             when 'business' then bz.id is null or bz.status <> 'active'
             when 'listing' then li.id is null or li.status = 'removed'
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
      left join public.listings li on r.target_type = 'listing' and li.id = r.target_id
      left join public.businesses lb on lb.id = li.business_id
      left join public.profiles lbo on lbo.id = lb.owner_id
      left join public.worlds w on r.target_type = 'world' and w.id = r.target_id
     where p_status = 'all' or r.status = p_status
     order by r.created_at desc
     limit 300;
end $$;

-- Removes a listing for everyone (the business can't edit, relist or delete it); photos are kept for review.
create function public.admin_remove_listing(p_listing uuid, p_note text default '') returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.support_require_admin();
  t text;
begin
  update public.listings set status = 'removed', removed_by_admin_at = now(), removed_note = nullif(left(btrim(coalesce(p_note, '')), 300), '')
   where id = p_listing and removed_by_admin_at is null
  returning title into t;
  if t is null then raise exception 'no such listing' using errcode = 'SP005'; end if;
  update public.content_reports set status = 'reviewed', reviewed_by = uid, reviewed_at = now()
   where target_type = 'listing' and target_id = p_listing and status = 'open';
  perform public.admin_log('listing.remove', 'listing', p_listing, format('removed listing "%s"%s', left(t, 80), coalesce(' — ' || nullif(btrim(p_note), ''), '')));
end $$;

-- Puts a removed listing back (as a draft the business can review).
create function public.admin_restore_listing(p_listing uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare t text;
begin
  perform public.support_require_admin();
  update public.listings set status = 'draft', removed_by_admin_at = null, removed_note = null
   where id = p_listing and removed_by_admin_at is not null
  returning title into t;
  if t is null then raise exception 'not a removed listing' using errcode = 'SP005'; end if;
  perform public.admin_log('listing.restore', 'listing', p_listing, format('restored listing "%s" as a draft', left(t, 80)));
end $$;

create function public.admin_listings(p_status text default 'all', p_query text default '') returns table (
  id uuid, title text, status text, kind text, category_id text, price_minor bigint, currency text,
  business_id uuid, business_handle text, business_name text, owner_username text,
  removed_note text, open_reports bigint, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.support_require_admin();
  return query
    select l.id, l.title, l.status, l.kind, l.category_id, l.price_minor, l.currency, b.id, b.handle, b.name, pr.username,
           l.removed_note,
           (select count(*) from public.content_reports r where r.target_type = 'listing' and r.target_id = l.id and r.status = 'open'),
           l.created_at
      from public.listings l join public.businesses b on b.id = l.business_id join public.profiles pr on pr.id = b.owner_id
     where (p_status = 'all' or l.status = p_status)
       and (coalesce(btrim(p_query), '') = '' or l.title ilike '%' || replace(replace(replace(btrim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%'
            or b.handle ilike '%' || replace(replace(replace(btrim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%')
     order by l.created_at desc
     limit 300;
end $$;

-- ---------------------------------------------------------------- grants

revoke execute on function
  public.feature_enabled(text), public.enabled_features(), public.admin_set_feature(text, boolean),
  public.business_can_manage(uuid), public.business_hours_valid(jsonb), public.set_business_details(text, jsonb),
  public.business_by_handle(text),
  public.listing_save_count(), public.listing_visible(text, uuid), public.listing_media_require_upload(),
  public.listing_release_media(uuid, text[]), public.listing_check(text, text, text, text), public.listing_put_media(uuid, jsonb),
  public.create_listing(text, text, text, text, bigint, text, text, text, text, text[], text, text, jsonb),
  public.listing_require_mine(uuid),
  public.update_listing(uuid, text, text, text, text, bigint, text, text, text, text, text[], text, text, jsonb),
  public.set_listing_status(uuid, text), public.delete_listing(uuid), public.my_listings(),
  public.search_listings(text, text, text, bigint, bigint, text, text, uuid, text, integer, integer),
  public.listing_view(uuid), public.listing_category_list(), public.save_listing(uuid, boolean), public.my_saved_listings(),
  public.create_business_post(text, jsonb, uuid),
  public.admin_remove_listing(uuid, text), public.admin_restore_listing(uuid), public.admin_listings(text, text)
from public, anon, authenticated;
grant execute on function
  public.enabled_features(), public.admin_set_feature(text, boolean), public.set_business_details(text, jsonb),
  public.business_by_handle(text),
  public.create_listing(text, text, text, text, bigint, text, text, text, text, text[], text, text, jsonb),
  public.update_listing(uuid, text, text, text, text, bigint, text, text, text, text, text[], text, text, jsonb),
  public.set_listing_status(uuid, text), public.delete_listing(uuid), public.my_listings(),
  public.search_listings(text, text, text, bigint, bigint, text, text, uuid, text, integer, integer),
  public.listing_view(uuid), public.listing_category_list(), public.save_listing(uuid, boolean), public.my_saved_listings(),
  public.create_business_post(text, jsonb, uuid),
  public.admin_remove_listing(uuid, text), public.admin_restore_listing(uuid), public.admin_listings(text, text)
to authenticated;
-- Used by row-security policies, which run as the caller.
grant execute on function public.listing_visible(text, uuid), public.feature_enabled(text), public.business_can_manage(uuid) to authenticated;
