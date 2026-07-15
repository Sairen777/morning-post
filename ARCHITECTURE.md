<!-- Model: Claude Opus 4.5 -->
# Morning Post — Architecture

## Overview

A tool that fetches content from multiple sources, normalizes it, and summarizes
it based on configurable rules. Starts as a CLI utility, designed as an API from
day one.

Data flow:

```
Connector.getRawData(from, to): TRawData
  -> Connector.getNormalizedData(from, to): Record<sourceId, NormalizedItem[]>
  -> Summarizer.summarize(items, rules): SummaryPoint[]
```

No intermediate adapter step. `NormalizedItem` is the single cross-layer item
type — the connector emits it and the summarizer consumes it directly.

All public boundaries use **epoch milliseconds** (the `number` returned by
`Date.now()`) for timestamps. Internal types (e.g. `ChannelMessage.date`) may
use `Date` where convenient, but anything crossing a layer is `number`. Readable
date formatting happens at the presentation layer.

---

## Layers

### 1. Connectors

Each connector wraps a single external service (Telegram, RSS, Twitter, etc.)
and is responsible for two things only: **fetching** and **normalizing**.

Every connector implements the `Connector<TRawData>` interface in
`src/connectors/connector.types.ts`. Connector files have exactly one exported
class implementing that interface. Connector config (API keys, URLs) is provided
at instantiation time via env vars.

`getRawData(from, to)` fetches raw messages within the time window from the
service API. Caching for repeat calls in a short window is a DB-layer concern
(see `ROADMAP.md`).

**`getRawData` stays on the interface deliberately.** No external caller uses it
today — only the connector's own `getNormalizedData` consumes it. It remains
public as a structural contract: every connector must separate fetching from
normalization. Removing it would let a future connector tangle I/O with shape
conversion. The redundancy is intentional.

`getNormalizedData(from, to)` transforms raw data into
`Record<sourceId, NormalizedItem[]>`, downloading and linking attachments along
the way. Each `NormalizedItem` carries:

- `connectorId: ConnectorId` (enum, e.g. `ConnectorId.Telegram`)
- `sourceId: string` (the feed's external id; matches the map key — see the
  naming note below)
- `date: number` (epoch ms)
- `title`, `text`, `author`, `url`
- optional `media: Media`
- optional `meta: Record<string, unknown>` for connector-specific fields

**Connector-specific data goes in `meta`, not as top-level fields.** Telegram
puts `{ isGroup }` there; other connectors add what they need. Keeps the
cross-layer type connector-agnostic.

**Naming — the map key is a Feed external id, not a Source.** The `Record<…>`
key (and `NormalizedItem.sourceId`) is the feed's **external id** — the
connector's native id for that channel/dialogue/subreddit/URL. It is unique only
**within its source** (`UNIQUE(Feed.sourceId, externalId)`): the same channel
subscribed by two users, or two different connectors, can repeat an external id.
The map is therefore source-scoped — a connector instance is bound to one
`Source`, so its keys are unique within a single result, but resolving a key to
a persistent `Feed` needs the `(sourceId, externalId)` pair or the surrogate
`Feed.id`. Never merge results from different sources into one flat map keyed by
external id. The field will be renamed `feedExternalId` (and `SourceSummary` →
`FeedSummary`) before persistence integration to make this explicit.

### 2. Summarizer

Accepts `NormalizedItem[]` and a `SummaryRuleset`
(`{ systemPrompt, showAuthors?, includeMedia? }`), returns `SummaryPoint[]`. Has
**no domain knowledge** of where items came from — the prompt and shape hints
are fully caller-controlled.

Implements the `SummarizerService` interface in
`src/summarizers/summarizer.types.ts`.

#### Prompts

All system prompts live in `src/summarizers/prompts.ts`. Each builder
(`buildNewsPrompt`, `buildDiscussionPrompt`, …) returns a full `SummaryRuleset`
— prompt text plus matching `showAuthors`/`includeMedia` defaults. New
summarization "modes" go here, not inside the summarizer service and not inlined
in the orchestrator.

#### Backends

