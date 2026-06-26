# Morning Post App

## Setup

```sh
git config core.hooksPath .githooks
```

This activates the pre-push hook that runs tests before every push.

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

Copy `.env.example` to `.env` and fill in every value. The minimum set:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string (default: `postgres://morningpost:morningpost@localhost:5432/morningpost`) |
| `TEST_DATABASE_URL` | Test database connection string (default: `postgres://morningpost:morningpost@localhost:5432/morningpost_test`) |
| `CREDENTIAL_MASTER_KEY` | 32-byte base64 key for credential encryption. Generate: `openssl rand -base64 32` |
| `TELEGRAM_API_ID` | Telegram API ID from [my.telegram.org/apps](https://my.telegram.org/apps) |
| `TELEGRAM_API_HASH` | Telegram API hash (same page) |
| `GEMINI_API_KEY` | Google Gemini API key for summarization |
| `PORT` | API server port (default: 3000) |

### Migrations

```sh
deno task db:migrate
```

### Commands

| Task | What it does |
| --- | --- |
| `deno task dev:cli` | Run the pipeline once (fetch → summarize) with a hardcoded time window |
| `deno task dev:api` | Start the API server on port 3000 with file watching |
| `deno task start` | Start the API server without file watching (production) |
| `deno task test` | Run the full test suite |
| `deno task db:generate` | Generate a Drizzle migration from schema changes |
| `deno task db:migrate` | Apply pending migrations |

### Frontend

The web frontend is a SolidStart SPA (client-side rendering only) served through
a Vite dev proxy that forwards API calls to the Deno backend on port 3000.

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
   deno run --env-file=.env.production.local --allow-net --allow-env --allow-read src/db/migrate.ts
   ```

**Smoke test** (browser):

```sh
# Terminal 1: backend
deno task dev:api

# Terminal 2: frontend
npm run web:dev
```

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
4. Set them in your `.env` file:
   ```
   TELEGRAM_API_ID=your_api_id
   TELEGRAM_API_HASH=your_api_hash
   ```

## Get Telegram Session String

The app authenticates via QR code on first run and prints a session string so
you don't have to log in again. Run `deno task dev:cli`.

1. Leave `TELEGRAM_SESSION` empty in your `.env` file
2. Run `deno task dev:cli`
3. Scan the QR code in Telegram: **Settings → Devices → Link Desktop Device**
4. The session string will be printed to the console — copy it
5. Set it in your `.env` file:
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
