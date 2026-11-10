# Legal documents 0.2: review checklist

Status (10 Nov 2026): **drafts for review, not published.** Production serves version 0.1 of all
seven documents. Nothing in this folder is loaded by the app.

## Publishing rule

- **Terms 0.2 and Privacy 0.2 are published together**, as a material change that every account must
  accept. Publishing one without the other contradicts the minimum age (the 0.1 Terms say 13; the
  0.2 documents say 18).
- The app's sign-up already asks "I'm 18 or older" (commit `c52338f`). The maintenance gate must stay
  on until both documents are published, so no member of the public meets that wording against the
  0.1 Terms.
- Publishing means copying each approved file to `src/legal/docs/<slug>-0.2.md`, deploying, and
  registering the version in Admin → Legal on Production. Each step needs the owner's approval.

## Documents

| Document | File | What changes from 0.1 | Open items |
| --- | --- | --- | --- |
| Terms of Service | `terms-0.2.md` | Operator named; adults only (18+); under-18 handling; Help Hub wording; contact | Governing law, courts and any mediation step **[LEGAL REVIEW]**; postal address, if required **[OWNER/LEGAL]** |
| Privacy Policy | `privacy-0.2.md` | Operator named; 18+ confirmation; reservations; business pages and listings; full provider list (Vercel, Neon, Resend, Cloudflare R2 and Turnstile, push services); retention | Legal bases under the NDPA 2023 **[LEGAL REVIEW]**; transfer basis **[LEGAL REVIEW]** |
| Community Guidelines | `guidelines-0.2.md` | Help Hub and Kudos wording | None marked |
| Copyright | `copyright-0.2.md` | Contact filled in | Counter-notice procedure and any agent registration **[LEGAL REVIEW]** |
| Account Deletion and Retention | `deletion-0.2.md` | Contact filled in | Backup and log windows **[OWNER]**; audit-log retention period **[OWNER]**; retention and legal hold **[LEGAL REVIEW]** |
| Monetization Programme Terms | `monetization-0.2.md` | States clearly that no one can earn money yet | Full programme terms before any payments **[OWNER/LEGAL]** |
| Cookie and Tracking Notice | stays `0.1` (`src/legal/docs/cookies-0.1.md`) | No age or operator content; no change needed | None |

## Decisions already made (owner, 2 Nov 2026)

Operator: Muftau Idris, an individual. Privacy contact: the address in the drafts. Minimum age 18,
self-declared at every entry point; no ID documents or date of birth. Under-18 accounts: suspend,
then delete after about 14 days' notice. Reservations: 180-day hold, renewable in the final 30 days,
deleted 30 days after ending.

## Before publishing

1. Lawyer review of every **[LEGAL REVIEW]** item above.
2. Owner fills in every **[OWNER]** item.
3. Owner approves the final texts.
4. Publish Terms and Privacy together (material change), then the others.
