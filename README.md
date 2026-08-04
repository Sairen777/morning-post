# Morning Post App

Morning Post v1 is an open-source application designed for self-hosted,
single-owner deployment: one primary user per instance, with one local
database and media store. Authentication, ownership scoping, and credential
encryption are deliberate security measures that protect the single-owner
deployment posture while keeping future deployment options open.

X posts, Lists, and X Chat group conversations can be collected through the
TwexAPI HTTP provider: connection uses a TwexAPI API key, the X
`auth_token`, and the complete X Cookie header, all stored envelope-encrypted.
No browser automation or Chromium profile is involved.

## Setup

```sh
git config core.hooksPath .githooks
```

This activates the pre-push hook that runs tests before every push.


### Bun runtime and production boundary

The repository is pinned to Bun 1.3.14. Bun installs the root package and the
`apps/web` workspace together, runs the backend and frontend scripts, and
provides the backend test runner. Backend scripts explicitly load
`.env.production.local`.

Bun uses the ordinary process environment and Node-compatible filesystem,
DNS, network, and native-module APIs; it does not enforce a runtime permission
profile. Treat the application process as having the operating-system
permissions of its account: run it as a dedicated, least-privileged user,
restrict credential and media paths at the filesystem level, and enforce
outbound network policy outside the runtime when deployment policy requires it.

The production server binds to `127.0.0.1:3000` by default.
`SERVER_HOSTNAME` selects the listener hostname: an explicit server override
takes precedence, then `SERVER_HOSTNAME`, then the loopback default. Keep the
loopback default when a reverse proxy is the public endpoint; set
`SERVER_HOSTNAME=0.0.0.0` only when intentionally exposing the listener
directly.


## Running Locally

