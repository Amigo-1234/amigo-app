# Messages (one-to-one) and end-to-end encryption

Routes: `/messages` (conversation list) and `/messages/:conversationId`. On wide screens the list
and the conversation sit side by side. On phones you see one at a time: the conversation is full
screen and the bottom bar is hidden. On phones, Messages is reached from the Home header (Worlds has
the bottom-bar slot). Start a conversation with **Message** on someone's profile, or with **New
message**. No group chats yet.

Features: unread counts and a Messages badge, timestamps and day separators, Sent / Delivered /
Read under your latest message, a typing indicator, reply with quote, one photo per message (same
processing as posts: resized, metadata stripped), and block and report entry points.

Backend-neutral: `MessagesApi` in `src/data/types.ts` (optional capability `messages`), with an
`encryption` field (`"e2e"` | `"none"`). The UI only says "end-to-end encrypted" when the backend
reports `"e2e"`.

| Backend | Encryption | Notes |
| --- | --- | --- |
| Demo (preview) | **none** | Messages stay in this browser (saved with the demo state). Every conversation says so. The other demo people "reply" so receipts and typing can be tested. |
| Supabase | **end-to-end** | Below. Tested locally only; nothing is deployed. |
| Firebase (production) | — | Not offered (no new Firebase features). Messages stays a "coming soon" screen. |

## Protocol and library

**Olm + Megolm**, implemented by **vodozemac** through the official
**`@matrix-org/matrix-sdk-crypto-wasm`** (pinned at 18.9.0, Apache-2.0).

