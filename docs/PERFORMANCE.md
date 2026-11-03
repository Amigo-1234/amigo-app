# Performance & stability — before / after (2026-10-18)

Scope: make the existing app feel instant and recover from bad networks, without new features,
new paid services, a provider/region change, or any change to encryption, auth or access rules.

## How it was measured

- **Browser audit** (`scripts/test/perf-audit.mjs`, `.github/workflows/perf.yml`): Chromium as a
  Pixel 5 with 4× CPU slowdown, three networks — `fast` (runner's own), `ng-4g` (150 ms,
  4 Mbps), `ng-3g` (400 ms, 400 kbps). Temporary accounts, deleted afterwards.
- **Load test** (`scripts/test/load-test.mjs`, `.github/workflows/load.yml`): simulated people
  doing feed, profile, notifications, inbox, Moments, likes and posts with background polling,
  60 s per level, against the live Neon Data API from a US GitHub runner.
- **Database**: `pg_stat_statements` (installed in the private `admin_private` schema).
- Baseline = production before this work. After = Preview with the same Neon database, then
  production again after the deploy (2026-10-18, deployment `dpl_9xexuvhTA3HASvJ5wd5QRE6cg9Hs`).

## Bottlenecks found

1. **1.9 MB (gzip) encryption module loaded on every signed-in start**, before the feed.
2. **Startup waterfall**: session → profile ×2 → legal check → feed → likes, one after another.
3. **Every revisit refetched behind a skeleton** (Home, Notifications, Messages, Profile, Explore).
4. **Background traffic**: 24 requests/min on an idle Home screen (verification polling every 10 s,
   device-list polling, full-speed polling while idle).
5. **Large images**: a 612 KB feed photo; uploads kept up to the camera's full resolution.
6. **Blank page until JavaScript arrived**: first paint 9.5 s on 3G.
7. The database itself was **not** a bottleneck: 0.5–7 ms mean per query.

## What changed

| Area | Change |
|---|---|
| Startup | Encryption deferred until the page has settled (load + idle); the feed's first page is fetched in parallel with the profile once the session token exists; likes folded into the feed query (`liked(posts)` computed field); profile load shared |
| Revisits | In-tab, in-memory stale-while-revalidate cache (cleared on sign-out / account change, never on disk, keyed by viewer); scroll position remembered |
| Background | Verification polling 10 s → 60 s (woken instantly by message pulses); device list every 5 min; all list polling 4× slower after 2 min without input |
| First paint | Static splash in `index.html` (theme-aware) |
| Media | Uploads resized to 1600 px, ~350 KB target, WebP (JPEG fallback); read links signed per 30-min window so the browser can cache them (`private, immutable`) — R2 objects stay private |
| Stability | Posts idempotent (`client_ref`) and retried automatically when back online; failed post text saved as a draft; message drafts kept per conversation for the tab session; failed messages resent on reconnect (idempotent); upload timeout 3 min; open tabs reload themselves after a deploy (stale chunk); `/assets/*` 404s instead of returning the app |
| Monitoring | `client_perf`: Web Vitals, feed-ready time, 20 % sample of API latency by endpoint name, upload speed, message send time — no user id, ids stripped from routes, no content/URLs/tokens; 30 batches/hour/person; 30-day retention; admin percentiles only (`admin_client_perf`) |

## Results

| Measure | Before (prod) | After (Preview) | After (prod) |
|---|---|---|---|
| First paint, 3G | 9.5 s | 4.0 s | 4.0 s |
| First paint, 4G | 1.8 s | 0.72 s | 0.68 s |
| Feed visible, 4G, cold | 3.5 s | 2.63 s | 2.69 s |
| Feed visible, 4G, warm | 3.0 s | 0.99 s | 1.33 s |
| Feed visible, 3G, warm | 3.4 s | 1.48 s | 2.14 s |
| Feed visible, fast, warm | 1.76 s | 0.85 s | 0.91 s |
| Home revisit, 4G / 3G | 490 / 1191 ms | 52 / 58 ms | 156 / 120 ms |
| Notifications revisit, 4G | 250 ms | 51 ms | 108 ms |
| Messages revisit, 3G | 570 ms | 30 ms | 47 ms |
| Idle requests/min: Home / inbox / open chat | 24 / 18 / 20 | 9 / 4 / 6 | 9 / 4 / 6 |
| Message delivery p50, fast / 4G | 1.33 / 1.43 s | 0.81 / 0.86 s | 0.83 / 0.93 s |
| Open a conversation, fast / 4G | 2.2 / 4.5 s | 1.35 / 3.05 s | 0.88 / 3.67 s |
| Feed photo | 612 KB | ≤ ~350 KB (new uploads) | same |

