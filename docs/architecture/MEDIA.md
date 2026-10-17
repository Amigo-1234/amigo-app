# Media: images today, video later

## Model

A post carries an **ordered array** of media (`Post.media: MediaItem[]`), backed by
`post_media` rows: `position`, `kind` (`image` | `video`), `bucket`, `storage_path`, `mime_type`,
`width`, `height`, `duration_ms`, `byte_size` and `alt`. The composer creates
`NewPostInput.media: NewMediaInput[]` (processed blobs, never base64). The backend uploads them
to Storage, then `create_post()` writes the post and all its media rows in one transaction.

**Per-post limit:** `DataSource.maxMediaPerPost`. Supabase allows **4**: `post_media.position` is
constrained to 0–3 and `create_post()` rejects more. The legacy Firebase format holds 1. The
rendering already handles any count (5+ shows a "+N" tile).

> **Raising the limit to e.g. 10** needs a small migration: relax the `position` check and the
> `create_post()` guard, then set `maxMediaPerPost: 10`. Nothing else changes. Not done without
> approval.

## Images (shipped)

Client-side, in [`src/lib/image.ts`](../../src/lib/image.ts):

| Step | Rule |
| --- | --- |
| Accept | JPEG, PNG, WebP, GIF (AVIF/BMP where the browser decodes them). HEIC/HEIF is refused with an "export as JPEG" message, since most browsers can't decode it. |
| Input limit | 25 MB per file |
| Resize | Longest edge ≤ 2048 px, high-quality smoothing, EXIF orientation applied |
| Re-encode | JPEG quality 0.85, stepping down to 0.6 and then smaller dimensions only if over 3 MB |
| Metadata | Re-encoding through a canvas drops all EXIF/XMP, including GPS location |
| Transparency | Placed on white, because JPEG has no alpha |
| GIF | Passed through untouched (keeps animation) up to 8 MB; metadata is not stripped |

**Layout** ([`PostMedia.tsx`](../../src/features/posts/PostMedia.tsx)) is shared by every screen
and by the composer preview:

- 1 image: its own aspect ratio, clamped 4:5–1.91:1.
- 2, 3 or 4 images: a fixed 4:3 frame (no layout jump).
- 5 or more: 2×2 with "+N".

The shared viewer pages through all of a post's media with buttons, ← / →, swipe, Esc to close,
and focus returned to the tile.

**Storage:** `post-media/<uid>/<uuid>.<ext>`, public-read, owner-only writes (see DATABASE.md).

## Video (not built yet): what it needs

Video can be added without changing posts again: `kind: 'video'` already exists, and
`MediaItem` has `posterUrl` and `durationMs`. What's missing:

1. **Upload**
   - Phone videos are 50 MB–1 GB. Use resumable uploads (Supabase Storage supports TUS) with
     progress and pause/resume, not a single `upload()` call.
   - Raise the `post-media` file-size limit or use a separate `post-video` bucket.
   - Proposed limits: 2 minutes, 500 MB raw.
2. **Transcoding**
   - Never serve raw uploads: they come in HEVC/ProRes, odd rotations and huge bitrates.
   - Transcode server-side to H.264/AAC MP4 at 720p and 1080p, ideally with HLS for adaptive
     streaming. Options: a worker running ffmpeg, triggered by a Storage webhook, or a managed
     service (Mux, Cloudflare Stream).
   - Track `status` (`processing` | `ready` | `failed`) on the media row. The post shows a
     "processing" state until it's ready.
3. **Thumbnails:** extract a poster frame during transcoding (or client-side from a `<video>`
   frame for an instant preview), store it next to the video, and fill `poster_path` (new column)
   and `duration_ms`.
4. **Playback**
   - In feeds: muted, inline, and only when visible (`IntersectionObserver`), never more than one
     at a time; `preload="metadata"`; respect reduced motion and data saver.
   - In the viewer: sound and controls.
   - Captions later (WebVTT next to the video).
