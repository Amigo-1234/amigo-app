# Search appearance (Google)

- `public/robots.txt`: crawlable = homepage, `/legal`, and what Google needs to show and render them
  (`/assets/`, `/icons/`, `/favicon*`, `/manifest.webmanifest`, `/sitemap.xml`). Every signed-in screen,
  `/api` and `/neon` stay disallowed. (Before 2026-10-26 the icons and app scripts were blocked too, so
  Google showed a generic globe and could not render the page.)
- Favicons, all from the official mark `public/favicon.svg`: `favicon.ico` (16/32/48), `icons/favicon-48.png`,
  `-96.png`, `-192.png` (rendered with Chromium, transparent corners), plus the SVG. Apple touch icon and app
  icons use the same mark.
- `vercel.json`: `/icons/*` and `/favicon*` are not rewritten to the app, so a missing icon is a real 404.
- `index.html`: description (meta and Open Graph) "Amigo World is a social app for sharing posts and Moments,
  joining Worlds, and chatting with your people in end-to-end encrypted messages."; canonical
  `https://amigoworld.com.ng/`; JSON-LD `Organization` (name, url, logo `icons/icon-512.png`) and `WebSite`
  (name, url) only.
- Check any deployment: workflow suite `seo-probe` with `base` (read-only, as Googlebot).

## Production (2026-10-27)

Commit `5b6f733` deployed as `dpl_FHbbdWDLC2eFySt9Ccczj5GYrQ6x` (rollback: `dpl_E7G4JxJu79WG7SdYuR5bXZXbWZr1`,
commit `1776e32`). `seo-probe` on https://amigoworld.com.ng: no issues — no noindex header or tag; favicon.ico
and the 48/96/192 PNGs served as images and crawlable; missing icons 404; description, canonical and JSON-LD as
above; sitemap and manifest crawlable; 13 private paths still disallowed; signed-out Data API requests for
messages, conversations, notifications, profiles, posts and admins are refused (400). Email handler probe passed.
Google's result (icon, snippet) updates on Google's schedule; check in Search Console.