Current implementation: `OpenAICompatibleSummarizerService`. Default backend is
**Gemini 2.5 Flash-Lite** (vision-capable). Set `LOCAL_API=true` (or `=1`) to
flip defaults to a local LM Studio / Ollama-style server — useful for offline
dev and for summarizing content that shouldn't leave the machine.

Env vars (consumed at construction time, with hardcoded fallbacks):

| Env                   | Purpose                                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `LOCAL_API`           | `true`/`1` to use local backend defaults                                                                                            |
| `SUMMARIZER_MODEL`    | overrides the model name                                                                                                            |
| `SUMMARIZER_BASE_URL` | overrides the OpenAI-compatible endpoint **root** (the directory containing `chat/completions`, e.g. `https://api.deepseek.com/v1`) |
| `GEMINI_API_KEY`      | bearer token for the hosted backend                                                                                                 |

Precedence: explicit constructor arg → env var → hardcoded default. Tests rely
on the constructor-arg path to inject mock values.

### 3. Presenter _(planned)_

Takes the summarizer output and formats/delivers it:

- builds HTML to deliver via email
- builds markdown file to deliver via web service
- …etc for RSS or other views

Readable date formatting happens here.

### 4. Persistence layer _(planned)_

Multi-user storage for accounts, subscriptions, cached items, and generated
summaries. No ORM/DB is chosen yet; the field-level model lives in `ROADMAP.md`
→ Entities. The conceptual shape:

- **User** directly owns its summarization `systemPrompt` (one editable field —
  no separate profile or tag entities) and many **Source** rows (one per
  connector, holding that connector's credentials, with a `position` that sets
  the primary digest order).
- A **Source** has many **Feed** rows — the individual subscriptions (channel,
  dialogue, subreddit, RSS URL), each with an optional within-source `position`.
  A **Feed** has cached **Item** rows and immutable **Summary** rows.
- A **Digest** is the user-facing morning post for a period. Its sections are
  **derived, not stored**: the period's **Summary** rows for the user's
  non-deleted feeds, ordered by `(Source.position, then Feed.position or name)`.

The persistence model mirrors the runtime's connector-agnostic stance: one
generic `Source`/`Feed`/`Summary` triad instead of per-connector tables.
Connector-specific fields live in `Source.credentials` — the persistence twin of
`NormalizedItem.meta`, and the system's most sensitive asset (see Credentials &amp;
secrets below).

All cross-layer timestamps are epoch ms (`number`); periods are explicit
`periodStartMs`/`periodEndMs` ranges, never a day string.

**Timestamp conventions.** Mutable rows (`User`, `Source`, `Feed`, `Digest`)
carry `createdAt` + `updatedAt`. Immutable rows carry a single semantic creation
timestamp and no `updatedAt`: `Summary.generatedAt` — a summary is never
rewritten, so an `updatedAt` would only echo it and contradict immutability. The
`Item` cache uses `fetchedAt` as its last-write timestamp (bumped on upsert);
`date` is the content's own timestamp, not a row timestamp.

**Deletion is non-destructive to history.** A feed is soft-deleted
(`Feed.deletedAt`); `Summary` rows are never deleted or rewritten. Each summary
snapshots `feedNameSnapshot` at generation time so digests still render after a
feed is renamed upstream or removed.

#### Credentials &amp; secrets

`Source.credentials` is the highest-severity asset in the system. A Telegram
session string is an **unrevokable, unscoped, full-account bearer token** — only
the user can terminate it (Telegram → Devices); there is no server-side scope or
revoke. Plaintext storage means one DB leak = full takeover of every connected
account.

**No zero-knowledge option here.** Morning Post runs scheduled digests while the
user is offline, so the server must decrypt and use a credential without the user
present. That rules out client-side / end-to-end custody (the desktop-app
OS-keychain model): a service that acts on your behalf at 6am must hold the
decryption capability at 6am — user-/password-derived keys can't be present then
without caching them server-side, which restores server custody. **Per-user data
keys therefore limit blast radius and enable per-user revocation/rotation; they
do not make the server unable to read.** The achievable goal is not "even we
can't read it" but: a DB/backup leak alone does not expose secrets, access can be
revoked instantly, and we hold the least-powerful credential each connector
allows — the trusted-custodian posture of any SaaS that holds your OAuth tokens.

