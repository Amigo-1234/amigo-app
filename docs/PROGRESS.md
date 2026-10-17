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
- **Onboarding**: a skippable welcome card on Home with people to follow, first post, profile setup, and links to Worlds and Support Hub.
- **Legal (drafts v0.1)**: 7 documents at `/legal`, versioned; acceptance recorded at registration; re-acceptance gate.
- **Creator monetization**: architecture only, programme closed; users see "Creator monetization is coming soon."
- **Account deletion**: password re-check plus typed confirmation; cascades through all owned data.

## Blockers / owner decisions
- **Vercel**: deployments are readable again (calls must omit the team id); the latest commit is READY on the branch preview. **Opening the protected preview from here still fails (403 on the protection bypass)** — the owner must re-authorize the Vercel connector for the "amigo's projects" team (claude.ai → Settings → Connectors → Vercel → reconnect, select the team), or add a Protection Bypass for Automation secret.
- **Media storage → Cloudflare R2**: owner configured the bucket, CORS, bucket-scoped token and 5 Preview env vars (verified by name/scope/type, 2026-10-17); preview redeployed READY. **Not yet verified live** — needs `VERCEL_AUTOMATION_BYPASS_SECRET` as a GitHub repository secret, then `scripts/test/live-media.test.mjs` runs via `.github/workflows/live-media.yml`.
- **Legal drafts**: `[OWNER: …]` placeholders cover entity, address, contact, governing law and minimum age (drafted as 13). Needs legal review.
- ~~Test-account cleanup~~ **Done 2026-10-17** (owner-approved): 14 test accounts removed after re-verification; 3 real accounts and their data untouched.
- **No admin account yet**: admin is granted to the owner's account only after identity is confirmed.

## Next
1. Once R2 is configured: live test of uploads (post photos, avatars, photo Moments, encrypted DM photos), then video posts and voice notes.
2. Voice notes after media. **GIFs are blocked:** Tenor's API shut down on 2026-06-30. GIPHY's free key is reportedly a beta key (about 100 calls/hour); production needs an application and possibly payment, and searches may have to come from the user's browser, which exposes their IP to GIPHY. An owner decision and key are needed, and GIF URLs in encrypted chats would be external, unencrypted media.
3. Per-page sharing previews (needs a small server function).
4. Live re-test on Neon for the new DM actions, with two dedicated accounts, then remove them.

## Notes
- After a migration, refresh the Data API schema once by re-saving its config. This causes about a minute of failed requests.
- Don't use SQLSTATE codes starting with `PT`: PostgREST treats them as HTTP statuses.
- Live tests run from temporary GitHub Actions workflows, removed after use.

_Last updated 2026-10-17._
