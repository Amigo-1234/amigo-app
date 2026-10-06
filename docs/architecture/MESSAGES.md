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
| Demo (preview) | **none** | Messages stay in this browser (saved with the demo state). Every conversation says so. The other demo people "reply" so receipts and typing can be tested. Devices, verification and backup are a **labelled simulation** of the real flows (no keys). |
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
- Also from the same library: **cross-signing** (one identity per person that vouches for their
  devices), **SAS emoji verification**, **secret sharing** between your own verified devices, and
  **megolm key backup** (`m.megolm_backup.v1.curve25519-aes-sha2`). These are the Matrix
  specifications, implemented by matrix-sdk-crypto.
- The app writes no cryptography. `src/data/supabase/e2e.ts` only carries the library's requests
  to and from Supabase (key upload/query/claim, signatures, device-to-device mail, backup
  upload/download) and turns its state into what the screens show.

Cost: the WebAssembly is 7.8 MB (2.1 MB gzipped). It is a separate file that only the Supabase
build includes. It downloads in the background after sign-in, so you can receive messages before
ever opening Messages. Demo and Firebase builds don't include it.

## What the server stores

Migrations `20261006200000_messages.sql` and `20261006210000_messaging_security.sql` (both additive):

| Table | Contents | Who can read it |
| --- | --- | --- |
| `dm_conversations`, `dm_participants` | who talks to whom; last-read / last-delivered times | the two participants |
| `dm_messages` | **Megolm ciphertext only**. A check constraint allows exactly `algorithm`, `ciphertext`, `session_id`, `sender_key`, `device_id`, so there is no field for a plaintext body. Text, reply relation and photo key/location are all inside the ciphertext. | the two participants |
| `e2e_devices` | each device's **public** identity keys + signatures. Name, last active and sign-in session are private columns. | public keys: signed-in users; the rest: only the owner, via `e2e_my_devices()` |
| `e2e_one_time_keys` | **public** one-time and fallback keys, handed out once by `e2e_claim_keys` | nobody directly |
| `e2e_cross_signing_keys` | each person's **public** master / self-signing / user-signing keys | master + self-signing: signed-in users; user-signing: only its owner |
| `e2e_user_signatures` | "I verified this person" signatures | only the person who made them |
| `e2e_to_device` | Olm-encrypted mail between devices, plus emoji-verification protocol messages (public keys, commitments, MACs). Conversation keys and secrets only travel Olm-encrypted; plaintext `m.room_key` / `m.secret.send` are refused. | the recipient device's owner; deleted once processed |
| `e2e_backup_versions` | the backup's **public** key, signed by the device that created it | owner only (functions) |
| `e2e_backup_keys` | conversation keys **encrypted to the backup public key**. A check constraint allows only `ciphertext`, `ephemeral`, `mac`. | owner only (functions); admins have no access |
| `e2e_revoked_devices` | devices removed in Settings → Your devices | nobody directly |
| `user_blocks` | who blocked whom | only the blocker |
| `dm_reports` | reason, note, and the messages the reporter selected | admins, through `admin_dm_reports()` only |
| bucket `dm-attachments` (private) | encrypted photo bytes at `<conversation id>/<random>` | the two participants; useless without the key inside the message |

- Writes go only through `SECURITY DEFINER` functions (`dm_*`, `e2e_*`), each checking `auth.uid()`.
- Error codes are `DM001`–`DM011`.
- **Admins** have no read path to conversations, keys, signatures or backups, and there is no admin
  decrypt function. All they see is message reports.
- **Metadata the server does see:** who messages whom and when, message sizes, read and delivered
  times, device ids, device names (owner only), whether a message has a photo, who verified whom
  (stored privately for the verifier), and how many keys are backed up. Typing indicators use a
  private Realtime broadcast channel (`dm:<id>`) that only participants can join and that is never
  stored.

## Devices and verification

**Identity.** The first device of an account creates the account's cross-signing identity. Every
later device starts **unapproved**.