- **Encrypt at the application layer** with authenticated encryption (AES-256-GCM
  or libsodium secretbox). The key lives **outside the DB** — env var or secrets
  manager, never a column or the repo. This defends the realistic leak vectors
  (stolen backups/snapshots, logical dumps, read-only SQLi); it does **not**
  defend a full-host compromise that also yields the key. State that boundary
  honestly rather than implying "encrypted = safe".
- **Reduce capability at the source.** Prefer the least-powerful credential a
  connector offers (OAuth scopes, bot tokens, public/RSS access). Telegram is the
  dangerous case precisely because a bot cannot read a user's full feed, so the
  session is required — which is why it earns the strongest custody.
- **Never log credentials** (keep them out of `.debug_logs`), encrypt backups,
  and make "disconnect" delete the row. For Telegram, prompt the user to revoke
  the session in Telegram → Devices, since deleting your copy cannot revoke a
  copy an attacker already exfiltrated.
- **This deploy — multi-user on a VPS.** App, DB, and backups share one box, so
  a key sitting on that box barely raises the bar: a rooted VPS reads decrypted
  secrets regardless. The moves that matter: (1) **envelope encryption with
  per-user data keys** so one user's leak is not everyone's; (2) hold the
  **master key off the box** — a managed KMS or external secrets service (cloud
  KMS, Vault, Infisical/Doppler, or SOPS+age injected at runtime), never on the
  VPS disk or in DB backups. That removes the key from the backup/snapshot blast
  radius and gives a **revocation kill-switch**: revoke the master key and every
  stored credential is instantly dead. Also encrypt backups with a separate key
  and keep the DB off the public network behind a least-privilege user. Honest
  residual: a KMS limits offline/backup exposure and enables revocation, but
  cannot stop a currently-rooted box from using the key in-process. (The
  OS-keychain option applies only to a single-user local build — not this one.)

#### Scheduling, caching & lifecycle invariants

- **Fetch-window cursor.** Each `Feed` records `lastFetchedPeriodEndMs`. The
  scheduler computes the next window as `from = lastFetchedPeriodEndMs + 1,
  to = now`; a brand-new feed falls back to a fixed lookback. The
  `UNIQUE(Item.feedId, externalId)` constraint makes overlapping windows safe.
- **Item upsert.** `Item` writes are `ON CONFLICT (feedId, externalId) DO
  UPDATE payload, fetchedAt` — re-fetching an edited message refreshes the
  cache rather than failing or silently skipping.
- **Digest scope (v1).** One `Digest` per `(user, period)`. Its sections are
  derived from the period's `Summary` rows ordered by `Source.position` (then
  `Feed.position` or name) — nothing is stored per section. Multiple named
  digests per user are deferred — additive later, no schema break.

#### JSON columns

Use `jsonb`, never `json` (binary, indexable). Validate every JSON column's
shape at the app boundary (Zod/Valibot) on read and write — the DB does not
enforce it. Reserve JSON for polymorphic or read-whole blobs; normalize anything
you filter, join, sort, or aggregate on.

| Column               | Storage | Why                                  |
| -------------------- | ------- | ------------------------------------ |
| `Source.credentials` | jsonb (enc) | account secrets as ciphertext; key outside the DB — see Credentials &amp; secrets |
| `Item.payload`       | jsonb   | cached `NormalizedItem`, read whole  |
| `Summary.points`     | jsonb   | `SummaryPoint[]`, rendered whole     |

#### Prompt layering

The summarizer stays domain-agnostic; the caller composes the system prompt in
one place by explicit layering, in order:

```
[base role from prompts.ts]
[User.systemPrompt]            # the user's interests / taste (one editable field)
[Feed.customPrompt?]           # feed-specific override
[kind-specific instructions]   # news vs discussion vs …
```

