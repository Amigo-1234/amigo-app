# Safety hardening

Work from the 27 Oct 2026 audit, done in reviewed stages. Nothing here is applied to the
shared Neon database or deployed until the owner approves it.

## Stage 1 (migration `20261027090000_safety_hardening_stage1.sql`)

> Superseded in part by Stage 1b (below): backup writes now need a cryptographic proof from the
> device, identity resets a fresh sign-in, edits a label, and cleanup a lease. The table is kept
> as the record of what Stage 1 found.

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

## Stage 1b (migration `20261028090000_safety_hardening_stage1b.sql`, on top of Stage 1)

The Stage 1 review showed the backup check was only a presence check (any session could name an
approved device, attach a made-up signature, or replace the identity) and that the edit window
also blocked reactions to your own old messages. Stage 1b replaces both.

### Backup writes: proof of possession, verified cryptographically

1. The device asks for a one-time challenge (`e2e_proof_challenge`, 5 minutes, one use).
2. It signs `proofMessage(op, user, device, challenge, sha256(payload))` with its **own device
   key** (`OlmMachine.sign` signs the exact bytes) — only that device holds the private key.
3. `/api/e2e-backup` fetches the device's public keys (`e2e_proof_material`, server secret) and
   checks with WebCrypto Ed25519 (`src/lib/e2eProof.ts`): device keys signed by the self-signing
   key, the self-signing key signed by the master key, the request signed by the device key.
4. `e2e_backup_create_verified` / `e2e_backup_put_verified` (server secret only) use up the
   challenge (no replays) and refuse if the keys changed since step 3 (hash of the stored keys).

Checked against the real library: keys and signatures made by matrix-sdk-crypto-wasm pass, and
forged signatures, another account's keys, an unapproved device, a device approved under an old
identity, a changed request or device record all fail (`scripts/test/e2e-proof.test.mjs`). The
stored keys still verify after Postgres' `jsonb` round trip (canonical JSON is rebuilt).

**Assumption:** the master key on the server is the root of trust (trust on first use), as
everywhere else in the app. Whoever can replace it controls what counts as "approved" — hence:

### Identity replacement: fresh sign-in, recorded, owner emailed

- `e2e_upload_signing_keys` still accepts first-time setup and the same keys again (an
  interrupted setup finishing), but refuses a *different* key (DM014).
- `/api/e2e-identity` replaces it only if the session behind the request (its cookie, asked of
  Neon Auth) signed in within the last 10 minutes, the new keys hang together (self-signing and
  user-signing keys signed by the new master), and the session's user is the token's user.
- Each reset is recorded (`e2e_security_events`; Your devices shows a warning for 30 days) and
  the account's email address is told (Resend, best effort).

**Limit:** someone who knows the password can sign in fresh and reset. They still can't read
earlier messages or backups (encrypted to the owner's recovery key), the owner is emailed, the
owner's devices stop being "verified", and nothing is deleted: superseded backups and replaced
key copies are kept, and **Restore** now also accepts the recovery key of an older backup
(`e2e_backup_versions`).

### Edits vs reactions

`dm_send_v3(…, p_kind)` labels an annotation `reaction` or `edit` (stored in
`dm_messages.relates_kind`; the server learns which, never the content):

| Label | Server |
| --- | --- |
| `reaction` | allowed at any age (reacting / un-reacting to anything, your own messages too) |
| `edit` | only the message's sender, within 15 minutes of it (server time); otherwise DM006 / DM013 |
| none (apps from before labels) | treated as a possible edit: refused on your own message after 15 minutes |

Receivers (`src/data/supabase/annotationRule.ts`) apply an annotation only if the label matches
the encrypted type, and an edit only from the sender within 15 minutes — so labelling a late edit
"reaction" gets it accepted by the server but ignored by every updated app.

**Transition risk:** app builds from before Stage 1 don't check labels or times. Until they
reload, they would show a late edit that a *modified* client labelled "reaction". Only the
message's own author can do this, and only to their own message.

### Media cleanup

Queue rows are leased (`media_cleanup_take` sets `claimed_at` / `claim_token`, `attempts`),
never deleted on take. The upload function deletes each file once (no 10-fold retry holding up
the upload) and calls `media_cleanup_done` with only the files confirmed gone (2xx, or 404 =
already gone). Unconfirmed items come back after 10 minutes; concurrent workers skip leased rows
(`for update skip locked`, plus the lease); after 10 attempts an item stays for a person to look
at. Only the current lease holder can finish an item.

### Rollout (still not done)

Both migrations go together, with the matching app build, after a dedicated Neon test branch
run. Production today: 0 backups, 9 identities, 33 devices, 4 annotations (unlabelled; receivers
treat them as before), 5 queued files (the new columns start empty: first take leases them).

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
