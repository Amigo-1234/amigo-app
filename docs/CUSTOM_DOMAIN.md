# amigoworld.com.ng — custom domain

Status (2026-10-20): added to the Vercel project (apex serves the app; `www` redirects to the apex with
a 308) and to Neon Auth's trusted domains. **Not live yet:** DNS at HostAfrica still points both names
at the old host (`102.218.215.41`). `https://amigo-app-one.vercel.app` keeps working throughout and is
not redirected.

## 1. HostAfrica DNS (owner, in the HostAfrica dashboard)

Nameservers stay as they are (`dan1`–`dan4.host-ww.net`). Change only these two records:

| Type | Host / Name | Value | TTL | Replaces |
|---|---|---|---|---|
| A | `@` (amigoworld.com.ng) | `76.76.21.21` | 3600 (or lowest offered) | the existing A record `102.218.215.41` |
| CNAME | `www` | `cname.vercel-dns.com` | 3600 | any existing A / CNAME record for `www` (currently resolves to `102.218.215.41`) |

- Delete the old `@` A record (`102.218.215.41`) rather than keeping both — two A records would send
  some visitors to the old host. If an AAAA record exists for `@` or `www`, delete it too.
- Leave **MX, TXT (SPF/DKIM/DMARC) and every other record unchanged** — they carry the domain's email.
- **The current site on `102.218.215.41` stops being reachable at amigoworld.com.ng** once these change.
  If anything there must stay online (e.g. a holding page, a mail webmail address), keep a copy or move it
  to a subdomain first.

Vercel issues the HTTPS certificate automatically once the records resolve (usually minutes, up to the old
TTL). I'll re-check propagation and HTTPS when you say the records are in.

## 2. Cloudflare R2 (owner) — photo uploads from the new domain

R2 → the media bucket → Settings → CORS policy: add `https://amigoworld.com.ng` to `AllowedOrigins`
(keep the existing Vercel origins), same methods (`PUT`, `GET`), headers (`content-type`). Without this,
photo uploads on the new domain fail (everything else works).

## 3. Optional

- `VITE_NEON_DATA_API_ORIGINS` (Vercel env) and the Data API's CORS list: add the new origin to let it
  call Neon directly; without it the app uses its own `/neon` proxy (works, one extra hop).
- Google sign-in: uses Neon's shared Google credentials (works on any trusted domain). If you later add
  your own Google OAuth client, its redirect URI must include the Neon Auth callback for this domain.

## Already checked in the app

- Sign-in, sign-up, email verification and password-reset links, Google redirect, share/copy links and
  the `/neon` proxy all use the address the page was opened on (`location.origin`) — nothing hard-coded,
  so they work on both domains.
- `og:image` is relative; once the domain is live it will be made absolute (social previews need a full
  URL), with `og:url`/canonical pointing at amigoworld.com.ng.

## Encrypted messages — why nobody is moved yet

Browser storage is per address. On amigoworld.com.ng each person's browser starts with **no** encryption
keys: it registers as a **new device** and goes through the same set-up / approval as any new device.
Nothing is reset or deleted — the keys and device records made on
amigo-app-one.vercel.app stay valid there. So:

1. After DNS is live: test sign-in, new-device approval and messaging on the new domain (test accounts).
2. Only then point people at the new address (no automatic redirect from the Vercel address until then).
