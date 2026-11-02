# Amigo World 2.0 — Business, AI and Marketplace: assessment and plan

*2 Nov 2026. Assessment only; nothing in this document is built. Based on branch
`claude/amigo-world-restart-7mrbrf` at `d0f76e8` (clean working tree) and read-only queries
against Production (`ep-dry-mode-zano9y8g`).*

---

## 0. Summary

- **The foundations are real and in Production.** Business Profiles, the media registry with R2
  storage and cleanup, moderation and audit tooling, blocking, notifications with Web Push, and
  end-to-end encrypted DMs are all deployed. An admin turned business pages on
  (`business.enable`, 29 Oct 19:06), and one business exists, with a logo uploaded to R2.
- **The hardest constraint is messaging.** Personal DMs are end-to-end encrypted and tied to
  each *person's* identity, so the server can't read them. Businesses need things that conflict
  with that: an inbox several people can share, listing context, moderation, and above all an
  AI assistant that answers while the owner is offline. **Recommendation: a separate business
  chat channel that is clearly labelled as not end-to-end encrypted.** Personal DMs stay exactly
  as they are. Section 3 explains this; it needs your approval.
- **Amigo has 13 accounts and one business.** A marketplace lives or dies on having enough
  buyers and sellers in the same place. The plan therefore starts small:
  - businesses only;
  - one market and currency;
  - a closed group of real sellers before any public launch.
- **Recommended first phase: the Marketplace foundation for businesses.** Businesses can list
  products and services; buyers can browse, search, save, share and report listings, and admins
  can remove them. It reuses business, media, moderation and post infrastructure that already
  works. It doesn't depend on the messaging decision: until business chat exists, buyers use
  the contact details already on business profiles.
- **AI comes after business chat**, starting with *suggested replies* that the owner approves.
  Automatic answers to customers come only once grounding, labelling and handoff are tested.

---

## 1. Current-state assessment

### What exists and works (verified)

| Area | State | Evidence |
|---|---|---|
| Business Profiles | In Production, **enabled** | Migration `20261028130000`; 70/70 rolled-back DB checks on Neon; 110/111 Data API + route checks (the 1 failure was fixed, commit `7173f79`); Production schema identical to the tested branch |
| One business per person; private owner | Built | `businesses.owner_id` not readable by users (column grants); business posts have no personal author; storage keys `b/<business>/…` |
| Business posts (create/delete), follow, directory, search, admin suspend/restore, on/off switch | Built | `create_business_post`, `follow_business`, `search_businesses`, `admin_*` |
| Logo / cover / post photos on R2 | Built, working in Production | Production business has a logo; 7 uploads in the last 7 days |
| Media registry + cleanup queue + takedown retention | Built | `media_objects`, `media_cleanup_queue`, leasing, 30-day takedown hold |
| Encrypted DMs (Olm/Megolm via `matrix-sdk-crypto-wasm`), cross-signing, verified key backup | Built | `docs/architecture/MESSAGES.md`, stage 1/1b hardening |
| Notifications + Web Push | Built | 12 push subscriptions in Production |
| Moderation: reports, suspensions, takedowns, audit log, admin console | Built | `src/features/admin/`, `admin_audit_log` |
| Worlds (scheduled events, competitions, chat) | Built (1 World ever run) | `WorldScreen`, `worlds` table |
| Interests (12 topics) | Stored; **used for nothing** | `user_interests`; 2 accounts have chosen any |
| Search | Unindexed substring search (`ilike`) | `docs/architecture/SEARCH.md`; trigram/full-text proposed, not applied |

Production has `pg_trgm`, `unaccent`, `vector`, `postgis` and `pg_cron` **available but not
installed**. Usage is tiny: 13 profiles, 4 posts and 3 DMs in the last 7 days.

### Business Profiles: limitations

1. **No way to message a business.** Contact is the optional website/email/phone fields only.
2. **No catalogue, location, hours or verification badge.**
3. **The owner is the only manager.** `owner_id` is checked directly in about ten functions; a
   future manager role needs one central permission check (§2.3).
4. **Replies to business posts lose context.** There is no "Replying to" line, and the reply's
   own page has no link back. `attachParents` reads only personal authors.
5. **No business notifications**, by design: the owner isn't told about likes or replies on
   business posts.
6. **Personal blocks don't hide business posts.** This is deliberate (a block would reveal the
   owner), but it needs to be explained in the help text.