- Olm is a double ratchet (the same design as Signal's). It sets up pairwise encrypted channels
  between devices.
- Megolm encrypts conversation messages. Each sending device has one outbound session per
  conversation, and its key is shared with every recipient device over Olm. That gives
  multi-device support by design.
- Why this library: vodozemac had an independent audit (Least Authority, 2022). It is maintained
  by the Matrix.org Foundation and Element and used in production by Element on web and mobile.
  The WebAssembly build is the officially supported way to use it in browsers. It also includes the
  attachment encryption we use for photos (AES-256-CTR + SHA-256).
- Rejected alternatives:
  - `@matrix-org/olm` (libolm) is deprecated and has known timing side channels.
  - libsignal has no supported browser build.
  - libsodium or WebCrypto would mean designing our own protocol, which this project does not do.
- The app writes no cryptography. `src/data/supabase/e2e.ts` only carries the library's requests
  to and from Supabase: key upload/query/claim and device-to-device mail.

Cost: the WebAssembly is 7.8 MB (2.1 MB gzipped). It is a separate file that only the Supabase
build includes. It downloads in the background after sign-in, so you can receive messages before
ever opening Messages. Demo and Firebase builds don't include it.

## What the server stores (migration `20261006200000_messages.sql`)

| Table | Contents | Who can read it |
| --- | --- | --- |
| `dm_conversations`, `dm_participants` | who talks to whom; last-read / last-delivered times | the two participants |
| `dm_messages` | **Megolm ciphertext only**. A check constraint allows exactly `algorithm`, `ciphertext`, `session_id`, `sender_key`, `device_id`, so there is no field for a plaintext body. Text, reply relation and photo key/location are all inside the ciphertext. | the two participants |
| `e2e_devices` | each device's **public** identity keys | signed-in users (public keys) |
| `e2e_one_time_keys` | **public** one-time and fallback keys, handed out once by `e2e_claim_keys` | nobody directly |
| `e2e_to_device` | Olm-encrypted mail between devices. This is how conversation keys travel; plaintext `m.room_key` events are refused. | the recipient device's owner; deleted once processed |
| `user_blocks` | who blocked whom | only the blocker |
| `dm_reports` | reason, note, and the messages the reporter's device chose to reveal | admins, through `admin_dm_reports()` only |
| bucket `dm-attachments` (private) | encrypted photo bytes at `<conversation id>/<random>` | the two participants; useless without the key inside the message |

- Writes go only through `SECURITY DEFINER` functions (`dm_*`, `e2e_*`), each checking `auth.uid()`.
- Error codes are `DM001`–`DM008`.
- Admins have **no** read policy on conversations or messages. Even if they did, there is no
  plaintext to read.
- **Metadata the server does see:** who messages whom and when, message sizes, read and delivered
  times, device ids, and whether a message has a photo (there is an attachment upload). Typing
  indicators use a private Realtime broadcast channel (`dm:<id>`) that only participants can join
  and that is never stored.

## Private keys and devices

- Each browser is a **device** with its own keys, kept in a local IndexedDB crypto store
  (`amigo-crypto-<user>-<device>`). The store is encrypted with a random passphrase kept in the
  same browser's localStorage. That protects against casual copying of the IndexedDB files, not
  against someone who controls this browser profile.
- Private keys are never uploaded, in any form.
- Signing out a device (`E2EDevice.forget`) deletes its public keys and pending mail from the server.
- **Multi-device:** every message's key is shared with all current devices of both people,
  including your own other devices, so a phone and a laptop can both read new messages.
- **Device trust is trust-on-first-use.** There is no safety-number or QR verification screen
  yet, so a malicious server could add a "ghost" device to an account and receive future keys.
  Mitigations already in place:
  - a device's identity keys can't be swapped under the same id
  - the server can't forge who sent a message (a mismatched sender shows as undecryptable)
  - the server can't tamper with a message or replay it into another conversation
  - all of this is covered by tests

## Account and device recovery (important)

- **A new device cannot read messages sent before it existed.** There is no server-side key backup
  yet. Clearing site data, using a new browser, or losing every device means **earlier messages
  are permanently unreadable** for that account. Only devices that existed when a message was sent
  can read it.
- Resetting your password or recovering your account gives you back the *account*, not the
  message history. This is deliberate: recovering history through the server would give the
  server the keys.
- Sending to someone who has no messaging device yet (they haven't signed in since messaging
  shipped) is refused with a clear message, instead of producing a message nobody can ever read.
- Planned recovery design (not built): encrypted key backup (the library's `KeysBackup` requests,
  the Megolm backup v1 format), protected by a recovery key or passphrase that only the user has,
  plus cross-signing so a new device can be verified from an old one. The server would only ever
  hold the encrypted backup.

## Reports

The server can't read messages, so a report includes only what the reporter's device decrypts and
chooses to share (up to 20 of the other person's messages). The server can't prove these are
genuine because there is no message franking yet. Admins should treat them as the reporter's
account of events. Blocking is two-way: while either person blocks the other, neither can send.
Only the blocker sees who blocked whom.

## What remains

1. A device verification UI (safety numbers / QR) and cross-signing.
2. Encrypted key backup and recovery.
3. Message franking, for verifiable reports.
4. A device list in Settings (see and sign out devices).
5. An admin screen for message reports (the `admin_dm_reports()` function exists).
6. Deleting and editing messages, and pagination beyond the latest 200 messages.
7. Group conversations. The schema already uses a participants table.
8. Realtime and Storage are untested locally (no local Realtime/Storage servers). Typing and photo
   upload over Supabase need a check on a real project.

## Tests

| Test | What it checks |
| --- | --- |
| `supabase/tests/database.test.sql` (messages section, 50 checks) | ciphertext-only constraint, participants-only access, admins can't read, key upload/claim rules, to-device rules, blocking, reports, private bucket |
| `npm run test:e2e` (`scripts/test/supabase-e2e.test.mjs`, 42 checks) | Real crypto devices through PostgREST: Ama on two devices, Leo, and an outsider. Decryption only on the right devices, multi-device, forged sender / tampering / replay rejected, encrypted photos, a new device can't read old history, key replenishment, the app-level `MessagesApi`, and a scan of every table and every request for plaintext. |
| Demo browser suite (66 checks, scratch) | list, unread, receipts, typing, reply, photos, persistence, profile entry, new message, block, report, phone layout |
| Two-browser Supabase run (local) | two real browsers exchange encrypted messages through local PostgREST; keys persist in IndexedDB across reloads; the database holds only ciphertext |
