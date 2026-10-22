# Amigo World sign-in emails (verification, password reset)

## Today

Neon Auth (Managed Better Auth) sends them with its **shared** provider: sender "Neon Auth"
`<auth@mail.myneon.app>`, Neon's template; application name "Amigo World" (renamed from "amigo-world" on 2026-10-21, owner-approved). Codes are 6 digits
(Better Auth email OTP); verification is offered but not required to use the app.
Neon's docs call the shared provider development-only.

## The change (built, not active)

Neon's documented customisation path: a **webhook** for `send.otp` and `send.magic_link`. When it is
enabled, Neon still generates, stores, expires and checks every code (and keeps its rate limits) — it
only stops sending its own email and POSTs the code to us; we send the branded email.

- `api/auth-email.ts` — verifies Neon's Ed25519 signature (JWKS by key id) and a 5-minute timestamp
  window; drops duplicates (event id, and Resend's Idempotency-Key); answers 502 on a provider failure
  so Neon retries (3 attempts within 15 s; if all fail the person sees an error and can ask for a new
  code); 503 if not configured. Logs event type and outcome only — never codes, links or payloads.
- `api/_authEmail.ts` — the emails: verification code, password-reset code, sign-in code, and link
  variants (email verification / change, reset). No images, web fonts, scripts or tracking; plain-text
  twin; code as one copyable string **in the body only** (never in the subject or inbox preview line);
  the expiry shown is Neon's own (its expiry minus its issue time in the event — 15 minutes today),
  or "expires soon" if Neon doesn't send one.
- Provider: **Resend** (free: 3,000 emails/month, 100/day; Pro $20/month for 50,000). Neon's own
  example uses it; idempotency keys stop double sends.
- Tests: `npm run test:auth-email` (offline, 43 checks); workflow suites `email-dns` and `email-send`.

Because Preview and production share one Neon Auth branch, enabling the webhook switches **both** at
once. Turning it off restores Neon's own emails immediately.

## DNS at HostAfrica (current state, checked 2026-10-21)

- Apex TXT: `v=spf1 +a +mx +include:spf.host-ww.net +include:spf.antispamcloud.com ip4:169.255.59.142 ~all`
  (HostAfrica's) — **leave it as it is**.
- Apex MX: none. DMARC: none. Nothing under `send.` or `resend._domainkey`.

Records to **add** (none replaced; Resend uses the `send` subdomain, so the apex SPF is untouched and
there is never a second SPF on one name). Copy the exact values from Resend's Domains page:

| Type | Host (HostAfrica "Name") | Value | Priority / TTL |
|---|---|---|---|
| MX | `send` | `feedback.forge.rmta.net` (as Resend showed — its own network, not Amazon SES) | 10 / 3600 |
| TXT | `send` | `v=spf1 ip4:52.3.252.119 ip4:44.222.39.36 ip4:199.249.231.0/24 ~all` (as Resend showed) | 3600 |
| TXT | `resend._domainkey` | `p=MIGf…` — the full DKIM key Resend shows, exactly | 3600 |
| TXT | `_dmarc` | `v=DMARC1; p=none;` (published) | 3600 |

Enter only the host part (`send`, `resend._domainkey`, `_dmarc`) — HostAfrica adds `.amigoworld.com.ng`.
No quotes unless the form requires them; paste the DKIM key in one piece. DMARC starts at `p=none`
(monitor); after a few weeks of passing mail it can move to `p=quarantine`.

## Steps

1. Owner: Resend account (free) → Domains → Add `amigoworld.com.ng`, region **eu-west-1 (Ireland)** (done; verified 2026-10-22).
2. Owner: add the four records above at HostAfrica; Resend → Verify. Then run suite `email-dns`
   (`EXPECT=resend` happens in `email-send`).
3. Owner: Resend → API keys → **Sending access, domain amigoworld.com.ng only**. Add it as
   `RESEND_API_KEY` in Vercel (Production + Preview, Sensitive) and as a GitHub repository secret;
   `EMAIL_FROM=Amigo World <no-reply@amigoworld.com.ng>` in Vercel.
4. Test: suite `email-send` with `test_to` = an inbox you can read (Gmail, Outlook): check inbox vs
   spam and that SPF, DKIM and DMARC pass in the message headers.
5. With approval: deploy the handler to production; then Neon Console → Auth → Configuration →
   **Webhooks**: URL `https://amigoworld.com.ng/api/auth-email`, events `send.otp` and
   `send.magic_link`, timeout 5 s. Immediately: sign up / reset with a real inbox; wrong and expired
   codes; resend.
6. Rollback at any time: disable the webhook (Neon's own emails resume).