7. **Deleting a business removes everything immediately**, including taken-down posts. That
   matches personal account deletion; admins should suspend a business before reviewing it.

### How the systems work today (what the new features build on)

- **DMs.** The database stores only Megolm ciphertext: a check constraint rejects any other
  shape. Conversation pairs are keyed `"<uuidA>:<uuidB>"`, one per pair of people. Device keys
  belong to the Matrix-style ID `@<person-uuid>:amigo.world`. Admins can't read messages;
  reports carry only what the reporter's device chooses to reveal. Neon has no realtime
  connection, so the app polls.
- **Media.** The browser asks `/api/media-upload`; Postgres (`media_begin_upload`) checks the
  purpose, size and type and issues the key. Files go straight to R2. Reads go through
  `/api/media`, which asks `media_readable`. Deleting a database row queues the file, and a
  daily cron deletes it. That cron is **not yet working**: it needs `CRON_SECRET` and a login
  for the `media_janitor` role.
- **Feed.** `feed_posts(scope)`: "latest" is everyone; "following" is people and businesses you
  follow. There is no ranking, interests aren't used, and there are no hashtags.
- **Feature switches.** There are two kinds:
  - build-time settings (`VITE_DATA_SOURCE`, `VITE_MEDIA_STORAGE`);
  - one database switch (`business_settings.enabled`), toggled by admins and audit-logged.
  There's no general switch table.
- **Migrations.** Plain SQL files in `supabase/migrations/`, turned into the Neon form by
  `scripts/neon/build-schema.mjs`, tested on local Postgres (542 checks) and on a Neon branch
  (rolled back), then applied by hand. `20261029090000_football_predictions.sql` is in the repo
  but deliberately **not applied** anywhere; new migrations must be ordered with that in mind
  (§9).

### What can be developed and tested in isolation

Everything below can be built and tested this way, with each feature behind its own switch:
- **locally:** Postgres, the demo app and `npm run dev:verify`;
- **on Neon:** the `verify-1029` branch, using throwaway accounts and rolled-back fixtures.

The only things that need real services are:
- R2: a test bucket or prefix;
- an AI provider key: server-side, for Phase 3;
- Web Push delivery.

---

## 2. Marketplace architecture and data model

### 2.1 One listing model for catalogues and the Marketplace

Business "Products/Services" tabs and the Marketplace show **the same `listings` rows**. A
separate catalogue table would duplicate prices and stock and drift out of sync. Instead:
- a listing belongs to exactly one seller (a business now; maybe a person later), the same
  pattern as `posts`;
- its `kind` decides which fields apply (product or service);
- its `section` lets a restaurant group listings as a menu, without a separate menu model.

```sql
create table public.listing_categories (          -- small, admin-maintained taxonomy
  id text primary key,                            -- 'phones', 'fashion_women', 'catering', …
  parent_id text references public.listing_categories (id),
  label text not null, kind text not null check (kind in ('product','service','both')),
  sort smallint not null default 0, active boolean not null default true
);

create table public.listings (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid references public.businesses (id) on delete cascade,
  seller_id     uuid references public.profiles (id) on delete cascade,   -- personal sellers (later)
  constraint listings_one_seller check ((business_id is null) <> (seller_id is null)),
  kind          text not null check (kind in ('product','service')),
  title         text not null check (char_length(btrim(title)) between 3 and 80),
  description   text not null default '' check (char_length(description) <= 2000),
  category_id   text not null references public.listing_categories (id),
  section       text check (char_length(section) <= 40),          -- "Mains", "Hair", …
  price_minor   bigint check (price_minor >= 0),                    -- null = "price on request"
  currency      char(3) not null default 'NGN',
  price_unit    text check (price_unit in ('item','hour','session','day','from')),
  condition     text check (condition in ('new','like_new','good','fair')),  -- products only
  status        text not null default 'available'
                check (status in ('draft','available','reserved','sold','removed')),
  area          text check (char_length(area) <= 60),                 -- coarse: "Lekki, Lagos"
  fulfilment    text[] not null default '{}'                          -- 'collection','delivery','online','on_site'
                check (fulfilment <@ array['collection','delivery','online','on_site']),
  delivery_note text check (char_length(delivery_note) <= 300),
  removed_by_admin_at timestamptz, removed_note text,
  save_count    integer not null default 0, enquiry_count integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  search        tsvector generated always as (
                  setweight(to_tsvector('simple', coalesce(title,'')), 'A') ||
                  setweight(to_tsvector('simple', coalesce(description,'')), 'B')) stored
);
-- Indexes: (status, category_id, created_at desc) where status in ('available','reserved');
-- (business_id, status, created_at desc); gin(search); gin(title gin_trgm_ops); (price_minor).

create table public.listing_media (               -- like post_media; files in media_objects
  listing_id uuid references public.listings (id) on delete cascade,
  position smallint check (position between 0 and 7), storage_path text not null, …,
  primary key (listing_id, position));

create table public.listing_saves (user_id uuid, listing_id uuid, created_at timestamptz,
  primary key (user_id, listing_id));             -- private to the saver

create table public.listing_daily_stats (listing_id uuid, day date, views int, enquiries int,
  primary key (listing_id, day));                 -- aggregate counts only, no viewer IDs

alter table public.posts add column listing_id uuid references public.listings (id) on delete set null;
```

