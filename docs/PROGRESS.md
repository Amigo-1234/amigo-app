# Amigo World — progress

Branch `claude/amigo-world-restart-7mrbrf` · Neon project `amigo-world` (Free) · Vercel preview only. `main` and Firebase production untouched.

## Done
- **Neon foundation**: schema built from the Supabase migrations (`scripts/neon/build-schema.mjs`), Neon Auth via same-origin Edge proxy (`api/neon.ts`), Data API direct from the preview origin.
- **Auth & Settings**: instant session sync, branded loader, code-based email verification and password reset, settings without fake controls.
- **Encrypted messages**: Matrix crypto (vodozemac via matrix-sdk-crypto-wasm), ciphertext only on the server. Pulse-driven updates, idempotent send. Live: send p50 175 ms, delivery p50 623 ms.
- **Legal (drafts v0.1)**: Terms, Privacy, Guidelines, Copyright, Monetization, Deletion/Retention, Cookies at `/legal`. Versioned in `legal_documents`; acceptance recorded at registration (`legal_acceptances`, version + timestamp); re-acceptance gate for material changes; admin publishing.
- **Creator monetization (closed)**: criteria, applications, review, status, fraud flags — admin-configured, no thresholds or payouts defined. Users see "Creator monetization is coming soon."
- **Account deletion**: Settings → requires password re-entry (fresh session ≤10 min) and typing DELETE; cascades through all owned data.

## Blockers / owner decisions
- Legal drafts contain `[OWNER: …]` placeholders (entity name, address, contact, governing law, minimum age — drafted as 13). Need owner + legal review before launch.
- Media storage (photos, video, voice notes, Moments) not built yet: Vercel Blob evaluation pending (Neon Object Storage unavailable in eu-west-2).
- Test-account cleanup prepared in `neon/ops/cleanup-test-accounts.sql` (14 explicit ids, guarded). **Not executed — awaiting confirmation.**
- No admin account yet: the owner's account is granted admin only after identity is confirmed.

## Next (priority order)
1. Media service (Vercel Blob, authorised access, encrypted DM attachments).
2. Premium DM features (reactions, edit/unsend, reply, emoji, voice/photo, search, older history).
3. Moments on Neon with server expiry; moderation (suspension, reports everywhere).
4. Post interactions (bookmark, edit, report, share); PWA, SEO/OG, onboarding.
5. Neon security audit; launch-readiness report.

## Notes
- After any migration, refresh the Data API schema by re-saving its config (once; ~1 min of failed requests while it restarts).
- Live tests run from temporary GitHub Actions workflows, removed after use.

_Last updated 2026-10-17._
