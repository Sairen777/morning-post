# Morning Post App

## Setup

```sh
git config core.hooksPath .githooks
```

This activates the pre-push hook that runs tests before every push.


### Deno permissions

The checked-in tasks use Deno 2.5+ named permission sets (`-P=<name>`) rather
than unscoped `--allow-*` flags. The local `api` and `test` sets allow only
loopback API/database/test services plus
`generativelanguage.googleapis.com`; they do not grant arbitrary Telegram or
summarizer hosts. Read access is limited to repository source/config,
`node_modules`, and migration directories. Writes are limited to
`telegram_media`, `media`, and `.debug_logs`.
FFI is limited to `./node_modules`; no system permission is granted by the
baseline sets.

The named sets are:

| Set | Intended use |
| --- | --- |
| `api` | Watched/local or task-based API server |
| `migrate` | Database migrations (no write, media, or FFI permissions) |
| `test` | Backend tests |
| `cli` | One-shot local pipeline |

For production, do not use the local `api` allowlist. Copy
`scripts/production-start.template.sh` and pass an explicitly reviewed list
containing `<database-host>,<telegram-dc-hosts>,<summarizer-host>,<listener>`.
The template never derives permission hosts from `DATABASE_URL` or
`SUMMARIZER_BASE_URL`, and it does not fall back to unscoped `--allow-net`.
Production `start` tasks load `.env.production.local` and bind the backend to
`127.0.0.1:3000` by default. `SERVER_HOSTNAME` selects the listener hostname:
an explicit server override takes precedence, then `SERVER_HOSTNAME`, then the
built-in default `127.0.0.1`. In production, the value must match the
`<listener>` host passed to `scripts/production-start.template.sh`, because
that host is included in the template's explicit `--allow-net` list. For a
loopback-behind-proxy deployment, use `SERVER_HOSTNAME=127.0.0.1` and pass
`127.0.0.1` as `<listener>`; the reverse proxy is the public endpoint. For a
directly exposed listener, use `SERVER_HOSTNAME=0.0.0.0` and pass `0.0.0.0` as
`<listener>`.


## Running Locally

