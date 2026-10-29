-- =============================================================================
-- How a photo Moment is framed, where its caption sits, and a blurred preview
-- (additive; existing Moments keep the defaults)
--
-- The author frames the photo before sharing: "cover" fills the screen,
-- "contain" shows the whole photo over a blurred copy of itself; zoom (1–4)
-- and a focus point (x, y in 0–1 of the photo) pick what stays in view. The
-- caption's vertical position (text_y, 0–1 of the screen) keeps it off the
-- subject. The same rules apply on every screen size, so the important part
-- of the photo stays visible on short and tall phones alike.
-- =============================================================================

alter table public.moments
  add column photo_fit text not null default 'cover' check (photo_fit in ('cover', 'contain')),
  add column photo_zoom real not null default 1 check (photo_zoom between 1 and 4),
  add column photo_x real not null default 0.5 check (photo_x between 0 and 1),
  add column photo_y real not null default 0.5 check (photo_y between 0 and 1),
  add column text_y real not null default 0.5 check (text_y between 0.08 and 0.92),
  add column media_preview text
    check (media_preview is null or (char_length(media_preview) <= 2000 and media_preview ~ '^data:image/(webp|jpeg|png);base64,[A-Za-z0-9+/=]+$'));

grant select (photo_fit, photo_zoom, photo_x, photo_y, text_y, media_preview) on public.moments to authenticated;

-- p_layout: { "fit": "cover"|"contain", "zoom": 1–4, "x": 0–1, "y": 0–1, "textY": 0.08–0.92 } (all optional).
drop function public.create_moment(text, text, text, int, int, text);
create function public.create_moment(
  p_body text, p_background text, p_media_path text, p_media_width int, p_media_height int, p_audience text,
  p_layout jsonb default null, p_preview text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  mid uuid;
  l jsonb := coalesce(p_layout, '{}'::jsonb);
begin
  if uid is null then raise exception 'sign in first' using errcode = 'MO003'; end if;
  if p_media_path is not null and split_part(p_media_path, '/', 1) <> uid::text then
    raise exception 'photo must be in your own folder' using errcode = 'MO003';
  end if;
  if (select count(*) from public.moments where author_id = uid and created_at > now() - interval '24 hours') >= 30 then
    raise exception 'too many Moments today' using errcode = 'MO004';
  end if;
  begin
    insert into public.moments (author_id, body, background, media_path, media_width, media_height, audience,
                                photo_fit, photo_zoom, photo_x, photo_y, text_y, media_preview)
    values (uid, btrim(coalesce(p_body, '')), coalesce(p_background, 'coral'), p_media_path, p_media_width, p_media_height, coalesce(p_audience, 'everyone'),
            coalesce(l ->> 'fit', 'cover'),
            coalesce((l ->> 'zoom')::real, 1),
            coalesce((l ->> 'x')::real, 0.5),
            coalesce((l ->> 'y')::real, 0.5),
            coalesce((l ->> 'textY')::real, 0.5),
            case when p_media_path is null then null else nullif(p_preview, '') end)
    returning id into mid;
  exception when check_violation or invalid_text_representation then
    raise exception 'invalid Moment' using errcode = 'MO001';
  end;
  return mid;
end $$;

drop function public.moments_feed();
create function public.moments_feed() returns table (
  id uuid, author_id uuid, body text, background text, media_path text, media_width int, media_height int,
  audience text, created_at timestamptz, expires_at timestamptz, seen boolean, my_reaction text, view_count int,
  photo_fit text, photo_zoom real, photo_x real, photo_y real, text_y real, media_preview text)
language sql stable security definer set search_path = '' as $$
  select m.id, m.author_id, m.body, m.background, m.media_path, m.media_width, m.media_height, m.audience, m.created_at, m.expires_at,
         m.author_id = (select auth.uid()) or exists (select 1 from public.moment_views v where v.moment_id = m.id and v.viewer_id = (select auth.uid())),
         (select r.emoji from public.moment_reactions r where r.moment_id = m.id and r.user_id = (select auth.uid())),
         case when m.author_id = (select auth.uid()) then (select count(*)::int from public.moment_views v where v.moment_id = m.id) end,
         m.photo_fit, m.photo_zoom, m.photo_x, m.photo_y, m.text_y, m.media_preview
  from public.moments m
  where m.removed_at is null and m.expires_at > now() and public.moment_visible(m.id)
  order by m.created_at
  limit 1000
$$;

revoke execute on function public.create_moment(text, text, text, int, int, text, jsonb, text), public.moments_feed() from public, anon;
grant execute on function public.create_moment(text, text, text, int, int, text, jsonb, text), public.moments_feed() to authenticated;
