# Morning Post App

Morning Post v1 is an open-source application designed for self-hosted,
single-owner deployment: one primary user per instance, with one local
database and media store. Authentication, ownership scoping, and credential
encryption are deliberate security measures that protect the single-owner
deployment posture while keeping future deployment options open.

X posts, Lists, and X Chat conversations are collected from rendered `x.com`
pages through a dedicated app-owned browser profile. The browser channel is
installed stable Chrome by default — including when `X_BROWSER_CHANNEL` is
omitted — and bundled Playwright Chromium is available only as an explicit
`X_BROWSER_CHANNEL=chromium` test or diagnostic selection. Morning Post does
not use the X API or a third-party X content API.

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
- [Node.js](https://nodejs.org/) 22.13+ (frontend and Playwright toolchain)
- [SQLite](https://sqlite.org/) is built into Bun; no separate database service is required
- [OpenSSL](https://www.openssl.org/) (for generating the credential master key)
- Installed stable [Google Chrome](https://www.google.com/chrome/) — the default X browser channel, also when `X_BROWSER_CHANNEL` is unset
- Playwright Chromium (`bun run playwright:install`) for the ordinary hermetic X DOM regression suite, browser E2E tests, or an explicit `X_BROWSER_CHANNEL=chromium` selection

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
| `X_BROWSER_PROFILE_ROOT` | Dedicated app-owned X browser profiles; restrict this account-equivalent path to the Morning Post process user | `.x-browser-profiles` |
| `X_BROWSER_CHANNEL` | X browser binary: installed stable Chrome (default) or bundled Playwright Chromium (explicit test/diagnostic selection) | `chrome` — also when unset |
| `X_BROWSER_LOGIN_TIMEOUT_MS` | Maximum time allowed for one headed X connection session | `900000` (15 min) |
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

2. Install bundled Chromium for the ordinary hermetic X DOM regression suite,
   browser E2E tests, or an explicit `X_BROWSER_CHANNEL=chromium` selection.
   The default installed Chrome runtime — used even when
   `X_BROWSER_CHANNEL` is unset — does not require this download:

   ```sh
   bun run playwright:install
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
| `bun run test:x:live` | Opt-in contract check against an already authenticated managed X profile and target |
| `bun run playwright:install` | Install the pinned Chromium build used by Playwright |
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

## X Browser Connection

Morning Post collects the authenticated owner's Following feed, selected public
or private Lists, and selected X Chat conversations through rendered browser
pages. Direct and group conversations use the same explicit target model:
discovery consumes only rendered canonical `/i/chat/<opaque-id>` links. A
visible or accessible title is used when present; otherwise the deterministic
fallback names the opaque conversation without classifying it as direct or
group.

**Upgrade from the retired API connector.** Migration `0007` disconnects the
existing X source and soft-deletes its feed subscriptions because encrypted API
credentials cannot become a browser profile safely. After migrating, connect X
again and re-add the desired Following, List, and Chat targets through rendered
browser validation. Previously captured items and downstream digest data remain
intact; non-X sources and feeds are unchanged.

### Browser independence and app-owned profile

**Connections → X** always uses a dedicated persistent profile beneath
`X_BROWSER_PROFILE_ROOT`, separate from every daily Safari, Firefox, Chrome,
or other browser profile — including the operator's daily Chrome profile.
Installed stable Chrome is the default channel, also when `X_BROWSER_CHANNEL`
is unset. Connect launches installed stable Chrome directly for manual
authentication. After that process fully exits, Playwright reopens the same
app-owned profile with installed stable Chrome for headed verification and
headless discovery or collection. Headless scheduled collection therefore
runs on installed stable Chrome with the same dedicated persistent profile —
never a disposable or random profile. An explicit `X_BROWSER_CHANNEL=chromium`
selection uses Playwright's bundled Chromium build for the complete headed and
headless flow; install it with `bun run playwright:install`. Do not switch an
existing profile between browser channels.

The app-owned profile contains authenticated X cookies and local storage. Treat
it as a credential artifact: run Morning Post as a dedicated user, restrict the
profile root to that user, and include the directory in backup and destruction
procedures. The profile root is ignored by Git. Disconnecting X commits the
source disconnection before deleting the profile under its exclusive lease. An
unmanaged installed-Chrome shutdown releases that lease only after the tracked
child process actually exits. Shutdown uses bounded SIGTERM and SIGKILL waits;
if exit cannot be confirmed, closing fails, retains the lease, and can be
retried. A controlled Playwright session releases its lease only after its
persistent context closes or its backing Browser disconnects. If filesystem
cleanup fails, retrying disconnect retries the idempotent cleanup.

### Connection and collection flow

With `X_BROWSER_CHANNEL=chrome` (the default), Connect X opens a dedicated
**headed** installed-Chrome window outside Playwright. Sign in to X directly in that
window, complete 2FA or platform challenges, open or unlock X Chat if
necessary, then fully quit Chrome before selecting Verify. Verify opens a
Playwright-controlled headed installed-Chrome context against the same
profile. With `X_BROWSER_CHANNEL=chromium`, Connect opens the controlled
headed Chromium context directly. It can remain open through Verify; if it is
fully closed first, Verify reopens the same profile. A failed reopen or
transient inspection remains retryable and never deletes the profile.
Morning Post never receives the X password. Verification accepts only
account-specific authenticated UI and records only the app-owned profile
identifier in the encrypted source credential. The web UI stores only the
opaque active login-session ID in browser `sessionStorage`; switching
Dashboard tabs or remounting the panel resumes status polling and Verify/Cancel
controls.

After connection, feed discovery and digest runs reuse the profile
**headlessly with installed stable Chrome (the default channel) and the same
dedicated app-owned persistent profile**. The connector discovers Following,
Lists, and accessible Chat conversations from rendered canonical
`/i/chat/<opaque-id>` links and any visible or accessible titles; results
deduplicate by canonical ID and a rendered name is preferred over the
deterministic fallback, while invalid, control, or cross-origin links are
ignored. Adding a canonical X
target validates browser-rendered evidence and persists the feed in the same
connector request; the generic feed endpoint cannot create X targets
independently.
A source can have at most 250 non-deleted X targets. The add/revive transaction
rejects the 251st target before collection; re-adding an already active target
remains idempotent.


Subscribed targets use bounded, deterministic virtual scrolling: instant
half-viewport DOM increments (no mouse or keyboard simulation), a 1000 ms
settle after productive movement, and a deterministic 1500/2500/4000 ms
no-progress backoff (capped) for consecutive windows without new accepted
identities. There is no randomized timing, no simulated human interaction, and
no stealth or concealment. Collection stops at a proven non-moving boundary,
after a repeated settled no-new streak that included movement
(`no_progress`), at the bounded safety caps, or when the requested window is
fully covered — and no wait follows a condition- or item-limit terminal
result. Discovery and collection treat `no_progress` as incomplete and fail
rather than returning partial results. Rendered DOM is extracted directly into
normalized posts and chat messages; raw DOM is not persisted. Post engagement
counts and visible chat reactions are retained as metadata. Platform IDs are
globally deduplicated. Ordered overlap preserves duplicate ID-less messages
when the rendered windows prove their multiplicity; ambiguous ID-less
overlaps, missing timestamps, inaccessible targets, authentication loss,
loading stalls, scroll failures, or unresolved safety limits fail collection
instead of advancing the cursor across an uncertain partial window — an
incomplete window never advances the cursor, protecting captured history from
gaps.

The headed connection window requires a desktop display. A remote/headless
server needs an operator-provided remote desktop, VNC, or equivalent display
path for initial connection. Scheduled collection itself is headless.

### Unsupported platform risk

This is browser automation over rendered `x.com` pages, not the official X API
and not a third-party X content API. Browser automation is not supported by X:
X can change DOM structure, challenge the login, restrict the account, or
block automation without notice. Morning Post does not spoof browser
fingerprints, hide Playwright automation, or simulate human behavior —
collection pacing is deterministic. Operators assume the account and policy
risk.

### Retention

Captured X posts and messages—including disappearing messages captured before
they disappear—are retained indefinitely with their normalized items and
downstream analyses, stories, summaries, feedback, and digest artifacts.
Capture therefore overrides X disappearance after ingestion. Disconnecting X
deletes the authenticated browser profile but does not delete previously
captured content. Configurable cascading retention remains deferred; there is
currently no retention environment variable or UI control.

### Opt-in live contract check

The deterministic suite does not contact X. To check the current rendered-DOM
contract against an already authenticated app-owned profile, set
`X_BROWSER_LIVE_PROFILE_ID` to that profile's canonical UUID and
`X_BROWSER_LIVE_TARGET_URL` to a Following, List, or Chat target, then run:

```sh
bun run test:x:live
```

The check is intentionally opt-in and does not read or print cookies, local
storage, or passwords.