The string is composed fresh per run — there is no stored hash or cache key. A
feed's custom prompt is layered, not assigned an abstract "priority": LLMs honor
position and structure, not declared precedence.

The `kind`-specific layer is chosen from `Feed.kind` **passed by the caller** —
`selectRuleset(items, kind)` — not inferred from item contents. (Today
`selectRuleset(items)` reads `meta.isGroup`; it gains an explicit `kind`
parameter once feeds are DB-backed, keeping `NormalizedItem` connector-agnostic.)


---

### 5. Session lifecycle

Sessions use the `__Host-session` cookie (HttpOnly, Secure, SameSite=Lax, Path=/).
Tokens are stable 256-bit random values; the database stores only the SHA-256
hash. Concurrent SPA requests never invalidate one another — each token is
valid until expiry or explicit logout.

**Idle refresh.** `validateSessionToken` returns `ValidatedSession | null` with
a `refreshExpiresAt` field. `requireAuth` sets a refreshed `Set-Cookie` with the
same token when the idle interval is within 7 days of expiry; the repository
atomically extends expiry via `touchSessionIfDue()`, which is safe for
concurrent requests. Idle sessions expire after 30 days; active use extends the
expiry without changing the token. See `src/auth/session-service.ts` and
`src/repositories/session-repository.ts`.
{/* Tests: tests/server/session.test.ts, tests/server/security-audit.test.ts */}

### 6. Database connectivity

`src/db/client.ts` creates the Postgres connection pool with explicit options:
`max` (pool size from `DB_POOL_MAX`, default 10), `idle_timeout`
(`DB_IDLE_TIMEOUT_SECONDS`, default 20), `connect_timeout`
(`DB_CONNECT_TIMEOUT_SECONDS`, default 30), and `ssl` (from `DB_SSL_MODE`,
default `disable` for local loopback). Production deployments set
`DB_SSL_MODE=require` or `verify-full` and tune pool sizing for the workload.
Invalid SSL mode values are rejected at startup. See `src/db/client.ts` and
`src/db/testing.ts`.
{/* Tests: focused config tests proving remote production settings require TLS */}

### 7. Rate limiting

Rate limiting is backed by the `rate_limit_buckets` PostgreSQL table with an
atomic `INSERT ... ON CONFLICT DO UPDATE WHERE resetsAt > now` statement.
The `consumeRateLimit` repository function returns the current count after
consumption; delete expired rows opportunistically.

`createRateLimitMiddleware` receives a `Database` instance and uses stable
literal namespaces: `auth-register`, `auth-login`, `telegram-login`,
`telegram-two-factor`, and `digest-run`. Digest-run keys are `userId`; pre-auth
keys use the client address resolved through `getConnInfo` and the configured
`TRUSTED_PROXY_COUNT`. When `TRUSTED_PROXY_COUNT=0`, forwarded headers are
ignored. Two independently built app instances sharing the same database share
the same rate-limit buckets. See `src/server/middleware/rate-limit.ts` and
`src/repositories/rate-limit-repository.ts`.
{/* Tests: tests/server/rate-limit.test.ts, tests/db/rate-limit-repository.test.ts */}

### 8. Scheduling and multi-instance coordination

**Scheduler lease.** A `scheduler_leases` table with primary key `name`
supports leader election. `tryAcquireSchedulerLease(database, "digest-job",
ownerId, now, leaseMs)` uses an atomic insert/upsert; only the acquiring
process calls `runDigestTick`. `Deno.cron` triggers the callback in every
process, but the database lease makes duplicate callbacks harmless. See
`src/scheduler/digest-job.ts`, `src/scheduler/scheduler.ts`,
`src/server/main.ts`.

**Active-run uniqueness.** A partial unique index on `digest_runs(userId) WHERE
status = 'running'` prevents duplicate active digest runs per user.
`createDigestRun` surfaces a typed conflict result; manual `/digests/run`
returns a controlled error, and the scheduler skips the user and continues. See
`src/repositories/digest-run-repository.ts`.