Single runs from one GitHub runner; differences of a few hundred ms between the two "after"
columns are within run-to-run noise (production also has more real posts with photos in the feed).

Typing indicator: 1.1–1.6 s. Encryption still downloads on a cold load, but after the feed.

### Load test (Preview, 2026-10-18, run 39088720906)

| Simulated users | Requests | Req/s | p50 | p95 | p99 | Errors |
|---|---|---|---|---|---|---|
| 10 | 212 | 3.3 | 84 ms | 87 ms | 249 ms | 0 % |
| 25 | 516 | 8.1 | 84 ms | 86 ms | 245 ms | 0 % |
| 50 | 1028 | 15.9 | 84 ms | 86 ms | 247 ms | 0 % |
| 100 | 2075 | 31.9 | 83 ms | 85 ms | 242 ms | 0 % |

Latency did not rise with load (≈ the network round trip from the US runner to Neon in London).
All 100 temporary accounts and their posts were deleted; real data was unchanged (4 people,
9 posts before and after).

## Regression checks

- Local suites green: API, end-to-end messaging, Moments, media, DM actions.
- Live on Preview (iPhone 13 profile, real Neon + R2): legal gate, photo post, offline → auto
  resend → posted once, profile picture, photo Moment, encrypted photo message decrypted on the
  recipient's phone with ciphertext only in R2, no page errors, cleanup verified.
- Security after each migration: no `PUBLIC`-executable functions in `public`, RLS on every table.
- One regression found and fixed in Preview: an early legal check could go out before the session
  token and be answered as signed-out (nothing pending), skipping the gate once. The gate now
  always asks the server itself.

## Remaining risks

- **Capacity evidence is limited to the Data API layer**: 100 simultaneous active simulated users
  were healthy. Not load-tested: sign-in bursts (Neon Auth rate-limits sign-ups from one address),
  Vercel functions (media links), R2 under many uploads, 100 concurrent encrypted conversations.
  This is not a claim that Amigo supports a given number of real users.
- **Polling, not push**: Neon Realtime isn't available for this project, so idle open apps still
  make 4–9 requests/min each. This drives Neon compute hours more than query cost does.
- **Cold encryption load** (1.9 MB gzip) still costs seconds on 3G when opening Messages first.
- **Slow 3G, first visit, signed in: the feed takes ~11.5 s** (first paint 4 s; the splash shows
  meanwhile). It is bound by downloading ~315 KB of JavaScript at 400 kbps; the next step would be
  splitting the first-screen bundle further.
- The first production perf-audit run timed out once at its first step (60 s) and did not
  reproduce on the re-run; the harness now records which step failed and the page landmarks.
- **Rare encrypted-photo failure for a brand-new recipient** (1 in ~8 earlier runs; not reproduced
  since; diagnostics in the live test).
- Neon compute auto-suspends when idle; the first request after a pause is slower.
- Vercel Hobby and Neon Free usage limits could not be read from here; check the dashboards.

## Costs going forward

Nothing paid was added. Cost grows mostly with **open apps × polling rate** (Neon compute hours)
and **image views** (one Vercel Edge invocation per uncached view; R2 egress is free). The new
browser-cacheable read links cut repeat image invocations. If usage outgrows the free tiers, the
first upgrades to consider are Neon Launch (compute hours) and Vercel Pro (invocations) — owner
decision, with usage data from `admin_client_perf` and the provider dashboards.