**Only approved devices get keys.** Conversation keys are shared only with devices their owner has
approved (the library's `identityBasedStrategy`). An unapproved device can't read new messages and
can't send. Someone who resets your password and signs in on a new device therefore gets nothing.

**Approving a new device** (Messages shows "Confirm it's you"):
1. **Approve from another device** (recommended). Both of your devices show the same 7 emoji;
   confirm on both.
2. The old device then signs the new one, which becomes trusted by everyone who trusts you.
3. Your identity keys and the backup key are sent to the new device Olm-encrypted, so it can also
   read older messages from the backup.

**I can't use my other devices.** This creates a new identity on this device, and you can enter
your recovery key to bring back history. The UI explains the consequences before you confirm:
contacts are told your security key changed, and your other devices must be approved again.

**Verifying people.** Optional and never pushed: the conversation intro offers "Verify Leo" in one
quiet line.
- Emoji verification goes to their approved devices; the first to answer is used.
- After that, the header shows **Verified**.
- Because of cross-signing, their future approved devices stay verified too.

**Indicators** (deliberately calm):
- **Verified:** a small green shield in the header.
- **Unverified:** the normal state, with no warning. Messages are still end-to-end encrypted.
- **Key changed, after you had verified them:** an amber "Key changed" chip and a short
  explanation ("usually a new phone or a reset"). You choose **Verify again** or **Continue without
  verifying**. Sending pauses until you choose, because the library refuses to share keys with a
  changed verified identity.
- **Key changed, never verified:** the same notice, with a neutral colour and an **OK** button.
- **A message from one of their unapproved devices:** the line "from a device they haven't verified".

**Your devices** (Settings → Your devices):
- Shows each device's name ("Chrome on Windows"), *This device*, Verified / Not verified, last
  active, and when it was added.
- **Remove** deletes that device's keys and pending mail.
- A removed device can't come back under the same id, and on hosted Supabase its sign-in session
  is ended (`auth.sessions`).
- The removed browser wipes its local keys and says so.

**New-device notice.** When a device you haven't seen before starts using your messages, every
screen shows "New sign-in to your messages: Firefox on Windows, 12 minutes ago. If this wasn't
you, remove it and change your password". It offers *Review devices* and *It was me*. Devices
older than the current one don't trigger it.

## Key backup and recovery

**Setting up** (Settings → Message backup):
- The device generates a random backup key; this is the **recovery key**, shown once as groups of
  4 characters.
- You can copy or download it, and you must tick "I've saved my recovery key somewhere safe".
- The server receives only the backup's *public* key (signed by the device), plus each
  conversation key encrypted to it.
- **The recovery key itself is never sent anywhere.** The tests check every request.

**Restoring.**
- Entering the recovery key on a new device decrypts the backup on that device and imports the
  keys, so older messages become readable.
- Approved devices get the backup key automatically over Olm and keep the backup up to date.
- A device that holds the key fetches missing keys from the backup on its own.

**If the recovery key is lost** (also explained on the page):
- Amigo can't recover it.
- If you're still signed in on a device, create a new recovery key there; the old one stops
  working, because the backup is re-created.
- If you lose the recovery key *and* all your devices, older messages are unreadable for good. New
  messages still work after you set up secure messaging again.

**Password reset does not defeat E2EE:**
- A new sign-in gets no keys until an approved device approves it, so it can't read new messages
  and can't send.
- It can't read history without the recovery key.
- Your devices show the new-sign-in notice.
- If the intruder resets your messaging identity, everyone who talks to you is told your security
  key changed. Anyone who had verified you must explicitly OK it before sending again.

**Residual risks (documented, not hidden):**
- A device that held the backup key can keep reading the backup until you create a new recovery
  key. The remove-device sheet says so.
- Device removal, and identity reset, need only an active sign-in, so someone with your password
  could remove your devices. That is disruptive, but it doesn't reveal messages.
- Messages restored from a backup can't prove which of the two participants sent them, so a
  malicious server could swap the sender on restored history. Directly received messages are
  checked.

## Reports

**Reporting.** Choose a reason, optionally tick specific messages from the other person (none are
selected by default), and add a note. Only the selected messages, decrypted on your device, are
submitted. The sheet says: "Only what you select is shared with the Amigo team — they can't see
the rest of this conversation."

**Admin → Reports → Message reports.**
- Shows the reason, who reported whom, the note and the submitted messages.
- The page states that conversations are never visible and that submitted text can't be verified
  (no message franking yet).
- *Mark reviewed* / *Reopen* are audit-logged.
- The Overview counts open message reports.

**Blocking** is two-way: while either person blocks the other, neither can send. Only the blocker
sees who blocked whom.

## What remains

1. QR-code verification. The library supports it, but it needs camera scanning.
2. Message franking, so reports can be cryptographically verified.
3. Passphrase-based recovery, and storing your identity keys in server-side secret storage (4S).
   Today a recovery key restores *history*; your *identity* comes back only by approving from
   another device, otherwise it's reset.
4. Re-authentication (password) before removing devices or resetting identity.
5. Deleting and editing messages, pagination beyond the latest 200, and group conversations (the
   schema already has a participants table).
6. Realtime and Storage are untested locally (no local Realtime/Storage servers). Typing,
   instant verification prompts and photo upload over Supabase need a check on a real project.
   Locally, verification relies on polling every 1.5 s while it's active.

## Tests

| Test | What it checks |
| --- | --- |
| `supabase/tests/database.test.sql` (messages + security, 78 checks) | ciphertext-only messages, participants-only access, admins can't read conversations or backups, key upload/claim/signature rules (only your own signatures, "who verified whom" private), removed devices can't return, backup keeps only encrypted keys, report review is admin-only and audit-logged |
| `npm run test:e2e` (70 checks) | Real crypto devices through PostgREST:<br>• new devices start unapproved and get no keys<br>• own-device emoji verification<br>• people verification and mismatch<br>• cross-signing trust carried to new devices<br>• backup with a recovery key that never leaves the device<br>• a **password-reset attacker** (no keys, can't send, can't restore, removed)<br>• restore on a new device<br>• identity reset (contacts warned; sending paused until OK)<br>• tampering / forged sender / replay rejected<br>• the app-level API<br>• a scan of every table and every request for plaintext or the recovery key |
| Demo browser suites (scratch) | Messages (66 checks) and security (57 checks): the new-sign-in notice, devices list and removal, verification (match, mismatch, incoming), key-changed flow, backup setup / copy / download / restore errors, report evidence selection, admin review, new-device gate, phone layout |
| Real-crypto browser run (local) | two people verify each other through the UI (same library-computed emoji on both screens); backup set up; a second browser for the same person is gated, approved by emoji from the first, and then reads history from before it existed |