### Prerequisites
- [Deno](https://deno.com/) 2.x+
- [Node.js](https://nodejs.org/) 22.13+ and npm (for the SolidStart web frontend)
- [PostgreSQL](https://www.postgresql.org/) 16+ (or Docker)
- [OpenSSL](https://www.openssl.org/) (for generating the credential master key)

### Database

The easiest way to get a local Postgres is the included Docker Compose file:

```sh
docker compose up -d
```

This starts Postgres on port 5432 with user/password/database `morningpost`
and an additional `morningpost_test` database for tests.

If you already have Postgres running, create the databases manually:

```sh
createdb morningpost
createdb morningpost_test
```

### Environment

Copy `.env.example` to `.env.production.local` and fill in every value. Deno
tasks load this file with `--env-file=.env.production.local`; do not commit the
copied file because it contains deployment credentials. The minimum set:

| Variable | Purpose | Default |
| --- | --- | --- |
| `DATABASE_URL` | Postgres connection string | `postgres://morningpost:morningpost@localhost:5432/morningpost` |
| `TEST_DATABASE_URL` | Test database connection string | `postgres://morningpost:morningpost@localhost:5432/morningpost_test` |
| `CREDENTIAL_MASTER_KEY` | 32-byte base64 key for credential encryption. Generate: `openssl rand -base64 32` | (required) |
| `TELEGRAM_API_ID` | Telegram API ID from [my.telegram.org/apps](https://my.telegram.org/apps) | (required for Telegram) |
| `TELEGRAM_API_HASH` | Telegram API hash (same page) | (required for Telegram) |
| `SUMMARIZER_MODEL` | Required deployment-wide text summarization model | (required) |
| `SUMMARIZER_BASE_URL` | Required OpenAI-compatible text endpoint root | (required) |
| `SUMMARIZER_API_KEY` | Optional bearer token for the text provider | (optional) |
| `VISION_MODEL` | Required deployment-wide vision model | (required) |
| `VISION_BASE_URL` | Vision endpoint root when distinct; inherited from the text endpoint when omitted | (optional for same-model routing) |
| `VISION_API_KEY` | Optional bearer token for the vision provider; inherited for same-model routing | (optional) |
| `PORT` | API server port | `3000` |
| `SERVER_HOSTNAME` | API listener hostname; explicit server overrides take precedence, then this value, then the built-in default | `127.0.0.1` |
| `ALLOWED_ORIGINS` | Comma-separated allowed origins for Origin-guard | `http://127.0.0.1:5173,http://localhost:5173` |
| `TRUSTED_PROXY_COUNT` | Number of trusted proxies for client IP in rate limiting | `0` |
| `MAX_REQUEST_BODY_BYTES` | Maximum JSON request body size | `1048576` (1 MiB) |
| `DB_POOL_MAX` | Maximum Postgres connection pool size | `10` |
| `DB_IDLE_TIMEOUT_SECONDS` | Idle connection timeout | `20` |
| `DB_CONNECT_TIMEOUT_SECONDS` | Connection connect timeout | `30` |
| `DB_SSL_MODE` | Postgres SSL mode: `disable`, `require`, `verify-full` | `disable` |
| `ALLOW_REMOTE_SUMMARIZATION` | Allow non-loopback summarizer providers | `false` |
| `CONNECTOR_TIMEOUT_MS` | Connector call timeout in milliseconds | `120000` |
| `SUMMARIZER_TEXT_BYTES_PER_CHUNK` | Max text bytes per summarizer chunk | `120000` |
| `SUMMARIZER_MAX_ITEMS_PER_CHUNK` | Max items per summarizer chunk | `50` |
| `SUMMARIZER_MAX_IMAGE_BYTES` | Oversize images become `[IMAGE_OMITTED]` | `1000000` |
| `SUMMARIZER_TIMEOUT_MS` | Per-chunk summarizer request timeout | `120000` |
| `SUMMARIZATION_CONCURRENCY` | Max concurrent feed summarizations per run | `2` |
| `MEDIA_TTL_MS` | Media file TTL | `604800000` (7 days) |
| `MEDIA_QUOTA_BYTES` | Per-connector media quota | `524288000` (500 MiB) |
| `DIGEST_RUN_STALE_AFTER_MS` | Stale digest-run threshold for recovery | `900000` (15 min) |
| `SCHEDULER_LEASE_MS` | Scheduler leader lease duration | `90000` (90 sec) |

#### Session behavior

Sessions use the `__Host-session` cookie (HttpOnly, Secure, SameSite=Lax, Path=/).
Tokens are stable — concurrent SPA requests do not invalidate one another. Idle
sessions expire after 30 days; active use extends the expiry without changing the
token. Explicit logout revokes the token immediately.

#### Production database TLS

For deployments where the database is not on loopback, set `DB_SSL_MODE=require`
or `verify-full`. The local default is `disable` (plaintext on loopback). Also
configure `DB_POOL_MAX`, `DB_IDLE_TIMEOUT_SECONDS`, and
`DB_CONNECT_TIMEOUT_SECONDS` for your workload.

### Migrations

```sh
deno task db:migrate
```

### Commands
The local backend listens on loopback at `127.0.0.1:3000` by default. Both
server tasks pass `--unstable-cron`, which is required for the digest and media
housekeeping schedules.

| Task | What it does |
| --- | --- |
| `deno task dev:cli` | Run the pipeline once (fetch → summarize) with the `cli` permission set |
| `deno task dev:api` | Start the watched API server on loopback `127.0.0.1:3000` by default with the `api` permission set and `--unstable-cron` |
| `deno task start` | Start the API server with the local `api` permission set and `--unstable-cron`; use the production template for deployment |
| `deno task test` | Run the full test suite with the `test` permission set |
| `deno task db:generate` | Generate a Drizzle migration with the narrowly scoped `generate` set |
| `deno task db:migrate` | Apply pending migrations with the `migrate` permission set |

### Frontend

The web frontend is a SolidStart SPA (client-side rendering only) served by
Vinxi at `127.0.0.1:5173`. Its Vite proxy forwards API calls, including
`/health`, to the Deno backend at `127.0.0.1:3000`.

**Pre-flight.** Before the first frontend run:

1. Install web dependencies:

   ```sh
   npm install
   ```

2. Postgres must be running (`docker compose up -d` or local service).

3. `.env.production.local` must include `DATABASE_URL` and `TEST_DATABASE_URL`.
   See [Environment](#environment) above for the full variable list.

4. Apply migrations:

   ```sh
   deno task db:migrate
   ```

**Smoke test** (browser):

```sh
# Terminal 1: backend
deno task dev:api

# Terminal 2: frontend
# `npm run web:dev` invokes `vinxi dev --port 5173`; the outer listener is fixed to 127.0.0.1
npm run web:dev
```

#### API pagination

`GET /digests` and `GET /digests/runs` return `{ data, nextCursor }` where
`data` is an array and `nextCursor` (when present) can be passed as
`?cursor=<value>` to fetch the next page. The web UI provides a "Load more"
button that appends results without duplicates and resets the cursor after a
new run, delete, or refresh.

Open `http://127.0.0.1:5173`. Register an account, click "Run digest",
and verify the digest appears with status `complete`.

**Automated tests:**

| Command | What it does |
| --- | --- |
| `deno task test` | Full backend test suite |
| `npm run web:test` | Frontend unit/component tests (Vitest, 14 tests) |
| `npm run web:typecheck` | TypeScript type checking |
| `npm run web:build` | Production build |
| `npm run web:e2e` | E2E smoke test (starts backend + frontend, registers, runs digest) |

**Verify in the database** after a browser smoke run:

```sql
select id, email, created_at from users order by created_at desc limit 5;
select id, user_id, status, period_start_ms, period_end_ms, created_at
from digests order by created_at desc limit 5;
select id, user_id, connector_id, enabled, created_at
from sources order by created_at desc limit 5;
select id, source_id, external_id, name, kind, enabled, last_fetched_period_end_ms
from feeds order by created_at desc limit 10;
```

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
you don't have to log in again. Run `deno task dev:cli`.

1. Leave `TELEGRAM_SESSION` empty in `.env.production.local`
2. Run `deno task dev:cli`
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
