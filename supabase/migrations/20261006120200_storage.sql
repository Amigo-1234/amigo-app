-- =============================================================================
-- Storage
--
--   post-media  images/videos attached to posts   <uid>/<uuid>.<ext>
--   avatars     profile pictures                  <uid>/<uuid>.<ext>
--
-- Both buckets are public-read: post media belongs to public posts and is
-- served from the CDN by URL. Object listing is NOT public (no broad select
-- policy), so files can't be enumerated. Writes are limited to the uploader's
-- own top-level folder, whose name must equal their auth uid.
--
-- When followers-only posts ship, their media should move to a private bucket
-- served through signed URLs.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('post-media', 'post-media', true, 52428800,
    array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime']),
  ('avatars', 'avatars', true, 5242880,
    array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy "Upload into your own folder"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id in ('post-media', 'avatars')
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Needed by the Storage API for delete/overwrite, and lets people list their own uploads.
create policy "Read your own folder"
  on storage.objects for select
  to authenticated
  using (
    bucket_id in ('post-media', 'avatars')
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "Replace files in your own folder"
  on storage.objects for update
  to authenticated
  using (
    bucket_id in ('post-media', 'avatars')
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id in ('post-media', 'avatars')
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "Delete files in your own folder"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id in ('post-media', 'avatars')
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