**Stale-run recovery.** `recoverStaleDigestRuns(database, now,
staleAfterMs)` updates `running` rows older than the threshold to `failed`,
storing a redacted error message. Recovery runs at the start of each leader
tick. The active-run unique index prevents duplicate work after recovery. See
`src/repositories/digest-run-repository.ts`.

Configuration: `DIGEST_RUN_STALE_AFTER_MS` (default 15 minutes) and
`SCHEDULER_LEASE_MS` (default 90 seconds).
{/* Tests: tests/scheduler/digest-job.test.ts, tests/db/digest-run-repository.test.ts */}

### 9. Connector batching and deadlines

**Source batching.** When two or more feeds need ingestion from the same source,
`ingestFeedsForSource()` computes the union window, calls
`connector.getNormalizedData(min(from), max(to), externalIds)` once, filters
returned items per feed, validates each feed independently, and upserts each
feed's items in its own transaction. A connector-level exception marks all
pending feeds in that source failed; per-feed validation/transaction errors are
isolated. The single-feed path (`ingestFeed`) remains for orphan feeds. See
`src/services/ingestion-service.ts` and `src/services/orchestrator.ts`.

**Connector deadlines.** `Connector.getRawData`, `getNormalizedData`, and
`getMessagesFromEntity` accept an optional `AbortSignal` as the final
parameter. `ingestFeedsForSource` creates a per-source timeout controller from
`CONNECTOR_TIMEOUT_MS` (default 120s). The Telegram connector checks the signal
between dialog/message iterations; non-Telegram connectors that ignore the
signal still receive the deadline at the service boundary. See
`src/connectors/connector.types.ts`,
`src/connectors/telegram/telegram-connector.ts`.
{/* Tests: tests/services/ingestion-service.test.ts,
    tests/services/orchestrator.test.ts, tests/connector.test.ts */}

### 10. Summarizer budgets, chunking, and privacy

**Chunked summarization.** `OpenAICompatibleSummarizerService` packs items into
chunks respecting `maxTextBytesPerChunk` (default 120,000), `maxItemsPerChunk`
(default 50), and `maxImageBytes` (default 1,000,000). Items pack sequentially;
if one item's text alone exceeds the per-item text budget, only that item's text
is truncated while preserving its index. Oversize images are replaced with
`[IMAGE_OMITTED]`. Multi-chunk inputs produce a merge request using the same
budget and no images; if the merge input still exceeds the cap, it recurses in
sequential groups. Empty or all-filtered input makes zero provider calls and
returns `[]`. See `src/summarizers/openai-compatible-summarizer.ts`.

**Retry and timeout.** Each chunk, retry delay, and merge request receives the
same `AbortSignal` from `SUMMARIZER_TIMEOUT_MS` (default 120s). Retries
(3 attempts for 429/503 with exponential delay) check `signal.aborted` before
each request. Aborts stop immediately and are handled as feed-level
summarization failure. See `src/services/summarization-service.ts`.

**Remote provider opt-in.** `OpenAICompatibleSummarizerService` allows loopback
endpoints (`localhost`, `127.0.0.1`, `::1`) unconditionally. Any non-loopback
base URL throws a configuration error unless `ALLOW_REMOTE_SUMMARIZATION=true`.
See `src/summarizers/openai-compatible-summarizer.ts`.

**Bounded feed concurrency.** Summarization of pending feeds within a digest run
is bounded by `SUMMARIZATION_CONCURRENCY` (default 2), using a small worker-pool
helper. The shared `OpenAICompatibleSummarizerService` is responsible for
per-request retries; no unbounded `Promise.all`. See `src/services/digest-service.ts`.
{/* Tests: tests/summarizer.test.ts, tests/services/summarization-service.test.ts,
    tests/services/digest-service.test.ts */}

### 11. Media lifecycle

Telegram photo files are written under `telegram_media/<feed-key>/<message-id>.jpg`,
preventing message-ID collisions across feeds. Per-connector media quota
(`MEDIA_QUOTA_BYTES`, default 500 MiB) is enforced before writes by deleting
oldest files until the new file fits.