- **Prices** are stored as integers in minor units (kobo for naira). Floating-point numbers
  would introduce rounding errors.
- **Shared links:** a listing's stable URL is `/l/<id>`. A post that shares a listing stores
  `listing_id`, so its card always shows the listing's *current* state: a sold item is marked
  "Sold", and a removed one shows "No longer available".
- **Images:** a new media type `listing`, with keys `b/<business>/listing/<hex>.<ext>`.
  Deleting a listing, or removing an image, releases the files through the existing cleanup
  queue, with the same takedown retention as posts.
- **Writes go through checked functions** (`create_listing`, `update_listing`,
  `set_listing_status`, `delete_listing`), never directly from the client, the same rule as
  businesses. They enforce:
  - ownership, through the single permission check;
  - suspension;
  - rate limits;
  - allowed statuses.
- **Reads:** a row-security policy shows `available` and `reserved` listings from *active*
  businesses. Owners see their own drafts.

### 2.2 Who can sell (recommendation)

**Phase 1: businesses only.** The business rules already require a verified email, no
suspension and one business per person, and the suspension, reporting and audit tooling
already exists. Fraud exposure stays small while the market is small.

**Personal sellers later**, behind their own switch, with stricter rules:
- an account older than about 14 days and a verified email;
- no suspension, and at most 10 active listings;
- selling only through their personal identity, with no anonymous seller handle (an anonymous
  seller is an impersonation risk).

Buyers would contact personal sellers through the existing **encrypted personal DMs**, which
already work. They're fine there because AI and team inboxes don't apply to individuals.

### 2.3 Prepare for business managers now, cheaply

Add `public.business_can_manage(p_business uuid)`, which returns true for the owner today, and
use it in every new business function (and later in the existing ones). When managers arrive, a
`business_members (business_id, user_id, role)` table changes only that function. Managers act
*as the business*: customers never see their personal accounts, the same rule as for owners.

### 2.4 Discovery (Phase 1: dependable, not clever)

- Search: install `pg_trgm` and query the `search` column for full text, with trigram matching
  for typos and partial words. Results are ranked by match, then recency.
- Filters: category, price range, area (text match), kind (product or service), condition and
  "available only".
- Sorting: newest, recently updated, price low to high, price high to low.
- Marketplace home:
  - category tiles;
  - newest listings;
  - "from businesses you follow";
  - "in your interests" (a simple map from the 12 interests to categories, with no personal
    profiling).
- Recommendation algorithms wait until there's enough data to show they help.

---

## 3. Business messaging: the architectural issue and the recommendation

### The issue

The current DM system:
- encrypts every message on the sender's devices for the recipient's devices;
- identifies a recipient by `@<person-uuid>:amigo.world`;
- refuses to store anything except ciphertext;
- gives the server no way to read a message, by design.

Business chat needs four things that conflict with this:

1. **The owner's privacy.** A customer's app would have to look up and encrypt to the owner's
   *personal* device keys, which reveals who the owner is.
2. **A shared inbox.** Owners and later managers on several devices all need to read; with
   end-to-end encryption each one becomes a key-distribution problem.
3. **The AI assistant.** It has to read the customer's question on the server, possibly while
   no business device is online. That's impossible with end-to-end encryption unless the
   server holds the business's keys, and then it isn't end-to-end any more.
4. **Moderation and listing context.** Reports of business abuse and spam need evidence, and
   the listing an enquiry is about needs to be visible to the business's tools.

### Options