5. **Moderation and cost:** egress dominates (a 1-minute 1080p video is ~15–30 MB per view).
   CDN caching, adaptive bitrate and per-user upload quotas matter before launch.
6. **Schema delta (when approved):** `post_media.status`, `poster_path`, maybe `variants jsonb`
   (rendition URLs), plus storage policies for the new bucket.

## Neon deployment: Cloudflare R2 (built; needs the owner to configure)

Decision (owner, 2026-10-17): Cloudflare R2 instead of Vercel Blob. Neon stays the database.

**Checked 2026-10-17** (Cloudflare docs via search and recent reports; the Cloudflare site itself
couldn't be fetched from this environment):
- Free tier, Standard storage: 10 GB-month, 1M Class A (writes/lists) and 10M Class B (reads)
  operations a month, **no egress fees**. Above that: about $0.015/GB-month, $4.50 per million
  Class A, $0.36 per million Class B.
- **Turning on R2 asks for a payment method**, because usage above the free tier is billed with
  no hard cap (recent Cloudflare Community reports). Billing alerts are recommended.
- Buckets are private unless public access (r2.dev or a custom domain) is switched on — leave it off.
- Presigned URLs: valid 1 second to 7 days, made locally (no R2 call), and can be locked to a
  Content-Type. Browser uploads need a bucket CORS rule.

**How it works here**
- `media_objects` (migration `20261017170000_media_registry.sql`): Postgres approves each upload
  (`media_begin_upload`: purpose, type, size, 60 uploads/hour, 1 GB/day, conversation membership,
  suspension) and chooses the key `<owner>/<purpose>/[<conversation>/]<random>.<ext>`.
- `api/media-upload` signs a **PUT valid 10 minutes for exactly that key, type and length**.
- `api/media/<key>` asks `media_can_read` **as the viewer** (post visibility, Moment audience and
  expiry, conversation membership) and redirects to a **GET valid 1 hour** (`Cache-Control: private`).
  Missing and forbidden both answer 404. Works for `<img>` via the first-party session cookie.
- Attaching: posts, Moments and avatars can only use your own unused upload of the right purpose.
- Deleting a Moment, a replaced avatar or an account queues files; each upload call deletes a few.
- **Message photos are encrypted on the device first**; the bucket only holds ciphertext.
- Limits: images 10 MB (avatars 5 MB), video 50 MB (posts/Moments; UI for video not built yet),
  encrypted attachments 50 MB.

**Owner setup (about 10 minutes)**
1. Cloudflare dashboard → R2 → enable (add a payment method) → **Create bucket** (e.g. `amigo-media`,
   location hint Western Europe). Do **not** enable public access.
2. Bucket → Settings → CORS policy:
   `[{"AllowedOrigins":["https://amigo-app-git-claude-amigo-worl-d67e9b-amigos-projects-73fa05d5.vercel.app"],"AllowedMethods":["PUT","GET"],"AllowedHeaders":["content-type"],"MaxAgeSeconds":3600}]`
   (add the production domain later).
3. R2 → Manage API tokens → **Create token**: permission *Object Read & Write*, **only this bucket**.
4. Vercel → amigo-app → Settings → Environment Variables (Preview): `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
   `R2_SECRET_ACCESS_KEY` (mark Sensitive), `R2_BUCKET`, and `VITE_MEDIA_STORAGE` = `r2`. Redeploy.
5. Optional: Cloudflare billing notification at, say, $1.

Until then the functions answer 503 and the app stays text-only — nothing breaks.

Tests: `npm run test:media` (local PostgREST + S3 emulator, 24 checks: authorization, quotas,
followers-only and Moment visibility, DM membership, cleanup, and an encrypted photo message that
the recipient decrypts while the bucket holds only ciphertext). Signature enforcement itself
(exact type/size, expiry) is R2's and is verified only once a real bucket exists.
