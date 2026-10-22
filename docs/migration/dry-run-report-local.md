# Firebase → Supabase migration report

- **Generated:** 2026-10-06T00:56:14.430Z
- **Snapshot:** rest extract at 2026-10-06T00:46:40.811Z
- **Target:** local
- **Orphan policy:** skip
- **Mode:** load + validate

## Counts

| | Source | Expected | Migrated | Not migrated |
|---|---:|---:|---:|---:|
| users (accounts) | 15 | 8 | 8 | 7 |
| posts | 32 | 29 | 29 | 3 |
| replies (comments) | 18 | 15 | 15 | 3 |
| post images | 6 | 5 | 5 | 1 |
| likes (with a user id) | 32 | 20 | 20 | 12 |
| likes (counter only, no user id) | 25 | 0 | 0 | 25 |
| follows | 17 | 17 | 17 | 0 |
| global chat (archived) | 54 | 54 | 54 | 0 |

## Checks

- PASS — users (accounts): migrated = expected (8 / 8)
- PASS — posts: migrated = expected (29 / 29)
- PASS — replies (comments): migrated = expected (15 / 15)
- PASS — post images: migrated = expected (5 / 5)
- PASS — likes (with a user id): migrated = expected (20 / 20)
- PASS — likes (counter only, no user id): migrated = expected (0 / 0)
- PASS — follows: migrated = expected (17 / 17)
- PASS — global chat (archived): migrated = expected (54 / 54)
- PASS — posts.like_count matches like rows (0 mismatches)
- PASS — posts.reply_count matches replies (0 mismatches)
- PASS — profile follow counters match follows (0 mismatches)
- PASS — no duplicate accounts per email (0 duplicated emails)
- PASS — every migrated user has a profile (0 missing)
- PASS — stored images are byte-identical to Firestore (5 / 5 verified by SHA-256)
- PASS — random sample of 10 posts/replies matches source (10 / 10)

## Not migrated, by reason

| Kind | Reason | Count |
|---|---|---:|
| like | N like(s) stored only as a counter, no user id | 3 |
| user | no email on record (seen as liker); rerun with an Auth export or --orphans placeholder | 2 |
| user | no email on record (seen as liker, post author); rerun with an Auth export or --orphans placeholder | 1 |
| user | no email on record (seen as liker, reaction); rerun with an Auth export or --orphans placeholder | 1 |
| user | no email on record (seen as chat author); rerun with an Auth export or --orphans placeholder | 1 |
| user | no email on record (seen as post author, liker); rerun with an Auth export or --orphans placeholder | 1 |
| user | no email on record (seen as liker, post author, comment author, chat author); rerun with an Auth export or --orphans placeholder | 1 |
| post | author account was not migrated | 3 |
| comment | author account was not migrated | 1 |
| comment | parent post was not migrated | 2 |
| image | post was not migrated | 1 |
| like | liker account was not migrated | 8 |

## Random sample

- PASS `posts/282sErr4YOxKHFPR5ApX/comments/RTFT7kfAa43gWLmp9Ho7` — author, text, timestamp, likes, replies, media match
- PASS `posts/wh2fKbJx3b2jU3dr2gdk` — author, text, timestamp, likes, replies, media match
- PASS `posts/PHdegjOoKa6Z8kF7Soho` — author, text, timestamp, likes, replies, media match
- PASS `posts/tbC5JJUY3NpMNjPgqXXu` — author, text, timestamp, likes, replies, media match
- PASS `posts/HUcTUde4BIdXln08TGDc/comments/HmGNAt7TnmV0YjabofhD` — author, text, timestamp, likes, replies, media match
- PASS `posts/ii3HiImDvHdBDJif7H4A` — author, text, timestamp, likes, replies, media match
- PASS `posts/J5IR1AdNNo7u7YHTo9kU` — author, text, timestamp, likes, replies, media match
- PASS `posts/sYZ3ujwSQ1SE5GsagQP4/comments/C11dZdLe01Da8tGLH3Pf` — author, text, timestamp, likes, replies, media match
- PASS `posts/VfDalSZMGUNKhN3WEclH/comments/TWhRtLrdX1zOr6dCc1Av` — author, text, timestamp, likes, replies, media match
- PASS `posts/Y7p0kz4PpNhHLCuZzjFo` — author, text, timestamp, likes, replies, media match