| | A. Separate business chat, labelled not end-to-end encrypted *(recommended)* | B. Business gets its own encryption identity | C. Reuse personal DMs |
|---|---|---|---|
| Owner stays private | ✅ the conversation is with the business ID | ✅ | ❌ reveals the owner's account |
| Shared inbox / managers | ✅ permission check on read | ⚠️ key sharing to every manager device | ❌ |
| AI answers while the owner is offline | ✅ | ❌ (or the server holds keys, which defeats the point) | ❌ |
| Spam controls, report evidence, listing context | ✅ | ⚠️ limited | ⚠️ |
| Weakens personal DM encryption | No: separate tables and code | No | No, but leaks identity |
| Effort | Medium | High | Low, but unsafe |

### Approved design (option A, approved 2 Nov 2026)

- **New tables**, entirely separate from `dm_*`:
  - `biz_conversations (id, business_id, customer_id, subject_listing_id, subject_post_id,
    status open|archived|blocked, ai_mode, last_message_at, …)`;
  - `biz_messages (id, conversation_id, sender_kind customer|business|ai|system, sender_user_id
    (internal only), body text ≤ 2000, listing_id, image path, created_at)`;
  - `biz_reads` for unread state on each side.
- **Conversations:** one open conversation per (business, customer), with the item being asked
  about shown in the thread. A customer can still deliberately start a separate enquiry.
- **Privacy:**
  - Customers see the business's name, handle and logo; `sender_user_id` is never exposed.
  - The business's staff see the customer's public profile, as in any DM.
  - AI messages are stored as `sender_kind = 'ai'` and labelled for both sides.
- **Labelling** (needs your approval, plus a Privacy Policy update): customers see *"Messages
  with businesses aren't end-to-end encrypted. The business, and its AI assistant if it's
  switched on, can read them. Amigo may review reported messages."* Personal DMs keep their
  end-to-end encryption and wording. This is how large platforms separate business chat from
  personal chat.
- **Security:**
  - Storage is encrypted at rest (Neon), with row security limiting reads to the customer and
    the business's managers (`business_can_manage`).
  - Every write goes through checked functions.
  - New-conversation limits per customer (for example 10 businesses per hour) and per business.
  - A business can block a customer from its chat; a customer can block a business. Both are
    separate from personal blocks, to avoid revealing who runs a business.
  - Reports attach the reported messages server-side, so no client-supplied evidence is needed.
- **Notifications:**
  - A new `enquiry` kind sent to the owner (later managers): "New message for Kofi's Kitchen".
  - A reply notifies the customer as coming from the business.
  - Web Push uses the same routes.
- **Personal sellers** (when switched on) use the existing encrypted DMs. The listing card
  travels *inside* the encrypted message as an `amigo.listing` field; older app versions show
  the link text.

---

## 4. Amigo AI: architecture, providers and costs

### 4.1 Architecture

- **Server only.** A new route `api/ai.ts` with modes `suggest_reply`, `answer`, `draft_post`,
  `describe_listing` and `insights`. The provider key lives in Vercel environment variables;
  the browser never sees it.
- **One provider module** (`api/_ai.ts`) wraps the SDK, so models and providers can be switched
  in one place.
- **Postgres decides what the AI may see and whether it may run at all.** A function returns
  the business-approved facts for one request and refuses when:
  - the feature is off globally or for that business;
  - the business is over its quota;
  - the business is suspended.
- **Grounding data (business-approved only):**
  - public profile fields and hours;
  - `available` listings with their prices;
  - a new `business_faqs` table (question, answer, `approved_at`), where AI-drafted answers
    stay unapproved until the owner approves them;
  - per-business AI settings: which topics always go to a human (for example refunds,
    custom orders, complaints).
- **The AI never sees:**
  - the owner's identity;
  - other customers;
  - other businesses;
  - personal DMs;
  - customers' profile data beyond a display name;
  - anything private.