After each successful feed summarization, `cleanupFeedMedia()` deletes the
period's media files (best-effort, never fail the digest). A weekly scheduler
housekeeping callback deletes files older than `MEDIA_TTL_MS` (default 7 days),
including orphaned paths. See `src/connectors/telegram/telegram-connector.ts`,
`src/repositories/item-repository.ts`, `src/services/summarization-service.ts`.
{/* Tests: focused media lifecycle tests for quota eviction, TTL cleanup,
    immediate cleanup success/failure */}

### 12. Cursor pagination

Digest and digest-run list endpoints use opaque base64url cursors containing the
full ordering tuple. Default limit is 20, maximum 100. Malformed, wrong-kind, or
oversized cursors return 422. Response shape: `{ data, nextCursor }`.

`listDigestPageForUser` orders by `(periodEndMs DESC, createdAt DESC, id DESC)`;
`listDigestRunPageForUser` by `(startedAt DESC, id DESC)`. Each fetches
`limit + 1` to detect the terminal page. The web UI "Load more" control
appends results, resets after a new run/delete/refresh, and disables while
loading. See `src/server/routes/digests.ts`, `apps/web/src/api/client.ts`,
`apps/web/src/app/Dashboard.tsx`.
{/* Tests: tests/server/digests.test.ts, frontend unit tests */}

### 13. Deferred items

The following were considered but remain deferred for separate provider/product
plans:

- **KMS / off-box master key.** The current `KeyProvider` seam and local
  encrypted credential storage are preserved; moving the master key to a cloud
  KMS, Vault, or Infisical/Doppler is a separate deployment milestone.
- **MFA / WebAuthn / TOTP.** Session hardening (idle refresh, `__Host-session`
  cookie, 30-day expiry) is in place; multi-factor authentication belongs on a
  broader user-account roadmap.
- **Object storage for media.** Local media directories with TTL and quota
  suffice for single-host deployments; S3/R2/GCS integration is deferred until
  multi-host scaling requires it.
- **Per-user / per-feed model override.** `User.defaultModel` and
  `Feed.preferredModel` remain optional and can be layered onto the existing
  summarizer backend precedence (constructor arg → env → default).
  See "Things to Consider" below.
- **Automatic feed theme classification.** Per-feed `customPrompt` handles
  manual steering; LLM-inferred theming is deferred.
---

## Things to Consider

- **Media dir concurrency**: the `media/` directory is shared. When this becomes
  an API with concurrent `/run` requests, each request needs its own isolated
  temp dir (e.g. `media/<requestId>/`) and TTL-based cleanup instead of
  single-shot deletion.
- **Caching**: per-window `getRawData` caching + persistence belongs with the DB
  layer in `ROADMAP.md`. Memory-only caching is a footgun under concurrent API
  requests.
- **Vision model requirement**: multimodal summarization requires a
  vision-capable model. If swapping to a text-only backend (e.g.
  `deepseek-chat`), either flip `includeMedia: false` in the relevant prompt
  builders or have the summarizer strip media before dispatch.
- **Automatic feed theme classification** (LLM-inferred themes + prompt-fragment
  boosting — what the old Tag/FeedTag system did) is deferred. Per-feed steering
  is `Feed.customPrompt` for now; revisit automatic theming once you have many
  feeds to organize.
- **`Run` (job audit)**: a table recording each job execution (start/finish,
  status, error) is deferred — console/file logs suffice until there is a real
  scheduler with failure history worth mining. Re-add additively later.
- **Connector feed-filtering**: today `getNormalizedData(from, to)` fetches every
  dialog. Multi-user makes that wasteful — each user only wants their
  subscriptions. The interface should evolve to accept the user's subscribed
  feed external ids (constructor arg or per-call) so a fetch is scoped to one
  user's feeds. Belongs with the persistence-integration phase.
- **Per-user / per-feed model override**: `User.defaultModel` and an optional
  `Source`/`Feed.preferredModel` would let a user route, say, private channels
  through a local model while everything else uses the hosted backend. Optional;
  layer onto the existing summarizer backend precedence (constructor arg → env →
  default).
