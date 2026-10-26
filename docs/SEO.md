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