- **Output is structured JSON:** `{answer, sources:[listing/faq ids], needs_human, reason}`.
  The server checks it before anything reaches a customer:
  - any price, stock or availability claim must come from a cited listing;
  - an answer with no sources is replaced by a handoff ("I'm not sure — I've asked
    {business}; they'll reply here.");
  - `needs_human` triggers the handoff and notifies the owner.
- **Prompt injection.** Customer messages and listing text go in only as quoted data inside the
  user turn; instructions sit in the system prompt. The model has **no tools**: it can't act,
  only answer. Inputs and outputs are length-capped, and there's a per-customer limit.
- **Labelling:**
  - Every AI message reads "Automated answer · Amigo AI on behalf of {business}".
  - A permanent "Talk to a person" button hands the conversation over.
  - After a handoff the AI stays quiet in that conversation until the owner turns it back on.
- **Logging:** `ai_usage (business_id, feature, model, input_tokens, output_tokens,
  cached_tokens, cost_micros, outcome, created_at)`. Token counts and outcomes only, no
  message text. The text already exists in `biz_messages`, under the business chat's rules.
- **Kill switches:** one global switch per AI feature, plus a per-business switch, plus quotas.
  Provider timeouts of about 20 seconds fall back to "the business will reply".

### 4.2 Provider options and realistic costs

From Anthropic's current published list prices (the API reference used for this assessment).
Prices are per million tokens:

| Model | Input | Output | Notes |
|---|---|---|---|
| Claude Haiku 5.5 | $0.10 | $0.50 | Up to 100K-token prompts (more above). Fast and cheap; fits FAQ-style grounded answers |
| Claude Sonnet 5.5 | $2.00 | $10.00 | Stronger writing and judgement; fits content drafting |
| Claude Opus 5.5 | $4.00 | $20.00 | Most capable of the three; usually unnecessary here |
| Claude Fable 5.1 | $10.00 | $50.00 | Overkill for this work |

Cached prompt prefixes (the business's facts, reused between messages) are billed at about a
tenth of the input price. The Batch API (non-urgent jobs such as nightly insights) costs half.

Rough cost per use. These are estimates, not measurements. Thinking tokens are billed as output
and can double or triple the output figures; keep effort low for these routes.

| Use | Shape | Haiku 5.5 | Sonnet 5.5 |
|---|---|---|---|
| Customer answer | ~3K cached facts + ~1K conversation in, ~300 out | ~$0.0003–0.0008 | ~$0.004–0.01 |
| Post or listing draft | ~1.5K in, ~600 out | ~$0.0005 | ~$0.01 |
| Weekly insights summary (batch) | ~5K in, ~800 out | ~$0.0003 | ~$0.005 |

For example, 50 businesses each getting 200 AI answers and 40 drafts a month:
- **about $5 a month on Haiku 5.5;**
- **about $100–150 a month on Sonnet 5.5.**

Quotas and switches keep this bounded. Suggested launch quotas per business per month: 300
answers, 60 drafts, 4 insight summaries. **Choosing the model is your decision.** My
suggestion is Haiku 5.5 for customer answers, which are short and grounded, and Sonnet 5.5 for
drafting, measured against a small evaluation set before launch.

**Other providers.** OpenAI, Google, or open-weight models hosted yourself also work behind the
same provider module. I haven't checked their current prices; compare them when you decide.
Self-hosting removes per-token fees but adds hosting and operations work that isn't justified
at this scale. **Data handling:** before launch, check the chosen provider's retention and
training terms for API data, and say in the Privacy Policy that business chats may be processed
by an AI provider when a business turns the assistant on.

---

## 5. How the AI uses approved information and helps reach the right audience

- **Customer assistant:**
  - answers only from approved facts and available listings;
  - asks a clarifying question when a request is ambiguous;
  - links listings it cites (`/l/<id>`);
  - hands over to a person whenever it's unsure or a topic is marked human-only;
  - summarises long threads for the owner on request.
- **Content assistant:**
  - drafts posts, listing descriptions, campaign ideas and FAQ answers;
  - **everything is a draft until the owner publishes it.**
  - Suggested posting times come only from the business's own aggregate engagement (hour of day
    of likes and replies), with "not enough data yet" below a threshold.
- **Insights:** aggregate counts only:
  - listing views (daily totals) and saves;
  - enquiries per listing and engagement per post;
  - the most-asked questions (grouped from that business's own chats);
  - follower growth.
  - The AI *describes* these aggregates. It never profiles individuals and never infers
    sensitive traits.
- **Reach (organic only):**
  - suggests which categories, listings to feature and topics to post about, based on what has
    worked for the business;
  - points to relevant Worlds;
  - matches the Marketplace "in your interests" row through declared interests and business
    categories.
  - No promise of reach or sales. **Paid or sponsored placement is out of scope**; if it's
    added later, it must be labelled "Sponsored" and governed by separate rules.
- **Guided setup:** a checklist assistant for new businesses:
  1. complete the profile and hours;
  2. add the first three listings, with AI-drafted descriptions;
  3. write FAQs;
  4. make a first post;
  5. configure the assistant;
  6. learn what attracts followers.

---

## 6. How the pieces connect

```
Feed post ──(listing card)──► /l/:id listing ──► Save · Share · Report
     ▲                              │
     │ business shares listing      ├─► Business profile /b/:handle (Products · Services · Posts · About)
     │                              └─► Message seller ──► Business chat (listing shown at the top)
Marketplace /market (search, categories, filters) ─┘                 │
                                                                     ├─► Owner inbox (Manage Business)
                                                                     └─► AI suggested reply / grounded answer
```

- Listing links pasted into posts or chats show a card (`/l/:id` is detected the same way as
  existing links). Sold or removed items show their real status everywhere.
- Notifications: "new enquiry" for businesses, "the business replied" for customers.
- Worlds: business-hosted launches and showcases come later (§7).

---

## 7. Additional features: what to build, and what to skip for now

| Feature | User problem | Value | Cost / dependencies | Privacy | Recommend |
|---|---|---|---|---|---|
| **Saved listings** | "I'll decide later" | High, the main return-visit habit for shopping | Low; Phase 1 | Private to the user | **Phase 1** |
| **Business insights (basic)** | "Is this working?" | High; keeps businesses active | Low–medium; aggregate counts | Aggregates only | **Phase 2** |
| **Smart FAQs** | The same questions again and again | High; also the base for AI | Low; Phase 2/3 | Business-approved text | **Phase 2–3** |
| **Business Worlds** (launches, showcases) | Launches get lost in the feed | High and distinctive; reuses Worlds | Medium; Worlds already exists | Public by nature | **Phase 5** |
| **Customer requests** ("Looking for a 2-bed shortlet in Lekki") | Buyers can't find niche items | Strong demand signal | Medium; spam and moderation load | Request is public; contact through chat | **Phase 5, trial** |
| **AI shopping assistant** | "Find me X under ₦50k" | Good once there are enough listings | Medium; needs listings plus AI quotas | Uses only what the user types | After Phase 4 |
| **Local discovery** | Nearby items and services | Useful | Phase 1 has a coarse text area; PostGIS later | Never precise locations | Text area now; maps later |
| **Seller reputation** | Trust | High, but easy to game | Needs verified transactions first | — | **Wait for transactions** |
| **Promotions / sponsored** | Revenue | Commercial | Needs labelling rules, billing and policy | Separate rules | Later, separate review |
| **Creator partnerships** | Reach | Medium | Needs an active creator base first | — | Later |
| **Business verification badge** | "Is this the real business?" | High trust value, low cost | Admin-granted; Phase 1–2 | Documents reviewed offline; never public | **Phase 2** |

---

## 8. Phases, dependencies and acceptance criteria

| Phase | Scope | Depends on | Acceptance criteria (each tested) |
|---|---|---|---|
| **0 (this document)** | Assessment and decisions | — | Decisions in §12 made |
| **1. Marketplace foundation** (smallest useful first phase) | General feature-switch table; `listings`, categories, media, saves, daily stats; checked write functions with the single permission check; `/market`, `/l/:id`, Products/Services tabs on business pages, Manage Business → Listings; listing cards in posts; reports and admin removal; search (full text + trigram); location and hours fields on businesses; fix "Replying to" for business posts | Business profiles (done); media (done) | Owners create, edit, change status and delete listings; nobody else can. Suspended businesses' listings are hidden and can't be edited. Search, filters and sorting return correct results on 10k+ synthetic listings with p95 < 150 ms. Sold or removed listings display correctly from old posts. Removed listing images are queued for cleanup. Admin removal is audit-logged. The switch is off by default and hides everything. Pages work at 375 px with no sideways scrolling. Existing database and offline test suites stay green. |
| **2. Business chat + inbox** | The chat design in §3 (option A): `biz_*` tables, inbox in Manage Business, Message button on businesses and listings, unread counts, `enquiry` notifications + push, block/report, rate limits, Smart FAQs table, verification badge | Your approval of option A + policy wording | Customers never see the owner. Only the customer and the business's managers can read a conversation. No duplicate conversation per (business, customer) unless the customer starts a new enquiry deliberately. Listing context shows in the thread. Personal DM tests stay green and DM tables are untouched. Report and abuse limits work. |
| **3. AI business assistant** | Provider module, usage ledger, quotas, kill switches; *suggested replies* first (owner sends), then grounded automatic answers with labels and handoff | Phase 2; your model choice; API key in Vercel | Every price, stock or availability claim cites a listing. With no source the answer is a handoff. The "talk to a person" button works. An injection test set (≥ 50 adversarial messages and listing texts) leaks no other business's or customer's data and no system prompt. Quotas and switches are enforced on the server. Timeouts fall back cleanly. Logs hold no message text. |
| **4. AI growth tools** | Drafts (owner approval), listing descriptions, aggregate insights (batch), posting-time hints, interest-based marketplace row, guided setup | Phase 3 | Nothing is published without the owner's action. Insights use aggregates only, with a minimum-count threshold. |
| **5. Polish and differentiators** | Better dashboard; Business Worlds; Customer Requests trial | Phases 1–4 | Agreed per feature |
| **Later: transactions** | Orders, payments, refunds, disputes | Separate regulatory and security review | — |

**Why Marketplace comes before business chat:**
- It delivers visible value on its own: catalogue, discovery and sharing.
- It reuses proven infrastructure.
- It doesn't wait on the messaging decision. Until Phase 2, "Contact" uses the business's
  existing contact fields.
- It's the data the AI needs later: listings and prices are what the assistant answers from.

**Running Phases 1 and 2 at the same time:** both are possible once option A is approved,
because they touch separate tables.

---

## 9. Security, privacy, moderation and migration risks

- **Fraud and scams.** Limits:
  - businesses only at first;
  - creation limits (20 listings a day, 200 active per business at first);
  - a prohibited-items list in the Terms (weapons, drugs, counterfeit goods, animals, adult
    content, regulated financial products, and so on), plus category restrictions;
  - report reasons for listings ("scam", "prohibited", "misleading price", "counterfeit");
  - admin removal with an audit log;
  - repeat-offender suspension.
  - **No "buyer protection" wording anywhere**: there are no payments.
- **Impersonation.** Reserved and "Amigo" names are already blocked. Add a verification badge
  that admins grant, and add "verified" filtering later.
- **Privacy:**
  - Business image keys never contain personal IDs.
  - Listing areas are coarse text.
  - Saved listings are private.
  - Statistics are aggregate counts with no viewer IDs.
  - Business chat is labelled; personal DM encryption is unchanged.
- **AI:**
  - Prompt injection: quoted data, no tools, output checking, length caps.
  - The AI doesn't stand for trust: an AI answer never implies that a seller is trustworthy.
  - Abuse: per-customer and per-business limits, and switches.
- **Moderation load.** At this scale, admins review reports by hand. The admin Listings queue
  reuses the content-reports flow, extended to the `listing` target type.
- **Migrations:**
  - New migrations are additive.
  - Business chat uses new tables only; DM tables aren't touched.
  - Adding a notification kind (`alter type … add value`) can't use the new value in the same
    transaction, so it goes in its own migration step.
  - **Football migration ordering:** `20261029090000_football_predictions.sql` is unapplied and
    timestamped earlier than any new file. Either keep it permanently unapplied and documented,
    or rename it to sort after the new work when you revive it. The build script applies files
    in order, so this needs a decision (§12).
- **Rollout.** For each phase:
  1. migration on `verify-1029`, with rolled-back tests and fingerprints;
  2. a Production restore point (Neon branch);
  3. migration;
  4. deploy;
  5. admin turns the feature on, only with your approval.
- **Still open from earlier work:**
  - The daily media cleanup can't run until `CRON_SECRET` and a `media_janitor` login exist.
    Marketplace will add more images, so it should run before Marketplace launches.
  - The encryption-sync timing issue just after sign-up, seen 3 times in 9 runs.

---

## 10. Likely files and components (Phase 1 unless noted)

- **Database:**
  - `supabase/migrations/2026110x_feature_switches.sql`
  - `…_marketplace_listings.sql`
  - (Phase 2) `…_business_chat.sql`
  - (Phase 3) `…_ai_usage.sql`
  - `supabase/tests/database.test.sql` (new sections)
- **Data layer:**
  - `src/data/types.ts` (Listing, MarketplaceApi, later BusinessChatApi and AiApi)
  - `src/data/supabase/marketplace.ts` (new), `src/data/demoMarketplace.ts` (new)
  - `src/data/supabaseSource.ts`, `src/data/demoSource.ts`
  - `src/data/supabase/queries.ts` (listing card on posts; parents with businesses)
  - `src/data/supabase/mediaStore.ts` (purpose `listing`)
- **Screens:**
  - `src/screens/MarketplaceScreen.tsx`, `ListingScreen.tsx`, `ListingEditScreen.tsx` (new)
  - `BusinessProfileScreen.tsx` (tabs, hours, location)
  - `BusinessManageScreen.tsx` (becomes the Manage Business workspace)
  - `AdminScreen.tsx` + `src/features/admin/AdminListings.tsx`
- **Shared UI:**
  - `src/features/marketplace/` (ListingCard, filters, price formatting)
  - `src/features/posts/PostCard.tsx` (listing card, business "Replying to")
  - `src/App.tsx` (routes)
  - navigation (Marketplace entry)
- **Server:** `api/_media.ts` (allowed key shape), `public/sw.js` (photo cache path). Phase 3:
  `api/ai.ts` and `api/_ai.ts`.
- **Tests:**
  - `scripts/test/marketplace.test.mjs` (browser, demo mode)
  - a Neon integration script like `bizint`
  - performance seeding script

---

## 11. Tests per phase

- **Phase 1:**
  - Database: ownership on every write; suspended-business behaviour; status changes;
    prohibited direct writes; admin removal + audit; image key ownership + cleanup queue;
    search correctness (full text, typos, filters); switch off hides everything; grants and
    column privacy.
  - Browser (demo): create, edit and sell a listing; marketplace search and filters; saved
    listings; listing card in a post after it's sold; report; 375 px layout; keyboard and
    screen-reader labels.
  - Neon integration: real sessions, Data API reads and writes, media routes with business
    listing keys.
  - Performance: 10k listings + 50k posts, measured on the branch.
  - Regression: the full existing suites.
- **Phase 2:**
  - Conversation membership and owner-identity privacy across every response.
  - Duplicate-conversation rules; unread counts; notifications and push; blocking and reports
    with server-attached evidence; rate limits.
  - **Personal DM regression:** the live DM test on the branch, the unsend check, and the mobile
    DM smoke test.
- **Phase 3:**
  - Grounding tests: questions answerable from listings or FAQs, and unanswerable ones that
    must hand off.
  - An injection set covering other businesses' data, the system prompt, fake prices and
    "ignore previous instructions" inside listings.
  - Quota and switch enforcement; timeout fallback; usage-ledger accuracy; a check that logs
    hold no message text.
  - A small labelled evaluation set re-run whenever the model or prompt changes.
- **Every phase:**
  - switch on/off behaviour;
  - mobile and accessibility checks;
  - a Production rollout check (schema hashes identical to the tested branch; data fingerprints
    unchanged).

Each report will separate tests actually run from code inspection, mocks and assumptions.

---

## 12. Decisions needed from you

1. **Business chat model: ✅ option A approved (2 Nov 2026).** A separate business chat,
   labelled not end-to-end encrypted; personal DMs unchanged. Still to agree before Phase 2
   ships: the exact customer-facing wording and the Privacy Policy update.
2. **Who can sell in Phase 1:** businesses only (recommended), or personal sellers too.
3. **Market, currency and taxonomy:** NGN, businesses only (Phase 1, as built). **✅ Category list
   approved (2 Nov 2026):** 12 product and 9 service categories, as in
   `20261102090000_marketplace.sql`; whole vehicles, property and animals left out because of
   fraud risk. Still open: one city or region first for the launch group.
4. **Prohibited-items policy:** approve a list for the Terms and Community Guidelines.
5. **AI provider and models:** for example Haiku 5.5 for customer answers and Sonnet 5.5 for
   drafting, or another provider. Monthly budget cap and per-business quotas. Adding the API
   key to Vercel is something you do.
6. **AI on customer chats:** approve starting with owner-approved *suggested replies* only, and
   automatic answers only after the Phase 3 tests pass.
7. **Feature-switch table:** approve replacing the single `business_settings` switch with a
   general switch table (the business switch is kept compatible).
8. **Football migration:** keep it unapplied and documented, or renumber it now.
9. **Media cleanup cron:** create the `media_janitor` login and `CRON_SECRET` in Vercel before
   Marketplace launch (secrets you set).
10. **Phase 1 go-ahead:** build the Marketplace foundation on this branch, local and
    `verify-1029` only, with no commit, deploy or Production change until you say so.