### Prerequisites
- [Bun](https://bun.sh/) 1.3.14
- [Node.js](https://nodejs.org/) 22.13+ (frontend and Playwright E2E toolchain)
- [SQLite](https://sqlite.org/) is built into Bun; no separate database service is required
- [OpenSSL](https://www.openssl.org/) (for generating the credential master key)
- Playwright Chromium for the browser E2E suite (`bun run web:e2e`); the X connector needs no browser

### Database

Morning Post stores its data in a local SQLite file. By default it uses
`./data/morning-post.sqlite`; set `DATABASE_PATH` to choose another local file.
The database client creates the parent directory automatically, and
`bun run db:migrate` applies pending migrations. Keep the database on storage
local to the single application host, and back up the database together with
its `-wal` and `-shm` companions while the application is stopped.

### Environment

Copy `.env.example` to `.env.production.local` and configure the values needed
by the integrations you use. Bun scripts load this file explicitly with
`--env-file=.env.production.local`; do not commit the copied file because it
contains deployment credentials. The main settings are:

| Variable | Purpose | Default |
| --- | --- | --- |
| `DATABASE_PATH` | Local SQLite database file | `./data/morning-post.sqlite` |
| `CREDENTIAL_MASTER_KEY` | 32-byte base64 key for credential encryption. Generate: `openssl rand -base64 32` | (required) |
| `TELEGRAM_API_ID` | Telegram API ID from [my.telegram.org/apps](https://my.telegram.org/apps) | (required for Telegram) |
| `TELEGRAM_API_HASH` | Telegram API hash (same page) | (required for Telegram) |
| `SUMMARIZER_MODEL` | Deployment-wide text summarization model | `local-model` |
| `SUMMARIZER_BASE_URL` | OpenAI-compatible text endpoint root | `http://127.0.0.1:1234/v1` |
| `SUMMARIZER_API_KEY` | Optional bearer token for the text provider | (optional) |
| `VISION_MODEL` | Deployment-wide vision model | resolved `SUMMARIZER_MODEL` |
| `VISION_BASE_URL` | Vision endpoint root when distinct; inherited from the text endpoint for same-model routing | (required only for an explicitly distinct vision model) |
| `VISION_API_KEY` | Optional bearer token for the vision provider; inherited for same-model routing | (optional) |
| `PORT` | API server port | `3000` |
| `SERVER_HOSTNAME` | API listener hostname; explicit server overrides take precedence, then this value, then the built-in default | `127.0.0.1` |
| `ALLOWED_ORIGINS` | Comma-separated allowed origins for Origin-guard | `http://127.0.0.1:5173,http://localhost:5173` |
| `TRUSTED_PROXY_COUNT` | Number of trusted proxies for client IP in rate limiting | `0` |
| `MAX_REQUEST_BODY_BYTES` | Maximum JSON request body size | `1048576` (1 MiB) |
| `ALLOW_REMOTE_SUMMARIZATION` | Allow non-loopback summarizer providers | `false` |
| `CONNECTOR_TIMEOUT_MS` | Connector call timeout in milliseconds | `120000` |
| `TWEXAPI_BASE_URL` | TwexAPI provider root used by the X connector; explicit server overrides take precedence, then this value, then `https://api.twexapi.io`; must be an absolute HTTPS URL without credentials, query, or fragment | `https://api.twexapi.io` |
| `X_CACHE_COVERAGE_TOLERANCE_MS` | X cache edge tolerance: suppresses only small uncovered head/tail slivers of a requested window that touch a window edge and are no wider than this, and only when some coverage exists inside the window; fully uncovered windows and internal gaps always fetch; `0` disables suppression | `600000` (10 min) |
| `SUMMARIZER_TEXT_BYTES_PER_CHUNK` | Max text bytes per summarizer chunk | `120000` |
| `SUMMARIZER_MAX_ITEMS_PER_CHUNK` | Max items per summarizer chunk | `50` |
| `SUMMARIZER_MAX_IMAGE_BYTES` | Oversize images become `[IMAGE_OMITTED]` | `1000000` |
| `SUMMARIZER_TIMEOUT_MS` | Per-attempt model request timeout | `120000` |
| `SUMMARIZATION_CONCURRENCY` | Max concurrent feed summarizations per run | `2` |
| `MEDIA_TTL_MS` | Media file TTL | `604800000` (7 days) |
| `MEDIA_QUOTA_BYTES` | Per-connector media quota | `524288000` (500 MiB) |
| `DIGEST_RUN_STALE_AFTER_MS` | Stale digest-run threshold for recovery | `900000` (15 min) |

#### Summarization reliability

Aggregate input is split by the configured item and UTF-8 text-byte limits.
When chunk results cannot fit one merge request, they are reduced through
hierarchical text-only merge batches bounded by serialized UTF-8 content bytes
and an item cap of `max(2, SUMMARIZER_MAX_ITEMS_PER_CHUNK)`. An odd level may
leave a trailing singleton batch. The guaranteed invariant is that every
non-final level reduces the item count—not that every non-final batch has a
fan-in of two or that a configured item cap of one is strictly honored—and the
hierarchy ends with one final merge.

Transient provider failures retry up to three total attempts, each with a fresh
`SUMMARIZER_TIMEOUT_MS` per-attempt deadline. Retries cover HTTP fetch/body
`TypeError`, HTTP 429/503 responses, and the summarizer's internal per-attempt
`TimeoutError`. Caller cancellation and nonretryable errors do not retry. A
separate whole-operation watchdog conservatively covers all attempts, distinct
vision analysis, and hierarchical merges, and is capped at three hours.

For distinct vision analysis, duplicate entries for the same expected item
index are trimmed, exact-deduplicated, and merged in provider response order.
Missing or invalid indexes still produce the nonterminal text-only fallback
rather than attaching an analysis to the wrong item.

#### Operational diagnostics

Digest and per-feed terminal status remains queryable in the
`digest_runs` and `digest_run_feeds` tables. Terminal summarization chunk,
merge, and feed failures, plus the nonterminal `vision_unavailable` fallback,
are appended to `.debug_logs/operations.jsonl`; recovered retry attempts are
not recorded there. The file rotates to `operations.jsonl.1` at 5 MiB. Entries
contain epoch-millisecond timestamps, run/feed identifiers, connector and
item/chunk counts, model names, and redacted errors. They never contain prompts,
normalized item text, images, or raw model output. A `vision_unavailable`
warning is non-terminal: summarization continues with the text-only fallback.

#### Session behavior

Sessions use the `__Host-session` cookie (HttpOnly, Secure, SameSite=Lax, Path=/).
Tokens are stable — concurrent SPA requests do not invalidate one another. Idle
sessions expire after 30 days; active use extends the expiry without changing the
token. Explicit logout revokes the token immediately.


### Migrations

```sh
bun run db:migrate
```

### Commands
The local Hono backend runs on `Bun.serve` and listens on
`127.0.0.1:3000` by default. Croner runs UTC five-field digest and media
housekeeping schedules with in-process overlap protection.

| Task | What it does |
| --- | --- |
| `bun run dev:cli` | Run the pipeline once (fetch → summarize) with file watching |
| `bun run dev:api` | Start the watched API server on loopback `127.0.0.1:3000` by default |
| `bun run start` | Start the API server without watch mode |
| `bun run test` | Run the 507-test backend suite with `bun:test` |
| `bun run typecheck` | Type-check the backend and web workspace |
| `bun run db:generate` | Generate a Drizzle migration |
| `bun run db:migrate` | Apply pending migrations |
| `bun run db:reset` | Delete the local SQLite file and its WAL/SHM companions, then reapply all pending migrations |

### Frontend

The web frontend is a SolidStart SPA (client-side rendering only) served by
Vinxi at `127.0.0.1:5173`. Its Vite proxy forwards API calls, including
`/health`, to the Bun backend at `127.0.0.1:3000`.

**Pre-flight.** Before the first frontend run:

1. Install workspace dependencies:

   ```sh
   bun install
   ```

2. Install Playwright's Chromium browser binary for the browser E2E suite
   (`bun run web:e2e`) if it is not already present:

   ```sh
   bunx playwright install chromium
   ```

3. Optionally set `DATABASE_PATH` in `.env.production.local`; otherwise the
   backend uses `./data/morning-post.sqlite`.

4. Apply migrations (the database parent directory is created automatically):

   ```sh
   bun run db:migrate
   ```

**Smoke test** (browser):

```sh
# Terminal 1: backend
bun run dev:api

# Terminal 2: frontend
# `bun run web:dev` invokes `vinxi dev --port 5173`; the outer listener is fixed to 127.0.0.1
bun run web:dev
```

#### API pagination

`GET /digests` and `GET /digests/runs` return `{ data, nextCursor }` where
`data` is an array and `nextCursor` (when present) can be passed as
`?cursor=<value>` to fetch the next page. The web UI provides a "Load more"
button that appends results without duplicates and resets the cursor after a
new run, delete, or refresh.

#### Per-feed summary detail

Summary detail is configured on each individual feed: every Telegram channel,
Substack publication, or other subscription can use **Standard**
(`basic`) or **Thorough** (`thorough`). Feeds under the
same connected source remain independent, so changing one channel or publication
does not change its siblings. The web UI labels the selector with the feed name
and saves changes through `PATCH /feeds/:id`.

Standard is the default for a newly created or revived feed unless its create
or update request explicitly supplies another mode. Feed API projections always
include `summarizationMode`; source projections and source create/PATCH inputs do
not. When one story combines items from multiple feeds, Thorough wins if any
contributing item belongs to a Thorough feed. Otherwise the story uses Standard.

During upgrade, the migration first adds the non-null
`feeds.summarization_mode` column with a `basic` default and a
`basic | thorough` check, then copies each parent source's previous setting to
all of its existing feeds. Only after that backfill does it remove the old
source-level check and column, preserving every existing feed's effective
setting while making later changes independent.

#### Active digest runs

One running digest per user is intentional. After a Dashboard reload, the
initial run-status check restores any persisted running state; duplicate
submission remains blocked until that check settles. While a run is active, the
Dashboard polls its status every five seconds without overlapping requests and
refreshes the digest list when the run reaches a terminal state. If a
`POST /digests/run` request loses a race and returns `409`, the Dashboard maps
the conflict to the active-run UI instead of displaying raw error text.

API startup and each scheduler tick transactionally recover digest runs
older than `DIGEST_RUN_STALE_AFTER_MS`. Recovery marks the stale run and only
its still-running feed stages as failed, which releases the per-user lock.
Fresh running rows remain untouched so another live API instance can finish
its work safely.

Open `http://127.0.0.1:5173`. On first run, navigate to `/auth/setup` and
choose the name shown in your digests. Setup creates the owner and starts the
session without an account password. After logout or session expiry, a
passwordless owner can use the one-click continuation screen; upgraded owners
whose existing row still has a password hash continue to sign in with that
password. Click "Run digest" and verify the digest appears with status
`complete`.

Passwordless continuation makes the deployment boundary the access boundary:
anyone who can reach the unauthenticated app can start an owner session. Keep
the default listener on loopback, or put non-loopback access behind an
operator-controlled authenticated reverse proxy, VPN, or equivalent network
control. Existing password-backed owners retain their additional credential
check.

**Automated tests:**

| Command | What it does |
| --- | --- |
| `bun run test` | Full backend suite (`bun:test`) |
| `bun run db:cleanup` | Destructively delete application rows from the local SQLite database while preserving its schema and migration history |
| `bun run db:reset` | Destructively delete the local SQLite file and its WAL/SHM companions, then reapply migrations |
| `bun run web:test` | Frontend unit/component suite (Vitest) |
| `bun run web:typecheck` | Web TypeScript type checking |
| `bun run web:build` | Production web build |
| `bun run web:e2e` | Playwright smoke tests with dedicated backend/frontend processes and an isolated database |

`bun run db:cleanup` clears application data from the local development SQLite
file selected by `DATABASE_PATH` (default `./data/morning-post.sqlite`) while
preserving the schema and applied migration records. It refuses in-memory or
URL-style paths and refuses a path configured as the test or E2E database.
This command is destructive and cannot be undone.

`bun run db:reset` closes and deletes that local SQLite file together with its
`-wal` and `-shm` companions; the command then reapplies all pending migrations.
It uses the same local-file and test/E2E path guards. This is a full rebuild,
unlike `db:cleanup`, and cannot be undone.

Backend database tests use a fresh in-memory SQLite database for each callback
and close it afterward. The E2E command never reuses the development servers or
database. It serves the API on `127.0.0.1:3100`, the web app on
`127.0.0.1:5174`, and uses `E2E_DATABASE_PATH` (default
`./data/morning-post-e2e.sqlite`). The path must be a local `.sqlite` file whose
name identifies it as E2E and must differ from `DATABASE_PATH` and
`TEST_DATABASE_PATH`. E2E setup and teardown remove the file and its `-wal` and
`-shm` companions.

**Verify in the database** after a browser smoke run:

```sql
select id, created_at from users order by created_at desc limit 5;
select id, user_id, status, period_start_ms, period_end_ms, created_at
from digests order by created_at desc limit 5;
select id, user_id, connector_id, enabled, created_at
from sources order by created_at desc limit 5;
select id, source_id, external_id, name, kind, enabled, last_fetched_period_end_ms
from feeds order by created_at desc limit 10;
```

The `users` table has an internal `email` column (unique, non-null) that
carries `owner@morning-post.invalid` for the owner; it is not a login identity
or public profile field.

## Get Telegram Credentials

1. Open [https://my.telegram.org/apps](https://my.telegram.org/apps)
2. Log in with your Telegram account
3. Create a new app and note down the `API ID` and `API Hash`
4. Set them in `.env.production.local`:
   ```
   TELEGRAM_API_ID=your_api_id
   TELEGRAM_API_HASH=your_api_hash
   ```

## Get Telegram Session String

The app authenticates via QR code on first run and prints a session string so
you don't have to log in again. Run `bun run dev:cli`.

1. Leave `TELEGRAM_SESSION` empty in `.env.production.local`
2. Run `bun run dev:cli`
3. Scan the QR code in Telegram: **Settings → Devices → Link Desktop Device**
4. The session string will be printed to the console — copy it
5. Set it in `.env.production.local`:
   ```
   TELEGRAM_SESSION=your_session_string
   ```

## What the Telegram Connector Ignores

- **Polls** — messages whose only content is a poll (no text, no photo) are
  skipped
- **Stickers, reactions, and other media-only messages** — anything with no text
  and no photo/video/document/webpage is skipped

## Non-obvious Gotchas

**Groups vs channels detection** Supergroups are technically `Api.Channel` in
GramJS with a `megagroup: true` flag — checking `instanceof Api.Channel` alone
does not distinguish them from broadcast channels. Basic groups are `Api.Chat`.

**Photos are not downloaded for groups** Group chat photos are usually memes and
would waste vision tokens. Photo download only runs for broadcast channels;
group messages silently drop photo media.

**Pure emoji messages are filtered before summarization** Messages with no
letter characters (`👍`, `😂🔥`) are dropped. Short word replies like "yes" or
"no" pass through since they contain letters.

**Quote fetching is best-effort** Quoted/replied-to messages are batch-fetched
after iteration and prepended as `[QUOTED_MESSAGE]...[/QUOTED_MESSAGE]`. If the
fetch fails (e.g. deleted message, permission error), the main message is still
kept — the quote is just omitted silently.

**Album grouping** Photos sent as an album share the same `groupedId`. They are
merged into a single item with `type: "album"` — only one of the album messages
typically carries the caption text.

**Context overflow for large group chats** All group messages are sent in a
single summarizer request. Threads with 300+ messages may overflow the model's
context window. See the comment in `openai-compatible-summarizer.ts` for options
(hard cap, time-window cap, chunked summarization).

**Anonymous admins posting as the channel** In supergroups, admins can post
anonymously — their `message.sender` is the group's linked channel rather than a
`User`. These show up with the channel title as the author name.

## X Connection (TwexAPI)

Morning Post collects posts from X Lists and messages from X Chat group
conversations through the TwexAPI HTTP provider. There is no browser
automation, Chromium profile, or installed Chrome: the connector speaks HTTPS
to the Twex API and stores only encrypted credentials locally.

### Connection inputs

**Connections → X** submits exactly
`{ apiKey, authToken, cookie, pin?, listQuery? }` to
`POST /connectors/x/session`:

- **TwexAPI key** (`apiKey`) — the API key issued by TwexAPI.
- **X `auth_token`** (`authToken`) — the value of the X `auth_token` cookie,
  kept separate from the cookie header; it identifies the account through
  `GET /twitter/{auth_token}/user_info`.
- **Complete Cookie header** (`cookie`) — the full X `Cookie` header value as
  copied from X, required for XChat endpoints. It must contain a nonempty
  `auth_token` pair equal to the separately provided `authToken` and a
  nonempty `ct0` pair; duplicate `auth_token` or `ct0` pairs and control
  characters are rejected without echoing either value.
- **XChat PIN** (`pin`, optional) — the XChat identity PIN sent only with
  DM-history requests; conversation discovery does not use it. When omitted,
  DM history uses the default `1234`.
- **List search query** (`listQuery`, optional) — the query used for list
  discovery; a blank value derives from the authenticated X username.

The web form always supports connect and reconnect, renders every secret field
as a password input, sends the exact request above, clears the secret fields
on success, and retains the nonsecret list-search query. Secrets are
envelope-encrypted (AES-256-GCM with owner-bound AAD) before they are stored;
they are never returned by the API and never written to logs.

### Endpoints and provider limitations

- User info: `GET /twitter/{auth_token}/user_info` (API key as bearer token).
- List discovery is **search-based**: `POST /twitter/list/search` returns
  lists matching `listQuery`. TwexAPI provides no owned-lists lookup, so
  discovery reflects search results rather than the account's own lists.
- List tweets: `POST /twitter/list/tweets/page` paginates posts for
  `x:list:<numeric-id>` feeds.
- XChat discovery is **group-only**: `POST /v3/twitter/conversations` receives
  the full cookie and yields direct and group conversations, but only group
  conversations become feeds (`x:chat:<conversation-id>`); direct chats are
  excluded and can never be cataloged, so a crafted direct-DM target is
  rejected at subscription time.
- XChat history: `POST /v3/twitter/dm-history` receives the full cookie (never
  the bare auth token) plus the PIN, and is fetched with `all: true` and
  `count: 200`. At most one DM-history request is made per feed per connector
  operation: an all-mode response that still claims more history is durably
  persisted and surfaced as a resumable local error, so the next run resumes
  once from the saved cursor via `before`. Per range, at most two DM-history
  requests are ever made: if the resumed response is still incomplete, later
  overlapping runs fail locally before any DM-history request, and the
  retained progress intentionally blocks repurchasing until the operator
  disconnects and reconnects X; the identity-less reconnect resets the X
  cache, subscriptions, and progress. Messages may include disappearing
  messages captured before they disappear.
- No credentials are bundled with Morning Post and the application never
  performs a live X login: the operator supplies their own TwexAPI key, X
  auth token, and cookie. The X session material is forwarded to the
  configured TwexAPI provider, so the provider is part of the trust boundary.

### Feed identity and pagination

Discovery emits only `x:list:<positive-numeric-id>` and group-only
`x:chat:<conversation-id>` feed identifiers. Group labels include the
participant count and the conversation ID. List-tweet pagination continues
until the inclusive requested lower bound is reached or the provider is
exhausted. Every successful page
is durably recorded before the next provider request, so a failed or
interrupted run leaves the items and the next cursor behind and a retry
resumes the range from the saved cursor instead of repurchasing page 1; a
failed attempt never advances progress. Each page's cursor is appended to the
range's durable bounded history (newest 500), so a repeated or cyclic cursor
— including cycles across process or connector restarts — is detected in the
same atomic write that saves the page and its items, which then terminally
blocks the range (`repeated_cursor`); an incomplete page with no resume
cursor saves the page and terminally blocks the range (`missing_cursor`).
Terminally blocked progress fails locally before any provider request on
later overlapping runs until the operator disconnects and reconnects X. Chat
ranges make at most one
DM-history request per connector operation: an incomplete all-mode response is
persisted and then raised as a resumable local error, and the next operation
resumes once with `before` from the saved cursor. A chat range is limited to
two DM-history requests in total — after a second incomplete all-mode
response, later overlapping runs fail locally before any DM-history request,
and the retained progress intentionally blocks repurchasing until the operator
disconnects and reconnects X; the identity-less reconnect resets the X cache,
subscriptions, and progress.

### Caching and account identity

Raw X posts and chat messages are persisted in SQLite (`x_content_cache_items`,
migration `0002`) with inclusive coverage ranges per source and feed
(`x_content_cache_ranges`). Every valid dated item returned by a successful
provider page — paid data — is cached regardless of whether it falls inside
the requested digest window, so a page fetched to cover one window never
discards items outside it. Coverage rows record the exact inclusive requested
periods (for example 13:00–19:00, both bounds inclusive) as a ledger distinct
from item timestamps and from fetch progress: an item's date may lie anywhere
in a fetched range, while coverage states only which requested periods were
fully fetched. A successful empty fetch still establishes coverage, so only
uncovered gaps call the Twex API. Reads are ordered stably by date then
external ID.

Fetch progress for ranges whose coverage is not yet committed is persisted in
`x_content_fetch_progress` (migrations `0005`, `0006`). Every successful
provider page is durably recorded — items, the next cursor, a page count, and
the page's cursor appended to a bounded history of the newest 500 cursors —
before another provider request, and coverage is committed only when the
whole range is complete; failed requests advance nothing. A successful page,
complete or incomplete, commits before an abort racing the response is
propagated, so cancellation can never discard fetched items, cursors, or
coverage; the next iteration's pre-request check still blocks further HTTP. A
retry therefore resumes the saved cursor instead of re-fetching pages, and a
run whose window is already covered makes zero provider calls. The progress
row is deleted when its range commits. Pending progress is resumed only when
it intersects a required gap of the current window: pending ranges outside
those gaps never force a provider call, and the required gaps are re-derived
after each resumed range commits. An account-identity reset deletes pending
progress along with the cached items and ranges.

`X_CACHE_COVERAGE_TOLERANCE_MS` (default `600000`, 10 minutes; `0` disables)
suppresses only small uncovered head/tail slivers of a requested window: a gap
is skipped solely when it touches a window edge, is no wider than the
tolerance, and real coverage exists inside the window; a wholly uncovered
window and any internal gap are never suppressed. For example, with exact
coverage 13:00–19:00 and a request for 12:50–19:10, both 10-minute edge
slivers fall inside the tolerance, so the run makes zero provider calls and
returns the cached messages. Suppressed gaps are not recorded as covered —
stored ranges keep the exact inclusive requested periods — so the bounded risk
is explicit: messages that fall only inside a tolerated edge sliver may be
omitted by policy until a future request actually fetches that sliver. Safety
limits are enforced against the durable page count before any further request:
a chat range makes at most two DM-history requests in total, and any range can
become terminally blocked. A repeated or cyclic list cursor is detected from
the durable cursor history inside the atomic page write (`repeated_cursor`),
an incomplete page without a resume cursor blocks with `missing_cursor`, and
a DM-history response for a different conversation than the one requested is
fail-closed: no foreign messages are cached and an empty blocked page is
persisted with `mismatched_conversation`. Terminal blocks are written
atomically with the page that exposed them and are never cleared by later
normal pages; any later overlapping run whose required gaps include a blocked
range fails locally before any provider request, so the retained progress
intentionally blocks repurchasing until the operator disconnects and
reconnects X; the identity-less reconnect resets the X cache, subscriptions,
and progress.

Every `sources.credential_revision` starts at 1 and increments on each
credential replacement, reconnect, or disconnect (migration `0003`). Each
decrypted credential snapshot binds its X content cache and ingestion handle
to the captured revision. Fetch-planning reads — the missing-range and
pending-progress lookups that decide whether the provider is called —
preflight the source revision and the feed's active state (enabled, not
soft-deleted) before any connector HTTP, so a stale or disabled feed cannot
purchase paid pages; the raw cache read is source-revision-fenced only. Raw
cache writes are atomically source-revision plus active-feed guarded: the
per-page progress write and the final coverage commit recheck the revision
and the feed's active state inside the same immediate transaction, so they
write nothing once the source was disconnected, disabled, or reconnected in
the meantime. Normalized ingestion remains feed-fenced: every ingestion mode
carries the snapshot's `sourceCredentialRevision`, and the write transaction
requires the source to still be connected and enabled at that revision and the
feed still enabled and not soft-deleted before upserting items or advancing
the watermark.
The same guard carries through digest generation: every contributing X feed's
revision (recorded at ingestion or acceptance) is re-asserted before item
selection, immediately before and after every intelligence and summarizer
await so no model-derived analysis, resolution, classification, or summary is
persisted from a stale connection, immediately before the final story
replacement commits, and once more before the digest is marked complete — a
mismatch aborts the run. Beyond those boundary checks, a synchronous
per-attempt assertion runs immediately before every outbound model HTTP
request: each retry of a chat completion, semantic/member/split recovery
retries, summarizer single/batch/vision and text-only-fallback calls, and
every classification call. Revoked X content is therefore fenced before it is
even sent to a model, not merely excluded from persisted output.

Reconnect compares the source state captured before provider validation with
the state inside the immediate commit; a concurrent disconnect or reconnect
aborts with a fixed retry conflict. Reconnecting the same derived X user
preserves the previously committed cache and feed subscriptions but still
increments the revision and conservatively fences every older in-flight
handle; a changed, legacy, disconnected, or undecryptable identity instead, in
the same immediate transaction, deletes the source's raw X cache (items,
coverage ranges, and pending fetch progress), deletes its normalized items
(including those of
soft-deleted feeds, whose rows a later revival would reuse), clears the
discovery catalog, soft-deletes the source's X feeds, and only then stores the
new encrypted credentials. Disconnect itself clears credentials, disables the
source, soft-deletes active feeds, and revokes the catalog without deleting
captured content; the identity-less reconnect after a disconnect takes the
same full-reset path because no stored identity survives to be compared.

The web Dashboard clears each source's discovered and loaded feed state on
disconnect, and clears the X source's state both before and after a reconnect,
so a preserved or recreated source id can never expose stale groups or lists:
fresh discovery is required after any reconnect. Clearing bumps a per-source
state version, and an in-flight loaded-feed refresh is applied only when its
captured version still matches and the source's state was not cleared in the
meantime — a late refresh resolving after a disconnect or reconnect cannot
resurrect the cleared lists or groups.

### Discovery catalog and subscription

Successful X discovery (`GET /sources/:sourceId/available-feeds`) is
revision-revalidated and then atomically replaces the source's whole discovery
catalog in one immediate transaction: the catalog holds exactly the Lists and
group chats the provider returned for that credential revision, stored in
plaintext in `x_discovered_feeds` (migration `0004`, unique on
`(source_id, credential_revision, external_id)` and cascade-deleted with the
source). Subscription (`POST /sources/:sourceId/feeds`) makes no TwexAPI
rediscovery call: in the same immediate transaction that locks the source row
it accepts only a target with an exact current-revision catalog entry, uses
the server-canonical catalog name and kind instead of any client-supplied
metadata, and rejects malformed identifiers as validation errors and
uncataloged targets — including direct-DM conversations, which discovery never
returns — with a conflict instructing a fresh discovery. Discovery and
subscription stay available for connected-but-disabled sources: `enabled`
gates only digest inclusion and ingestion, not authorization. Active X feeds
are capped at 250 per source; a subscription that would leave more than 250
active (not soft-deleted) feeds is rejected inside the same transaction,
mirroring the connector's per-batch limit.

### Base URL

The Twex API base URL resolves by explicit server override, then
`TWEXAPI_BASE_URL`, then `https://api.twexapi.io`. The resolved value must be
an absolute HTTPS URL without embedded credentials, query parameters, or
fragments — anything else fails configuration visibly. Every request uses the
API key as a bearer token and sets `redirect: "error"`, so an HTTP downgrade
or a redirecting endpoint is rejected rather than followed; a non-loopback
provider means X session material leaves the host.

### Unsupported provider risk

TwexAPI is an independent, unofficial X data provider, not an official X
integration surface. It can change endpoints, response schema, or
availability, and its terms may conflict with X's. Operators assume the
account and policy risk of sharing session material with the provider.

### Retention

Captured raw X posts and messages—including disappearing messages captured
before they disappear—and their normalized item rows are retained until an
account-identity reset removes those rows: disconnect preserves them, and a
same-account reconnect preserves committed content and subscriptions while
fencing older handles. Only a reconnect to a changed or unknown identity
(legacy, undecryptable, or disconnected-then-reconnected) deletes the raw
cache and normalized items, clears the discovery catalog, and soft-deletes the
feeds before the new credentials are stored. The connection reset is not a
general erasure operation: already materialized stories, summaries, feedback,
digest artifacts, and other derived records remain governed by the
application's existing retention behavior. Capture therefore overrides X
disappearance after ingestion. Configurable cascading retention remains
deferred; there is currently no retention environment variable or UI control.

### Contract tests

The deterministic suite never contacts TwexAPI; X connector behavior is
exercised with official-contract fixtures and mocked HTTP only, so
`bun run test` runs without credentials or provider network access.
