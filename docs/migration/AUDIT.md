# Firebase audit (October 2026)

Read-only audit of the legacy Firebase project `amigo-world-ebfab`, made with
`npm run migrate:extract -- --source rest` and `npm run migrate:audit`.
Nothing was written to Firebase.

## Collections

The new app (Phase 1) and the prototype only ever touched these paths:

| Path | Docs | Purpose | Migrated to |
| --- | ---: | --- | --- |
| `users/{uid}` | 8 | profile: `displayName`, `email`, `avatarUrl` (+ `mood`, `xp`, `streak` on 2 old docs) | `auth.users` + `profiles` |
| `users/{uid}/following/{uid}` | 17 | `followedAt` | `follows` |
| `users/{uid}/followers/{uid}` | 17 | mirror of the above (identical edge set) | `follows` (deduplicated) |
| `posts/{id}` | 32 | posts, 11 different field shapes | `posts`, `post_media`, `post_likes` |
| `posts/{id}/comments/{id}` | 18 | replies, 2 shapes | `posts` with `parent_id` |
| `globalChat/{id}` | 54 | public chat room, still active (latest message Aug 2026) | `legacy.global_chat_archive` (private) |

Listing *all* root collections needs Admin credentials. The admin extractor
records the full list and flags any collection it doesn't migrate.

## Post formats found in production

Some of these were written by code that isn't in this repository (another app may be
writing to the same Firebase project):

| Field | Variants |
| --- | --- |
| author id | `authorId` (24) · `userId` (7) · `uid` (1) |
| author name | `authorName` · `displayName` · `name` |
| created | Firestore timestamp (31) · **epoch number** (1) |
| text | `text` (one is empty but has an image) |
| image | `imageDataUrl` as an inline base64 PNG/JPEG (6, 99–894 KB) · `imageUrl: null` · `image: ""` |
| reply count | `commentsCount` · `commentCount` |
| likes | `reacted.heart: uid[]` + `reactions.heart: n` · `likes: uid[]` · `likes: n` (counter only) |
| other reactions | `reacted.{lol,wow,cry,fire}: uid[]`, top-level `fire`/`lol`/`cry` counters |
| saves | `savedBy: uid[]` (7 posts) |
| misc | `category` (all 32; old UI tabs) · `avatar: number` (pravatar index) |

Comments: `{authorId, authorName, createdAt, text}` (15) and `{userId, displayName, createdAt, text}` (3).

## Identities

- **15 distinct uids** are referenced anywhere; only **8** have a `users/{uid}` doc.
- The other 7 appear only as post/comment/chat authors or likers. Their email exists only in
  Firebase Auth, which needs an Admin export.
- No passwords can be carried over (see [AUTH.md](AUTH.md)).

## Data quality

- Comments whose post is missing: 0. Declared comment counts match the actual comments: yes.
- Follow edges: 17 on each mirrored side, identical, no self-follows.
- **Likes:** 32 have a user id and can migrate. **25 exist only as counters** with no user id
  (`likes: n`, or `reactions.heart` larger than the uid list). These can't become like rows
  and are reported as not migrated.

## Security findings

1. **Public reads:** `posts` and `users` can be read without authentication through the REST
   API. `users` docs include **email addresses**, so they're exposed to anyone.
2. Collection listing is correctly denied (admin-only).
3. **How the legacy app depends on `users`** (from `app.js` / `friend.js` on the live site):
   - The Friends page reads the **whole** `users` collection (`getDocs`) to build the
     following, followers and suggestion lists and the search, and re-writes the signed-in
     person's email into their own doc on every login.
   - The feed and chat (`app.js`) open their Firestore listeners **at page load, before
     sign-in**, so they need anonymous read on `posts`, `comments` and `globalChat`.
4. **Fix (prepared, applied with the Admin credentials):** [`firebase/firestore.rules`](../../firebase/firestore.rules)
   - `users/*` becomes **owner-only**. Emails are no longer readable by anyone else.
   - Follow lists are readable when signed in, and written only by the person acting.
   - Posts, comments and chat keep their current read behaviour, so the legacy feed keeps
     working. They hold no emails.
   - Deployed with `npm run firebase:rules deploy`, which backs up the live rules, runs a
     20-case test suite through Google's rules tester, and refuses to deploy if Firestore has
     collections the rules don't cover. Rollback: `npm run firebase:rules rollback <previous>`.
   - **Impact:** on the old site, the Friends page lists and search come up empty. Following
     and unfollowing still work. Nothing else changes. The migration uses the Admin SDK and
     isn't affected.

## What is deliberately not migrated

| Data | Why | Where it goes instead |
| --- | --- | --- |
| `users.email` | private; belongs in Auth only | `auth.users.email` |
| `mood`, `xp`, `streak` | prototype mock features, local-only in practice | dropped |
| `avatarUrl` (all null), `avatar` (pravatar index) | placeholder images, not user content | dropped |
| `category` | old UI tab concept | `legacy.post_map.raw_meta` |
| lol/wow/cry/fire reactions | no product equivalent yet | `legacy.reaction_archive` |
| `savedBy` | bookmarks don't exist yet | `legacy.saved_post_archive` |
| `globalChat` | public room ≠ future private Messages | `legacy.global_chat_archive` |
| counter-only likes | no user id to attach | reported |
| password hashes | Firebase scrypt can't be imported | lazy re-verification / reset |
