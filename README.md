# Amigo World

A social network for posts, moments and conversations with your people.

This is the Phase 1 rebuild: a new design system, app shell and Home feed on top of
the prototype's existing Firebase project. Accounts, posts, likes, replies and the
follow graph from the prototype keep working.

## Running it

```bash
npm install
npm run dev        # real Firebase project (amigo-world-ebfab)
npm run dev:demo   # in-memory demo data, no Firebase reads/writes
npm run build      # typecheck + production build → dist/
```

To preview UI states in demo mode, add `?demo=loading`, `?demo=empty`, `?demo=error`,
`?demo=slow` or `?demo=signedout` to the URL.

Deploys on Vercel use `vercel.json` (Vite preset, `dist/`, SPA rewrites).

## Stack

- Vite + React 19 + TypeScript, React Router
- Firebase Auth (email/password) and Cloud Firestore through the modular SDK
- Plain CSS with design tokens. No CSS framework.
- Self-hosted variable fonts: Geist (UI text), Bricolage Grotesque (display)
- Icons: lucide-react

## Structure

```
src/
  data/          backend boundary — screens never touch Firestore directly
    types.ts         normalized models + DataSource interface
    legacy.ts        adapters for every post shape the prototype ever wrote
    firebaseSource.ts
    demoSource.ts    used only when VITE_DATA_SOURCE=demo
  state/         session, theme, toasts, composer
  ui/            primitives: Button, Avatar, Sheet, Skeleton, StateMessage, Brand
  features/      posts (card, media, viewer), composer, feed
  shell/         AppShell (sidebar / bottom nav / rail), ScreenHeader
  screens/       Home, Post, Profile, Auth, placeholders
  styles/        tokens.css, base.css
legacy/          the prototype's index.html, kept for reference (not built)
```

## Design system

- **Accent:** Amigo Coral `#FF5A3C`, with dark ink `#1D0A05` on top of it. It is the
  only brand colour. Use it for primary actions, active likes and the focus ring.
- **Neutrals:** warm off-white (`#F8F7F4`) in light mode, near-black (`#0C0C0E`) in
  dark mode. Follows the OS setting, with a manual override in Profile.
- **Type:** Geist at 15px for UI and body text. Bricolage Grotesque for the wordmark,
  screen titles, empty states and "statement" posts (short text-only posts set large).
- **Shape:** rounded rectangles (12–16px). Pills only for transient floating chips.
- **Layout:** under 768px, a single full-width column with a bottom tab bar. From
  768px, a compact icon sidebar. From 1200px, a labelled sidebar, a 620px column
  and a suggestions rail.
- **Rules:** no decorative emoji, glows, gradients or floating ornaments in the UI
  chrome. Content carries the colour.

## Data model (unchanged Firestore schema)

| Path | Used for |
| --- | --- |
| `posts/{id}` | `text, authorId, authorName, createdAt, reactions{heart,…}, reacted{heart:[uid]}, commentsCount, imageDataUrl` (+ `imageWidth/imageHeight` from the new composer) |
| `posts/{id}/comments/{id}` | replies |
| `users/{uid}` | `displayName, avatarUrl, updatedAt` (old docs also have `email, mood, xp, streak`) |
| `users/{uid}/following/{uid}`, `users/{uid}/followers/{uid}` | follow graph |
| `globalChat/{id}` | prototype's public chat room. Not shown in the new UI yet; data is untouched. |

The ❤️ reaction is the like. Other legacy reactions are kept but not shown.
