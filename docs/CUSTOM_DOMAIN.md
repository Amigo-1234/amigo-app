# amigoworld.com.ng — official address

Status (2026-10-20, checked against production by the `domain*`, `transition` and `push` suites of
`.github/workflows/live-interactions.yml`, temporary accounts only):

| Area | State |
|---|---|
| DNS / HTTPS | Live. `@` A → 76.76.21.21, `www` CNAME → cname.vercel-dns.com; certificate issued; HSTS 2 years |
| Redirects | `www.` and `http://` → `https://amigoworld.com.ng`, 308, path and query kept |
| Old address | `amigo-app-one.vercel.app` still serves the app, **no redirect** (on purpose, see below) |
| Neon Auth | Trusted origin added; sign-up / Google start from other websites refused (403) |
| Sign-up, sign-in, session, sign-out, password reset | Work on the new address (Chromium + WebKit); session cookie is host-only, Secure, HttpOnly; signing in on the old address unaffected |
| Email verification / password reset | Codes, not links — independent of the address |
| Google | Starts and reaches Google's sign-in (Neon's shared credentials; callback on Neon's host, then back to the new address). Completing a Google sign-in needs a real Google account: *check by hand* |
| Messages | Work on the new address; moving from the old address works (new device, emoji approval from the old device, history decrypts, both directions) |
| Push / live sync / likes | Work on the new address |
| **Photos (posts, Moments, avatars, message photos)** | **Broken on the new address until R2 CORS is updated (below)** |
| Neon Data API CORS | New origin added (only used if a build lists it in `VITE_NEON_DATA_API_ORIGINS`; otherwise the `/neon` proxy is used) |

## Owner action 1 — Cloudflare R2 CORS (required for photos)

Photos upload straight from the browser to the private R2 bucket (the one in the `R2_BUCKET` Vercel
variable, shared by Production and Preview). Measured from the new address: the upload preflight is
refused (403, no `Access-Control-Allow-Origin`) and the browser blocks every upload.

Cloudflare dashboard → R2 → that bucket → **Settings → CORS policy → Edit**. Keep every existing entry
and add `https://amigoworld.com.ng` to `AllowedOrigins`, so the rule reads:

```json
[
  {
    "AllowedOrigins": [
      "https://amigo-app-one.vercel.app",
      "https://amigo-app-git-claude-amigo-worl-d67e9b-amigos-projects-73fa05d5.vercel.app",
      "https://amigoworld.com.ng"
    ],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["content-type"],
    "MaxAgeSeconds": 3600
  }
]
```

(If the existing policy differs, only add the new origin — don't remove anything.) `PUT` is the signed
upload, `GET` is reading encrypted message photos by script; `content-type` is the only request header
the app sends. No `www` entry is needed (it redirects). Then run the `domain-media` suite to confirm.

## Owner action 2 — later, when moving people over

- Vercel → Production env: `VITE_PUBLIC_ORIGIN=https://amigoworld.com.ng` makes shared post/profile
  links use the official address; `VITE_NEON_DATA_API_ORIGINS` += `,https://amigoworld.com.ng` saves a
  proxy hop there; `VAPID_SUBJECT` can become `https://amigoworld.com.ng` (push contact). Each needs a
  production deployment to take effect.
- Optional: a custom SMTP sender in Neon Auth so emails come from Amigo World, not "Neon Auth".

## Encrypted messages and the move

Browser storage is per address, so on amigoworld.com.ng each browser is a **new messaging device**:
Messages shows "Confirm it's you" until one of the person's existing devices approves it (compare emoji)
— tested end to end. With message backup on, older messages decrypt there after approval; without it,
only new messages do (unless they use "I can't use my other devices" with their recovery key, which
**resets** their messaging identity — not something to push people into). Nothing is reset or deleted by
the move itself; existing devices keep working.

So: no automatic redirect from the old address yet. Before moving people: have them turn on message
backup (Settings → Message backup), then sign in on the new address and approve it from their current
device. Seen in testing: a waiting old device that was in the background picked up the approval request
only when reopened (it checks at once when shown) — tell people to open the app on their old device to
approve.

## Already in the code (branch / Preview, not yet in production)

`index.html`: canonical (`https://amigoworld.com.ng` + path), `og:url`, absolute `og:image`;
`public/sitemap.xml` (public pages) + `Sitemap:` in robots.txt; manifest `id` / `scope`; share links
through `publicUrl()` (VITE_PUBLIC_ORIGIN when set). Sign-in, reset, Google redirect, `/neon` proxy and
cookies use the page's own address — nothing else is tied to a domain.
