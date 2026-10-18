# Amigo World — progress

Branch `claude/amigo-world-restart-7mrbrf` · Neon project `amigo-world` (Free) · Vercel preview only. `main` and Firebase production untouched.
Launch status: see [LAUNCH_READINESS.md](LAUNCH_READINESS.md).

## Done
- **Neon foundation**: schema built from the Supabase migrations (`scripts/neon/build-schema.mjs`), Neon Auth through a same-origin Edge proxy (`api/neon.ts`), Data API called directly from the preview origin. The Data API refuses every request without a sign-in token.
- **Auth & Settings**: instant session sync, branded loader, email verification and password reset by code, no fake controls.
- **Encrypted messages**: Matrix crypto (vodozemac via matrix-sdk-crypto-wasm); the server holds ciphertext only. Pulse-driven updates and idempotent send. Live latency: send p50 175 ms, delivery p50 623 ms.
- **Messages, round 2**: encrypted reactions (quick + emoji picker, double-tap ❤️), edit within 15 minutes, unsend for everyone (server deletes the ciphertext), swipe to reply, long-press menu, copy, report one message, on-device search, load earlier messages.
- **Moments on Neon**: text-on-background only; expiry enforced by the database, with an expired-row sweep on each new post.
- **Moderation**: account suspension enforced by the database; reports for posts, replies, profiles and Worlds; admin queue with takedown, suspend and restore; audit log.
- **Post tools**: bookmarks (private), edit (marked edited), delete, copy link, report; Bookmarks screen.
- **Safety**: database rate limits that only stop floods (RL001). Blocking removes follows both ways and prevents re-following; you can block from posts and profiles, and see blocked accounts in Settings. Admins can warn people (shown until acknowledged) and see aggregate platform stats. Worlds can be reported.
- **PWA / sharing**: a minimal service worker (offline page only; no data, messages or keys cached), install prompt or iPhone steps in Settings, generic OG tags, robots.txt, security headers.
- **Messages, round 3**: typing indicators on Neon without Realtime, and delivered receipts fixed (they were never sent).
- **Reliability**: crash screens instead of blank pages; privacy-safe error reports (redacted, unlinked) with an admin summary.
- **Messages on mobile**: long-press menu fixed (it closed on finger lift), reply cleared when its message is unsent; iPhone-profile touch test 12/12.
- **Media service (R2)**: Postgres decides every upload and read; signed links (10 min upload for exact type/size, 1 h read); encrypted DM photos stored as ciphertext; client wired for posts, avatars, photo Moments and DM photos behind `VITE_MEDIA_STORAGE=r2`.
- **Media live-verified (2026-10-17, preview `a0a0a52`)** via `.github/workflows/live-media.yml` (runs when `.github/live-media.run` changes; uses the `VERCEL_AUTOMATION_BYPASS_SECRET` repo secret):
  - API, real R2 + Neon (31 checks): signature enforces exact type and size, private bucket, CORS allows only the app, followers-only and Moment visibility, no reuse of others' uploads, avatar, Moment deletion removes the file, encrypted DM photo round trip (ciphertext only), outsiders refused, cleanup verified.
  - iPhone 13 browser (Chromium): legal gate, photo post with "Posting…" on a slow network, offline failure → saved with Retry → posts when back online, profile picture after reload, photo Moment, no horizontal scroll, no page errors, cleanup verified.
  - Fixed on the way: upload links could be refused right after sign-up (retry once in `api/media-upload`); uploads now time out after 3 minutes instead of spinning forever.
  - Test accounts are deleted even when tests fail (re-sign-in before deletion; an 8-minute deadline). Two accounts left by one interrupted run were removed by exact id.
- **Onboarding**: a skippable welcome card on Home with people to follow, first post, profile setup, and links to Worlds and Support Hub.
- **Legal (drafts v0.1)**: 7 documents at `/legal`, versioned; acceptance recorded at registration; re-acceptance gate.
- **Creator monetization**: architecture only, programme closed; users see "Creator monetization is coming soon."
- **Account deletion**: password re-check plus typed confirmation; cascades through all owned data.
- **Performance & stability (2026-10-18, on production as `dpl_9xexuvhTA3HASvJ5wd5QRE6cg9Hs`, commit `0efd9e8`)**: first paint on 3G 9.5 → 4.0 s, warm feed on 4G 3.0 → 1.3 s, screen revisits ~0.1 s, idle traffic −60 %, message delivery p50 ~0.85 s; resilient posting/messaging offline; privacy-safe perf monitoring. Load test: 100 simulated users, p95 85 ms, 0 errors. Details: [PERFORMANCE.md](PERFORMANCE.md).

## Blockers / owner decisions
- **Production (2026-10-17, owner-authorized)**: `https://amigo-app-one.vercel.app` serves the redesigned app on Neon + R2 (deployment `dpl_2be8nDqcHjFxZYt3qujfNkYorUYo`, commit `e223f1a`, deployed from this branch; `main` not merged). Legacy rollback: Vercel instant rollback to `dpl_BLQeNsTyyeeSUgpZSyvnAR62AuaS` (`main` @ `d344bac`); Firebase untouched. A push to `main` would redeploy the legacy app to production. The owner added the production domain to the R2 CORS rule; the production smoke test (`.github/workflows/prod-smoke.yml`) passes in full, including photo uploads and encrypted chat photos. Current production: `dpl_9xexuvhTA3HASvJ5wd5QRE6cg9Hs` (commit `0efd9e8`); the legacy rollback above is unchanged.
- **Vercel**: deployments are readable again (calls must omit the team id); the latest commit is READY on the branch preview. **Opening the protected preview from here still fails (403 on the protection bypass)** — the owner must re-authorize the Vercel connector for the "amigo's projects" team (claude.ai → Settings → Connectors → Vercel → reconnect, select the team), or add a Protection Bypass for Automation secret.
- ~~Media storage → Cloudflare R2~~ **Live-verified 2026-10-17** (see Done). For production: add the production domain to the bucket CORS rule and set the R2 variables for Production.
- **Legal drafts**: `[OWNER: …]` placeholders cover entity, address, contact, governing law and minimum age (drafted as 13). Needs legal review.
- ~~Test-account cleanup~~ **Done 2026-10-17** (owner-approved): 14 test accounts removed after re-verification; 3 real accounts and their data untouched.
- **No admin account yet**: admin is granted to the owner's account only after identity is confirmed.

## Next
1. Drive an encrypted message photo through the browser UI in the live test; then video posts and voice notes.
2. Voice notes after media. **GIFs are blocked:** Tenor's API shut down on 2026-06-30. GIPHY's free key is reportedly a beta key (about 100 calls/hour); production needs an application and possibly payment, and searches may have to come from the user's browser, which exposes their IP to GIPHY. An owner decision and key are needed, and GIF URLs in encrypted chats would be external, unencrypted media.
3. Per-page sharing previews (needs a small server function).
4. Live re-test on Neon for the new DM actions, with two dedicated accounts, then remove them.

## Notes
- After a migration, refresh the Data API schema once by re-saving its config. This causes about a minute of failed requests.
- Don't use SQLSTATE codes starting with `PT`: PostgREST treats them as HTTP statuses.
- Live tests run from temporary GitHub Actions workflows, removed after use.

_Last updated 2026-10-18._
