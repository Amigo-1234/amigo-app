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
- **Legal (drafts v0.1)**: 7 documents at `/legal`, versioned; acceptance recorded at registration; re-acceptance gate.
- **Creator monetization**: architecture only, programme closed; users see "Creator monetization is coming soon."
- **Account deletion**: password re-check plus typed confirmation; cascades through all owned data.

## Blockers / owner decisions
- **Vercel access**: the Vercel connection now gets 403 on the team scope, so deployments can't be confirmed from here. The preview is behind Vercel Authentication. The owner should reconnect Vercel, or confirm deployments in the dashboard.
- **Media storage** (photos, video, voice, photo Moments, avatars): Vercel Blob was evaluated (`docs/architecture/MEDIA.md`). Hobby limits are unverified and no store exists yet. Needs owner approval and store creation.
- **Legal drafts**: `[OWNER: …]` placeholders cover entity, address, contact, governing law and minimum age (drafted as 13). Needs legal review.
- **Test-account cleanup**: prepared in `neon/ops/cleanup-test-accounts.sql` (14 explicit ids, guarded). **Not executed; awaiting confirmation.**
- **No admin account yet**: admin is granted to the owner's account only after identity is confirmed.

## Next
1. Media service, once approved: upload and read functions, encrypted DM attachments, avatars, multi-image posts, photo Moments.
2. Voice notes and GIFs (GIF provider terms to be checked first), after media.
3. PWA manifest and icons, SEO/OG tags, onboarding, privacy-safe analytics.
4. Live re-test on Neon for the new DM actions, with two dedicated accounts, then remove them.

## Notes
- After a migration, refresh the Data API schema once by re-saving its config. This causes about a minute of failed requests.
- Don't use SQLSTATE codes starting with `PT`: PostgREST treats them as HTTP statuses.
- Live tests run from temporary GitHub Actions workflows, removed after use.

_Last updated 2026-10-17._
