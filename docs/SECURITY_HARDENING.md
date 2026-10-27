# Safety hardening

Work from the 27 Oct 2026 audit, done in reviewed stages. Nothing here is applied to the
shared Neon database or deployed until the owner approves it.

## Stage 1 (migration `20261027090000_safety_hardening_stage1.sql`)

| Finding | Fix | Test (`supabase/tests/database.test.sql`) |
| --- | --- | --- |
| Any signed-in person could call `media_cleanup_take` and empty the queue of files waiting for deletion (the files then stay in storage forever). | New signature `media_cleanup_take(p_key, p_limit)` checks the server secret (`push_require_server`, the same as push). The old `media_cleanup_take(integer)` is dropped. `api/media-upload.ts` passes `PUSH_SERVER_SECRET` and skips housekeeping when the secret isn't set. | No secret / wrong secret / signed out refused (42501), old function gone, refused calls remove nothing, server with secret takes the files. |
| Any session (a stolen token is enough) could create, overwrite or delete the encrypted key backup. | `e2e_backup_create(p_device, …)` and `e2e_backup_put(p_device, …)` need a verified device: one of yours, not removed, signed by your **current** self-signing key. `e2e_backup_delete` is no longer granted to signed-in people (the app never called it). A new backup marks the old one `superseded_at` instead of deleting it; a key copy replaced by a "better" one is kept in `e2e_backup_keys_replaced`. | Unverified, unknown, removed, someone else's and signed-out devices refused; a device approved under an old self-signing key refused; delete refused; old version and its keys kept and restorable; replaced copy archived. |
| The 15-minute edit limit was only checked by the sender's app. | Trigger `dm_messages_annotation_window`: an annotation (reaction or edit) by a message's own sender more than 15 minutes (server time) after it was sent is refused with `DM013`. Receivers also ignore edits whose server time is more than 15 minutes after the message's. | Edit at once accepted; after 16 minutes refused; an accepted edit's retry still answers; the other person can still react to an old message. |

### Limits of these checks

- **Device trust is a presence check.** Postgres can't verify Ed25519 signatures, so it checks
  that the device carries *a* signature under the current self-signing key id. That stops the
  app's own unverified devices and casual misuse, but someone with a stolen session could
  register a device and attach a made-up signature string. What protects the backup against
  them is retention: nothing is deleted any more, superseded versions and every replaced key
  copy are kept, and they can't read the keys (encrypted to the owner's recovery key). A real
  signature check would need Ed25519 on the server (e.g. in an API route) — proposed for a
  later stage.
- **Edits and reactions look the same to the server** (both encrypted). So reacting to *your
  own* message is also refused after 15 minutes; the app hides the reaction controls on your
  own messages after that time. Reactions to other people's messages are unaffected. The
  alternative — a visible "this is an edit" flag — would tell the server which annotations
  are edits, so it wasn't chosen.
- **Retention grows storage.** Superseded backups and replaced copies are kept until the
  account is deleted. A later stage can prune versions superseded more than N days ago.

### Rollout (not done; needs approval)

The new functions have new signatures, so the database migration and the app that calls them
must go out together:

1. Apply the migration to Neon (it adds a column, a table, a trigger and functions; it changes
   no existing rows, accounts, keys, messages or backups).
2. Deploy the matching app build.

Between the two steps (minutes) old app builds fail to set up a backup or back up new keys
(production has no backups today) and the upload function skips queued-file deletion (4 files
queued today); both recover by themselves after step 2.

## Proposed rate limits (design only — not implemented)

Rules: never refuse something a person needs to keep an encrypted conversation working; where
possible degrade instead of refusing; count from server-side rows, per signed-in user; refuse
with `RL001` (the app already shows "slow down").

| Endpoint | Today | Proposal | Why it keeps messaging working |
| --- | --- | --- | --- |
| `dm_open` | Unlimited; anyone can open a conversation with anyone not blocking them. | **New** conversations only (re-opening an existing one is free): 30 per hour, 200 per day, counted from `dm_conversations.created_at` + participants. | People rarely start more than a handful of new chats an hour; existing chats are never limited. |
| `e2e_claim_keys` | Any signed-in person can claim (and so use up) any device's one-time keys, 200 devices per call. | (a) Only for yourself or people you share a conversation with; (b) at most 10 one-time keys per claimer per target device per hour — after that the **fallback key** is returned instead (no error). Needs a small claim log table. | The Olm library only claims for conversation partners and your own devices, and a session needs one key. Running past the budget still gets a working (fallback) key, so a message is never blocked. |
| `e2e_send_to_device` | Conversation partners or yourself only; 500 messages × 64 KB per call. | 3,000 messages per 10 minutes per sender (count kept in a log, because acknowledged mail is deleted). | Sharing a room key is one message per recipient device; even 50 conversations × 10 devices is 500. |
| `dm_send_v3` / `dm_send` | 60 rows per minute (reactions and edits included). | Keep. | — |
| World chat (`world_chat_messages`) | RLS only. | 20 per minute, 500 per day per person, added to `rate_limit_check`. | Live chat pace; mirrors message limits. |
| Moments | Upload registry only. | 20 per hour, 100 per day. | |
| `/api/worlds-tick`, `/api/push-notify` | Need a signed-in token; push targets need the server secret. | Review in Stage 2: tick should run from a schedule with its own secret; push-notify should be limited per sender (e.g. 120 per minute). | |

Each would ship with tests in `database.test.sql` that show (1) the limit triggers at the stated
count and (2) the normal path — opening a chat, claiming keys for a partner, sharing a room
key with several devices — stays well under it.
