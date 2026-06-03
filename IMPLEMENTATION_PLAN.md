<!-- author-model: Claude Opus 4.6 (claude-opus-4-6-20260514) -->

# Morning Post — Backend Implementation Plan

Iteration-by-iteration plan for building the persistence + API + pipeline
backend behind the 6-entity model (`User · Source · Feed · Item · Summary ·
Digest`). Each iteration is a reviewable, self-contained slice that builds on the
ones before it. **Another model writes the code; this document is the contract
it implements and the checklist the reviewer signs off against.**

Design context lives in `ARCHITECTURE.md`, `ROADMAP.md`, and `PLAN.md`. Read
those first; this plan does not restate the entity fields except where an
iteration touches them.

---

## Confirmed stack

- **Runtime**: Deno (existing). Web framework: Hono (`@hono/hono`, already a dep).
- **DB**: PostgreSQL. **ORM/migrations**: Drizzle ORM + drizzle-kit.
- **Scope**: backend only — persistence, domain services, HTTP API, pipeline +
  scheduler integration. **No frontend** in this plan. **No email sending** —
  digests/summaries are persisted; views are derived from data and exposed via
  the API.
- **Auth**: email + password (argon2id) with server-side sessions (HttpOnly
  cookie).
- **Credential encryption**: envelope encryption with per-user data keys; master
  key from env in v1 behind a `KeyProvider` interface so a KMS slots in later.
- **Telegram connect**: server-driven QR login (built in this plan, Phase 2).

### New dependencies (add to `deno.json` imports as the iterations need them)

| Purpose | Dependency | Notes |
| --- | --- | --- |
| Postgres driver | `npm:postgres` (postgres.js) | pairs with `drizzle-orm/postgres-js`; good Deno support |
| ORM | `npm:drizzle-orm` | typed schema = single source of truth |
| Migrations/CLI | `npm:drizzle-kit` (run via `deno run -A npm:drizzle-kit`) | generates SQL migrations from schema |
| Password hashing | `npm:hash-wasm` (argon2id) | pure-wasm, no native build (avoids node-gyp pain in Deno) |
| Validation | `npm:zod` | request bodies + jsonb shape validation at the boundary |
| Encryption | WebCrypto (`crypto.subtle`, built in) | AES-256-GCM; **no dependency** |

> **Implementer note (Drizzle, since it's new to this team):** the schema is
> declared in TypeScript under `src/db/schema/`. `drizzle-kit generate` diffs the
> schema against the migrations folder and emits SQL; `drizzle-kit migrate` (or a
> small `migrate.ts` using `drizzle-orm/postgres-js/migrator`) applies them.
> Never hand-edit generated migration SQL except to add data backfills. Query
> with the typed `db` client; use `db.transaction(...)` for multi-statement
> atomicity.

---

## Conventions every iteration MUST follow

- **AGENTS.md rules**: no abbreviations in names; epoch-ms (`number`) at every
  layer boundary; connector-specific data in `meta`; prompts only in
  `src/summarizers/prompts.ts`; config precedence constructor-arg → env →
  default; comments only for non-obvious *why*.
- **Single responsibility**: route handler → service → repository. Handlers do
  HTTP (parse, authz, status codes); services hold domain logic; repositories
  hold Drizzle queries. No Drizzle calls in handlers.
- **Authorization**: every data-access path is scoped to the authenticated
  `userId`. A user can never read or mutate another user's `Source`/`Feed`/
  `Summary`/`Digest`. This is a test obligation, not a nicety.
- **Secrets discipline**: `Source.credentials` plaintext never appears in logs,
  API responses, error messages, or `.debug_logs`. Serializers must omit it.
- **Validation at the boundary**: every request body and every jsonb column is
  parsed with a Zod schema on the way in and on the way out of the DB.
- **Tests**: `deno test` + `jsr:@std/assert`, hand-rolled fakes (no mocking
  library), matching the existing `tests/` style. Real Postgres for repo/service
  tests via the harness in Iteration 0.2. **No mocks for the DB.** External
  network (Telegram, the LLM) is faked with the existing `stubFetch`/fake-client
  patterns.
- **Definition of done (per iteration)**: code + tests written; `deno task test`
  green for the touched area; `deno check` clean; `deno lint` clean. The
  implementer does NOT run a full formatter pass or project-wide gates — the
  orchestrator/reviewer runs those once at the end.

### A note on table count vs the "6-entity" decision

The **6 entities are the domain model**. Auth `Session` (Iteration 1.3) and, much
later, a `Run` audit table are **operational/infra tables**, explicitly outside
the domain-6. Introducing them does not violate the simplification decision;
flag this in the relevant PRs so reviewers don't think the model drifted.

---

# Phase 0 — Foundations

## Iteration 0.1 — Runtime rename: `sourceId → feedExternalId`, thread `kind`

**Goal.** Remove the source/feed naming collision before any persistence code
depends on it, and make ruleset selection a caller input. Pure refactor, no DB.

**Depends on.** Nothing.

**Build.**
- In `src/connectors/connector.types.ts`: rename `NormalizedItem.sourceId` →
  `feedExternalId`. Keep `NormalizedData = Record<feedExternalId, NormalizedItem[]>`
  (the map key is the feed's connector-native id; document it is unique only
  within a source).
- In `src/pipeline/pipeline.ts`: rename `SourceSummary` → `FeedSummary`,
  `sourceId` → `feedExternalId`.
- In `src/summarizers/prompts.ts`: change `selectRuleset(items)` →
  `selectRuleset(items, kind?)`. When `kind` is provided it selects the ruleset;
  when omitted it falls back to the current `meta.isGroup` inference (keeps the
  CLI working until feeds are DB-backed). Add a `FeedKind` type
  (`"news" | "discussion"`) — extend later as connectors land.
- Update `src/index.ts` and all call sites; update `tests/` references.
- Use `lsp rename` for the symbol renames; do not hand-edit across files.

**Tests.**
- *Happy*: `selectRuleset(items, "discussion")` returns the discussion ruleset
  regardless of `meta.isGroup`; `selectRuleset(items, "news")` returns news.
- *Back-compat scenario*: `selectRuleset(items)` (no kind) still infers from
  `meta.isGroup` — both branches (group → discussion, channel → news).
- *Edge*: explicit `kind` overrides a conflicting `meta.isGroup` (kind wins).
- *Rename integrity*: existing connector/summarizer/pipeline tests pass with the
  new field/type names (no behavioral change).

**Acceptance.** No `sourceId`/`SourceSummary` identifiers remain in `src/` or
`tests/`. CLI run still works.

---

## Iteration 0.2 — Postgres + Drizzle wiring, migration tooling, test-DB harness

**Goal.** A typed `db` client, a migration workflow, and a real-Postgres test
harness. No domain tables yet.

**Depends on.** 0.1.

**Build.**
- `src/db/client.ts`: build a postgres.js client + Drizzle `db` from
  `DATABASE_URL` (constructor-arg → env → throw if missing). Export a typed `db`.
- `src/db/schema/index.ts`: empty barrel for now (tables added in Phase 1+).
- `drizzle.config.ts`: schema glob, migrations out dir (`drizzle/`), `dialect:
  "postgresql"`, `dbCredentials` from env.
- `deno.json` tasks: `db:generate` (`deno run -A npm:drizzle-kit generate`),
  `db:migrate` (a small `src/db/migrate.ts` using the postgres-js migrator),
  `db:studio` optional.
- `src/db/testing.ts`: `withTestDb(fn)` harness. Connects to `TEST_DATABASE_URL`,
  ensures migrations are applied once per process, runs `fn` inside a transaction
  that is **rolled back** at the end (so tests are isolated and order-independent
  on a single connection). Document that CI must provide a Postgres service.
- A `docker-compose.yml` (or a README snippet) for a local Postgres, plus
  `.env.example` entries (`DATABASE_URL`, `TEST_DATABASE_URL`).

**Tests.**
- *Happy*: `db` connects and `select 1` returns 1.
- *Harness scenario*: a row inserted inside `withTestDb` is visible within the
  same callback, and **not** visible in a second `withTestDb` call (rollback
  isolation proven).
- *Edge*: missing `DATABASE_URL` throws a clear error at client construction, not
  a late opaque failure.
- *Edge*: a failing test body still rolls back (no leaked rows) — simulate a
  throw inside `withTestDb` and assert cleanup.

**Acceptance.** `deno task db:generate` + `db:migrate` run clean against an empty
schema; harness proves isolation.

---

## Iteration 0.3 — API scaffolding: app structure, errors, validation, config

**Goal.** Turn the `index.ts` stub into a real, layered Hono app and separate the
one-shot CLI pipeline run from the server boot.

**Depends on.** 0.2.

**Build.**
- `src/server/app.ts`: builds and returns the Hono app (no `Deno.serve` here, so
  tests can call `app.request(...)`). `src/server/main.ts`: imports the app and
  serves it — this becomes the `dev:api`/`start` entry.
- Move the existing top-level pipeline run out of `index.ts` into
  `src/cli/run-once.ts` (the `dev:cli` entry). Wire `deno.json` tasks accordingly.
- `src/server/errors.ts`: a typed `AppError` hierarchy (`ValidationError`,
  `AuthError`, `NotFoundError`, `ConflictError`) + a Hono error handler that maps
  them to status codes and a JSON `{ error: { code, message } }` envelope. Never
  leak stack traces or secrets.
- `src/server/validate.ts`: helper to parse a request body with a Zod schema and
  throw `ValidationError` on failure.
- `src/config.ts`: centralized env reads (constructor-arg → env → default),
  re-exported so no scattered `Deno.env.get`.
- `GET /health` → `{ ok: true }`.

**Tests.**
- *Happy*: `GET /health` returns 200 `{ ok: true }` via `app.request`.
- *Scenario*: a route that throws `NotFoundError` yields 404 with the JSON
  envelope; `ValidationError` yields 422; unknown error yields 500 with a generic
  message (no internals).
- *Edge*: malformed JSON body → 422, not 500.
- *Edge*: the error handler does not serialize an attached `cause` containing
  secret-shaped fields (guard test).

**Acceptance.** Server boots without running the pipeline; CLI run lives behind
`dev:cli`.

---

## Iteration 0.4 — Crypto module: envelope encryption + `KeyProvider`

**Goal.** A self-contained, heavily-documented encryption module for credentials.
No DB yet — pure functions + an interface.

**Depends on.** 0.3 (config).

**Build.**
- `src/crypto/key-provider.ts`: `interface KeyProvider { wrapDataKey(dataKey:
  Uint8Array): Promise<Uint8Array>; unwrapDataKey(wrapped: Uint8Array):
  Promise<Uint8Array>; }`. Implement `EnvMasterKeyProvider` reading a base64
  32-byte master key from env (`CREDENTIAL_MASTER_KEY`), wrapping/unwrapping data
  keys with AES-256-GCM (WebCrypto). **Document, in code comments, exactly how to
  swap this for a KMS** (the interface is the seam: a `KmsKeyProvider` calls out
  to AWS/GCP KMS / Vault `Encrypt`/`Decrypt` and the master key never lives in
  the process) and **how to strengthen further** (see the strengthening notes
  block below).
- `src/crypto/credential-cipher.ts`: `CredentialCipher` with
  `encrypt(
    plaintext: string,
    owner: { userId: string; connectorId: string },
  ): Promise<EncryptedBlob>` and `decrypt(
    blob: EncryptedBlob,
    owner: { userId: string; connectorId: string },
  ): Promise<string>`. Per call: generate a random 256-bit **data key**,
  AES-256-GCM-encrypt the plaintext under it, using **mandatory AEAD additional
  authenticated data** (`userId|connectorId`) so a ciphertext cannot be
  transplanted between rows or users, then `wrapDataKey` the data key via the
  `KeyProvider`. `EncryptedBlob = { v, wrappedDataKey, iv, ciphertext, authTag }`
  (all base64; `v` = wire-format / scheme version, **not** master-key
  generation).
- A long comment block titled **"Strengthening roadmap"** covering: (1) move the
  master key into a managed KMS (revocation kill-switch; key never on the VPS);
  (2) owner binding is mandatory now — explain why it prevents ciphertext
  transplant between users/rows and how a KMS should mirror it in encryption
  context; (3) key rotation via **re-wrapping with two KeyProviders** while
  keeping `v` unchanged unless the wire format changes; (4) encrypted,
  separately-keyed DB backups; (5) per-user KMS keys as the stronger multi-user
  posture; (6) the honest residual — a live rooted host can still use the key
  in-process (see ARCHITECTURE → Credentials & secrets).

**Tests.**
- *Happy*: `decrypt(encrypt(s)) === s` for ASCII, Unicode, and a realistic
  ~400-char Telegram session string.
- *Scenario*: two `encrypt` calls of the same plaintext produce different
  `iv`/`ciphertext`/`wrappedDataKey` (fresh data key + IV each time).
- *Edge — tamper detection*: flipping a byte in `ciphertext`, `authTag`, `iv`, or
  `wrappedDataKey` makes `decrypt` **throw** (GCM auth failure), never returns
  garbage.
- *Edge — AAD binding*: decrypting with the wrong `userId` or `connectorId`
  throws.
- *Edge*: wrong/rotated master key → `decrypt` throws a clear error.
- *Edge*: malformed/short base64 fields → throws, not a silent empty string.

**Acceptance.** Module is pure and dependency-free (WebCrypto only); the
strengthening notes are present in code; nothing logs plaintext.

---

# Phase 1 — Identity & Auth

## Iteration 1.1 — `User` table + repository

**Goal.** Persist users. Schema + repo + migration.

**Depends on.** 0.2.

**Build.**
- `src/db/schema/user.ts`: `User` per the model (`id` uuid pk, `name`, `email`
  unique, `passwordHash`, `systemPrompt` text, `defaultLanguage?`,
  `defaultModel?`, `createdAt`, `updatedAt` — all timestamps `bigint`/epoch-ms,
  **not** `timestamptz`, to honor the epoch-ms boundary rule). Generate migration.
- `src/repositories/user-repository.ts`: `create`, `findById`, `findByEmail`,
  `update` (partial), with a Zod row-validator. Email stored lowercased.

**Tests.**
- *Happy*: create → `findById` round-trips all fields; `createdAt`/`updatedAt`
  set to epoch-ms numbers.
- *Scenario*: `findByEmail` is case-insensitive (`Foo@x.com` finds `foo@x.com`).
- *Edge*: duplicate email insert throws a `ConflictError` (unique violation
  mapped, not a raw PG error).
- *Edge*: `update` of a missing id → `NotFoundError`; partial update leaves other
  fields intact and bumps `updatedAt`.
- *Edge*: `systemPrompt` accepts empty string and a multi-KB value.

**Acceptance.** Migration applies; repo tests green on real Postgres.

---

## Iteration 1.2 — Registration + password hashing

**Goal.** `POST /auth/register`.

**Depends on.** 1.1, 0.3.

**Build.**
- `src/auth/password.ts`: `hashPassword`/`verifyPassword` using argon2id
  (`hash-wasm`) with sane params (document memory/time cost; note they're tunable
  via config).
- `src/services/registration-service.ts`: validate email/password/name, hash,
  create user with a sensible default `systemPrompt` (a neutral starter prompt
  from `prompts.ts`).
- `POST /auth/register` handler → 201 with the public user shape (**never**
  `passwordHash`).

**Tests.**
- *Happy*: register returns 201 + public user; a row exists; `passwordHash` is
  argon2id (starts `$argon2id$`) and is **not** the plaintext.
- *Scenario*: `verifyPassword` true for correct password, false for wrong.
- *Edge*: duplicate email → 409.
- *Edge*: weak/short password and invalid email → 422 with field errors.
- *Edge*: response body and logs never contain the password or hash (assert
  serializer output).

**Acceptance.** New users persist; secrets never surface.

---

## Iteration 1.3 — Sessions, login/logout, auth guard

**Goal.** Cookie sessions + `requireAuth` middleware.

**Depends on.** 1.2.

**Build.**
- `src/db/schema/session.ts` (**infra table, not domain-6**): `id`, `userId` fk,
  `tokenHash` (store a hash of the cookie token, never the raw token),
  `createdAt`, `expiresAt`, optional `lastSeenAt`. Migration.
- `src/auth/session-service.ts`: `createSession`, `validate(token)`, `revoke`.
  Token = random 256-bit, base64url; cookie is `HttpOnly`, `Secure`,
  `SameSite=Lax`, scoped path.
- Add a small reusable rate-limit primitive (`src/server/middleware/rate-limit.ts`
  or equivalent) and apply it immediately to `POST /auth/register` and
  `POST /auth/login`; Phase 2 reuses it for Telegram QR-login start and 2FA.
- `POST /auth/login`, `POST /auth/logout`. `src/server/middleware/require-auth.ts`
  sets `c.var.userId`.

**Tests.**
- *Happy*: login sets a session cookie; an authed request to a guarded route
  succeeds with the right `userId`.
- *Scenario*: logout revokes — the same cookie afterward → 401.
- *Edge*: wrong password / unknown email → 401 (identical message + **dummy
  argon2 verification** on the missing-user path so response timing is not a
  user-enumeration oracle).
- *Edge*: expired session → 401; tampered/garbage cookie → 401.
- *Edge*: the DB stores only the token **hash** (assert raw token absent).
- *Edge*: rate limit trips after N failed attempts (429) and resets after the
  window.
- *Authz baseline*: guarded route without a cookie → 401.

**Acceptance.** Auth works end-to-end via `app.request` with a cookie jar.

---

## Iteration 1.4 — Profile & settings (`systemPrompt`, language, model)

**Goal.** `GET /me`, `PATCH /me`.

**Depends on.** 1.3.

**Build.**
- `src/services/profile-service.ts`: read/update `name`, `systemPrompt`,
  `defaultLanguage`, `defaultModel`. `GET /me` returns the public user;
  `PATCH /me` validates and updates, bumping `updatedAt`.

**Tests.**
- *Happy*: `PATCH /me` updates `systemPrompt`; `GET /me` reflects it.
- *Scenario*: partial patch (only `defaultLanguage`) leaves `systemPrompt` intact.
- *Edge*: unauth → 401; `email`/`passwordHash` are **not** mutable via this route
  (ignored or 422).
- *Edge*: oversized `systemPrompt` rejected with a clear limit; empty allowed.

**Acceptance.** Users own and edit their single prompt.

---

# Phase 2 — Sources & credentials

## Iteration 2.1 — `Source` table + encrypted credentials repository

**Goal.** Persist per-connector accounts with **encrypted** credentials.

**Depends on.** 1.1, 0.4.

**Build.**
- `src/db/schema/source.ts`: `Source` per the model. `credentials` is a `jsonb`
  column holding the `EncryptedBlob` (ciphertext, **never plaintext**); `position`
  int nullable; `enabled`; `UNIQUE(userId, connectorId)`. Migration.
- `src/repositories/source-repository.ts`: CRUD scoped by `userId`. On write it
  takes already-encrypted blobs; on read it returns rows **without** decrypting
  by default. A separate explicit `getDecryptedCredentials(sourceId, userId)`
  performs decryption via `CredentialCipher` (used only by the connector factory,
  never by API serializers).
- Zod validators for the per-connector credential shapes (e.g. Telegram
  `{ sessionString }`, validated **before** encryption and **after** decryption).

**Tests.**
- *Happy*: create a Telegram source → DB row's `credentials` is an `EncryptedBlob`
  (no substring of the plaintext session present); `getDecryptedCredentials`
  returns the original.
- *Scenario*: `UNIQUE(userId, connectorId)` — a second Telegram source for the
  same user → `ConflictError`; a Telegram source for a *different* user is fine.
- *Authz edge*: `getDecryptedCredentials` with a non-owner `userId` → `NotFoundError`
  (no cross-user decrypt).
- *Edge*: the public list serializer omits `credentials` entirely (assert shape).
- *Edge*: a row whose blob fails to decrypt (rotated key) surfaces a clear error,
  not a crash mid-pipeline.

**Acceptance.** Credentials are encrypted at rest; never serialized; never logged.

---

## Iteration 2.2 — Source management API

**Goal.** List / reorder / disconnect sources (no Telegram login yet).

**Depends on.** 2.1.

**Build.**
- `GET /sources` (public shape, no secrets), `PATCH /sources/:id`
  (`position`, `enabled`), `DELETE /sources/:id` (**disconnect = non-destructive
  credential revocation, not history deletion**): wipe/delete only the credential
  material, set the source `enabled = false`, soft-delete its active feeds, and
  preserve the `Source`/`Feed` rows needed for historical joins. This requires
  `Source.credentials` to become nullable before Phase 2 starts.

**Tests.**
- *Happy*: list returns the user's sources ordered by `position` then `createdAt`.
- *Scenario*: reorder via `position` changes list order.
- *Authz*: a user cannot see/patch/delete another user's source (404).
- *Edge*: disconnect preserves historical summaries/digests while making future
  fetches impossible until the source is re-connected.
- *Edge*: disconnect response prompts the caller (response field/flag) to revoke
  the Telegram session in-app (documented in the response).

**Acceptance.** Source lifecycle works and is user-scoped.

---

## Iteration 2.3 — Telegram web QR-login flow

**Goal.** Connect a Telegram account from the web: server-driven QR login →
capture session string → encrypt → store as a `Source`.

> **Why QR (validated).** MTProto user login over the web is best done with
> `signInUserWithQrCode`: the server holds a transient GramJS client, produces a
> `tg://login?token=…` URL, the browser renders it as a QR, the user approves in
> their Telegram app, then the server handles optional 2FA. It avoids phone/SMS
> code entry and is the cleanest server-driven flow. **Fallback** (later
> iteration, optional): phone-number + login-code + 2FA. Note both in code.

**Depends on.** 2.1, 1.3. Refactors the connector client creation from 0.1's
codebase (the existing CLI `createTelegramClient` becomes one caller of a new
factory).

**Build.**
- `src/connectors/telegram/login-session.ts`: a **transient login session
  manager**. `startLogin(userId)` creates a live GramJS client bound to a
  server-side, in-memory, TTL'd login-session id; returns the QR token/URL.
  `pollLogin(loginSessionId)` returns `pending | needs_2fa | complete | error |
  expired`. `submit2fa(loginSessionId, password)` continues. On `complete`,
  serialize the session string, **encrypt via `CredentialCipher`**, upsert a
  Telegram `Source`, and **dispose the live client**. Enforce a short TTL and a
  hard cap on concurrent login sessions per user.
- HTTP: `POST /connectors/telegram/login` (start → `{ loginSessionId, qrUrl }`),
  `GET /connectors/telegram/login/:id` (poll status; SSE optional, polling fine),
  `POST /connectors/telegram/login/:id/2fa`.
- `src/connectors/telegram/client-factory.ts`: `createClientFromSession(session:
  string)` used by both login completion and the pipeline. Keep the env-based
  `createTelegramClient` for `dev:cli` only.

**Tests.** (Fake GramJS client like `tests/connector.test.ts` — never hit
Telegram.)
- *Happy*: start → fake client yields a QR token (assert `qrUrl` shape); poll
  returns `pending`; on fake approval, completion stores a Telegram `Source`
  whose `credentials` is encrypted and decrypts to the fake session string.
- *Scenario — 2FA*: fake client signals 2FA needed → poll returns `needs_2fa`;
  `submit2fa` with correct password → `complete` + source stored; wrong password
  → stays `needs_2fa`/`error`, no source written.
- *Scenario — re-connect*: completing login when a Telegram source already exists
  for the user **updates** that source's credentials (no duplicate; honors the
  unique constraint).
- *Edge — expiry*: polling an expired/unknown `loginSessionId` → `expired`/404;
  the transient client is disposed (assert cleanup hook called).
- *Edge — abandonment*: a login session past TTL is reaped; concurrent-login cap
  enforced (Nth start → 429/clear error).
- *Edge — secrets*: the session string never appears in any response, log line,
  or error; only the stored ciphertext exists.
- *Authz*: poll/2fa for a `loginSessionId` not owned by the caller → 404.

**Acceptance.** A user can connect Telegram end-to-end (with faked MTProto) and
the resulting session is stored encrypted. Manual smoke against real Telegram is
a reviewer step, noted but not automated.

---

# Phase 3 — Feeds

## Iteration 3.1 — `Feed` table + repository

**Goal.** Persist subscriptions.

**Depends on.** 2.1.

**Build.**
- `src/db/schema/feed.ts`: `Feed` per the model (`kind`, `customPrompt?`,
  `position?`, `enabled`, `deletedAt?`, `lastFetchedPeriodEndMs?`,
  `UNIQUE(sourceId, externalId)`). Migration.
- `src/repositories/feed-repository.ts`: CRUD scoped via the owning source's
  `userId` (join through `Source`). `listForUser`, `listForSource`,
  `softDelete`, `setLastFetched`. Soft-deleted feeds excluded from default lists.

**Tests.**
- *Happy*: create → list (excludes soft-deleted); `softDelete` sets `deletedAt`
  and hides it from default queries but the row persists.
- *Scenario*: `UNIQUE(sourceId, externalId)` blocks a dup; the **same**
  `externalId` under a **different** source is allowed (proves per-source scope).
- *Authz*: feeds are reachable only through the owner; cross-user access → 404.
- *Edge*: `setLastFetched` updates only the cursor; re-subscribing a
  soft-deleted feed (same `externalId`) **revives** it (clear `deletedAt`) rather
  than failing the unique constraint — define and test this.
- *Edge*: `kind` constrained to the `FeedKind` set; bad value → validation error.

**Acceptance.** Feed lifecycle + soft-delete semantics proven.

---

## Iteration 3.2 — Feed discovery + subscribe/unsubscribe

**Goal.** Enumerate subscribable feeds from a connected Source; subscribe creates
a `Feed`.

**Depends on.** 3.1, 2.3 (needs a connected source + client factory).

**Build.**
- Extend the connector with a **discovery** method (e.g. `listAvailableFeeds():
  Promise<{ externalId, name, kind }[]>`) — for Telegram, list dialogs/channels
  the user can pick. Add to the `Connector` interface as an optional capability
  (not every connector supports discovery; RSS is user-entered).
- `src/services/feed-service.ts`: `discover(sourceId, userId)` builds a client
  from decrypted creds and lists candidates; `subscribe(sourceId, userId,
  externalId, kind)` creates/【revives】a `Feed`; `unsubscribe` soft-deletes.
- HTTP: `GET /sources/:id/available-feeds`, `POST /sources/:id/feeds`,
  `DELETE /feeds/:id`.

**Tests.** (Fake Telegram client.)
- *Happy*: discovery returns the fake dialogs as candidates with a default `kind`
  (group → discussion, channel → news).
- *Scenario*: subscribe persists a `Feed`; subscribing the same `externalId`
  twice → idempotent or 409 (define); unsubscribe soft-deletes.
- *Edge*: discovery on a source with bad/expired credentials surfaces a clear,
  user-facing error (re-connect prompt), not a 500.
- *Authz*: discover/subscribe against another user's source → 404.

**Acceptance.** A user can turn a connected account into a set of feeds.

---

## Iteration 3.3 — Feed management API (kind, prompt, order, enable)

**Goal.** Edit feed knobs.

**Depends on.** 3.1.

**Build.**
- `PATCH /feeds/:id`: `kind`, `customPrompt`, `position`, `enabled`.
- `GET /feeds` and `GET /sources/:id/feeds`: ordered by `position` then `name`.

**Tests.**
- *Happy*: set `customPrompt`, `kind`, `position`, toggle `enabled`; reads reflect.
- *Scenario*: disabling a feed excludes it from digest assembly later (asserted
  again in Phase 6, referenced here).
- *Edge*: empty `customPrompt` clears the override; oversized → 422.
- *Authz*: patch another user's feed → 404.

**Acceptance.** Per-feed steering works.

---

# Phase 4 — Connector integration & ingestion

## Iteration 4.1 — Connector factory + feed-scoped fetching

**Goal.** Build a connector per `Source` from decrypted creds, and fetch scoped
to the user's subscribed feeds (the "connector feed-filtering" evolution).

**Depends on.** 2.3, 3.1.

**Build.**
- Evolve `Connector.getNormalizedData(from, to, feedExternalIds?)` — optional
  filter so a fetch is scoped to one user's subscriptions (document in
  `connector.types.ts`; default `undefined` = all, preserving CLI behavior).
- `src/connectors/connector-factory.ts`: `forSource(source, decryptedCreds)` →
  a `Connector`. Telegram builds a client from the session via 2.3's factory.
- Update `TelegramConnector` to honor the `feedExternalIds` filter.

**Tests.** (Fake client.)
- *Happy*: factory builds a Telegram connector; `getNormalizedData(from,to,[a,b])`
  returns only feeds `a`,`b` even when the client exposes more.
- *Scenario*: no filter → all feeds (CLI back-compat).
- *Edge*: a requested `feedExternalId` the account can't see → omitted, no throw.
- *Edge*: decrypted-credential failure → typed error that the caller maps to a
  re-connect prompt.

**Acceptance.** Fetching is per-user, per-subscription.

---

## Iteration 4.2 — `Item` table + ingestion service (upsert + cursor)

**Goal.** Persist the normalized item cache and advance the fetch cursor.

**Depends on.** 4.1.

**Build.**
- `src/db/schema/item.ts`: `Item` per the model (`payload` jsonb = the
  `NormalizedItem`; `date`, `fetchedAt` epoch-ms; `UNIQUE(feedId, externalId)`).
  Migration.
- `src/repositories/item-repository.ts`: `upsertMany` (Drizzle
  `onConflictDoUpdate` on `(feedId, externalId)` setting `payload`, `fetchedAt`);
  `listForFeedInWindow(feedId, from, to)`.
- `src/services/ingestion-service.ts`: for a feed, compute the window
  (`from = lastFetchedPeriodEndMs + 1` or a default lookback; `to = now`), fetch
  via the connector, upsert items, then `setLastFetched(to)`. Validate each
  `payload` with the `NormalizedItem` Zod schema before storing.

**Tests.** (Fake connector returning canned `NormalizedItem`s.)
- *Happy*: ingest writes N items; `listForFeedInWindow` returns them.
- *Scenario — upsert/edit*: re-ingesting the same `externalId` with changed text
  **updates** `payload` + `fetchedAt`, does not duplicate (row count stable).
- *Scenario — cursor*: after ingest, `lastFetchedPeriodEndMs == to`; the next run
  computes `from` just past it (assert the window math).
- *Edge — overlap*: overlapping windows don't double-insert (unique upsert).
- *Edge — empty fetch*: zero items still advances the cursor (no infinite re-fetch).
- *Edge — bad payload*: a `NormalizedItem` failing Zod is rejected with a clear
  error and does not poison the batch (define: skip-with-log vs fail-batch).
- *Edge*: first-ever ingest (no cursor) uses the default lookback window.

**Acceptance.** Ingestion is idempotent, cursored, and validated.

---

# Phase 5 — Summarization

## Iteration 5.1 — `Summary` table + repository (immutable)

**Goal.** Persist per-feed, per-period summaries.

**Depends on.** 3.1.

**Build.**
- `src/db/schema/summary.ts`: `Summary` per the model (`points` jsonb,
  `feedNameSnapshot`, `generatedAt`; `UNIQUE(feedId, periodStartMs,
  periodEndMs)`; **no `updatedAt`**). A `(feedId, period)` summary row is
  **replaceable on re-run** — re-running overwrites `points` and `generatedAt`
  for that period, while history against feed rename/delete is preserved via
  `feedNameSnapshot`.
- `src/repositories/summary-repository.ts`: `upsertForPeriod` overwrites the same
  `(feedId, period)` row; `findForFeedPeriod`, `listForUserPeriod` (join
  Feed→Source).

**Tests.**
- *Happy*: insert → `findForFeedPeriod` round-trips `points` + `feedNameSnapshot`.
- *Scenario*: re-running the same `(feedId, period)` overwrites `points` and
  `generatedAt`, row count stable (unique honored).
- *Edge*: `points` jsonb validated against the `SummaryPoint[]` Zod schema in/out.
- *Edge*: `listForUserPeriod` excludes summaries of soft-deleted feeds? — define:
  **include** them (history must render) but mark their source/feed as removed.
- *Authz*: `listForUserPeriod` only returns the caller's summaries.

**Acceptance.** Summaries persist immutably with name snapshots.

---

## Iteration 5.2 — Summarization service (layered prompt + persist)

**Goal.** Turn cached `Item`s for a feed+period into a persisted `Summary`.

**Depends on.** 5.1, 4.2, 1.4.

**Build.**
- `src/summarizers/compose-prompt.ts`: build the layered system prompt — base
  role (from `prompts.ts`) + `User.systemPrompt` + `Feed.customPrompt?` +
  kind-specific instructions — **in `prompts.ts`/this module only**, never inline.
- `src/services/summarization-service.ts`: gather `Item`s for `(feed, period)`,
  compose the prompt, call the existing `SummarizerService`, persist a `Summary`
  with `feedNameSnapshot = feed.name` at write time.

**Tests.** (Fake summarizer via `captureFetch`/stub like `tests/summarizer.test.ts`.)
- *Happy*: produces a `Summary`; the request sent to the model contains base +
  user prompt + feed prompt + kind instructions **in that order**.
- *Scenario — no feed prompt*: layering still well-formed (3 layers).
- *Scenario — language/model*: `User.defaultLanguage`/`defaultModel` flow into the
  ruleset/summarizer call.
- *Edge — empty window*: a feed with no items yields an empty/"nothing to report"
  summary (define) without calling the model unnecessarily, or with a guard.
- *Edge — snapshot*: renaming the feed after summarization does not change the
  stored `feedNameSnapshot`.
- *Edge — re-run*: re-summarizing overwrites the period's row (no dup).

**Acceptance.** End-to-end feed→summary with correct prompt composition.

---

# Phase 6 — Digests

## Iteration 6.1 — `Digest` table + repository

**Goal.** Persist the morning post record.

**Depends on.** 5.1.

**Build.**
- `src/db/schema/digest.ts`: `Digest` per the model (`status`, `createdAt`,
  `updatedAt`). Migration. (Sections are **not** stored — derived in 6.2.)
- `src/repositories/digest-repository.ts`: `create`, `setStatus`,
  `findForUserPeriod`, `listForUser`.

**Tests.**
- *Happy*: create (status `pending`) → `setStatus("complete")` bumps `updatedAt`.
- *Scenario*: status transitions pending→complete and pending→failed allowed;
  define/guard illegal transitions (e.g. complete→pending) → error.
- *Authz*: a user only lists/reads their own digests.
- *Edge*: one digest per `(user, period)` — define unique/upsert behavior.

**Acceptance.** Digest records persist with a status lifecycle.

---

## Iteration 6.2 — Digest assembly (derived sections)

**Goal.** Compose a digest for a user+period from the period's summaries.

**Depends on.** 6.1, 5.2, 2.1, 3.1.

**Build.**
- `src/services/digest-service.ts`: `assemble(userId, period)` — for each enabled,
  non-deleted feed, ensure a `Summary` exists for the period (call 5.2 if
  missing), create/locate the `Digest`, set status, and **derive ordered
  sections** = the period's summaries ordered by `(Source.position, then
  Feed.position, then feed name)`. Sections are a computed view object, not rows.
  **Assembly** only creates missing summaries for currently enabled,
  non-deleted feeds. **Digest reads** (6.3) must still include already-existing
  summaries for the digest period even when a feed is now soft-deleted, using
  `feedNameSnapshot` and marking the feed removed.

**Tests.**
- *Happy*: a user with 2 sources × 2 feeds yields 4 ordered sections; order
  follows `Source.position` then `Feed.position`/name (construct positions to
  prove precedence).
- *Scenario — disabled/soft-deleted feeds*: excluded from a freshly assembled
  digest, but historical summaries for the same period still appear on read.
- *Scenario — partial failure*: if one feed's summarization throws, the digest is
  marked **`failed`** but still returns the successful derived sections; reserve
  `complete` for all feeds succeeding.
- *Edge — empty*: a user with no feeds → an empty digest, status `complete`, no
  crash.
- *Edge — idempotent*: re-assembling the same period reuses summaries and does
  not duplicate the digest.

**Acceptance.** Digest = correctly-ordered derived view over summaries,
including historical rows after later feed deletion.

---

## Iteration 6.3 — Digest read API (JSON + rendered views)

**Goal.** Expose digests; views are pure derivations.

**Depends on.** 6.2.

**Build.**
- `GET /digests` (list), `GET /digests/:id` (JSON with derived sections),
  `GET /digests/:id.md` (markdown render) — **readable date formatting happens
  here** (presentation layer), epoch-ms → human strings. Reading a digest
  includes the period's already-existing summaries even if the feed is now
  soft-deleted; use `feedNameSnapshot` and mark the feed removed.

**Tests.**
- *Happy*: JSON digest has ordered sections each with feed name (snapshot),
  points, and source grouping.
- *Scenario*: markdown render contains section headers in the right order and
  formatted dates.
- *Authz*: reading another user's digest → 404.
- *Edge*: a digest referencing a since-deleted feed still renders via
  `feedNameSnapshot` and is marked removed.

**Acceptance.** Digests are viewable; rendering is derivative only.

---

# Phase 7 — Orchestration & scheduling

## Iteration 7.1 — Run orchestrator (end-to-end, idempotent)

**Goal.** "Produce user X's digest for period P" as one composable operation.

**Depends on.** 4.2, 5.2, 6.2.

**Build.**
- `src/services/orchestrator.ts`: `runForUser(userId, period)` = ingest all
  enabled feeds → summarize each for the period → assemble the digest. Per-feed
  failures isolated (one bad feed doesn't sink the run). Structured logging at
  each step (the deferred `Run` audit table goes here later — leave a clearly
  scoped comment pointer per AGENTS.md).

**Tests.** (Fakes for connector + summarizer; real DB.)
- *Happy*: a user with connected source + feeds gets items, summaries, and a
  complete digest in one call.
- *Scenario — idempotent*: running twice for the same period doesn't duplicate
  items/summaries/digests.
- *Scenario — new user*: zero sources → completes with an empty digest.
- *Edge — one feed errors*: others still produce; digest status reflects the
  partial per 6.2's rule.
- *Edge — expired credentials*: surfaces a per-source re-connect signal; other
  users/sources unaffected.

**Acceptance.** One call yields a correct digest from raw fetch.

---

## Iteration 7.2 — Scheduler (Deno.cron behind an interface)

**Goal.** Trigger orchestration on a cadence per user.

**Depends on.** 7.1.

**Build.**
- `src/scheduler/scheduler.ts`: `interface Scheduler { schedule(name, cron, fn) }`
  + a `DenoCronScheduler` (`Deno.cron`, needs the unstable flag — document in
  tasks). A `digest-job.ts` that, on tick, enumerates active users and computes
  each user's **digest period** from the latest `Digest.periodEndMs` plus cadence
  (or another explicit user-level schedule source), then calls `runForUser`.
  `Feed.lastFetchedPeriodEndMs` remains a per-feed ingestion cursor only: each
  feed is fetched up to that digest period end before summarization. Concurrency
  cap so a slow user doesn't starve others.

**Tests.** (Inject a fake `Scheduler` and a fake clock — do not rely on real
cron timing.)
- *Happy*: a tick triggers `runForUser` for each active user exactly once.
- *Scenario — period math*: the computed user digest period starts at the latest
  `Digest.periodEndMs` plus cadence and ends at \"now\" (fake clock); back-to-back
  ticks don't overlap digest periods.
- *Edge — no active users*: tick is a no-op.
- *Edge — one user throws*: other users still run (isolation); the failure is
  logged, not fatal.
- *Edge — overlap guard*: a still-running user is not double-scheduled.

**Acceptance.** Scheduling is deterministic under a fake clock and isolated.

---

# Phase 8 — Security & hardening pass

## Iteration 8.1 — Authorization & secrets audit (cross-cutting)

**Goal.** Prove the invariants hold everywhere, not per-route by luck.

**Depends on.** all prior.

**Build.**
- A shared authz helper asserting ownership on every `:id` route; adopt it across
  handlers. A response-serializer layer that structurally cannot emit
  `credentials`/`passwordHash`/session tokens. By Phase 8, auth rate limiting is
  already present on register/login and QR-login/2FA; this phase audits coverage,
  tunes thresholds, and closes any gaps with a simple in-DB or in-memory limiter.

**Tests.**
- *Scenario — authz matrix*: for every owned resource (source, feed, summary,
  digest, login-session), a second user gets 404/403 on read/update/delete.
- *Scenario — secret leakage sweep*: hit every GET endpoint and assert no
  response body contains an encrypted-blob field decrypted, a password hash, or a
  raw session token; grep the captured logs from the test run for the fake
  session string and assert absence.
- *Edge — rate limit*: N failed logins in a window → 429; resets after the
  window, and QR-login start/2FA are likewise rate-limited.

**Acceptance.** A documented authz matrix passes; no secret escapes any surface.

---

# Cross-cutting test infrastructure (build in 0.2, used everywhere)

- `withTestDb(fn)` — transactional, rolled-back, isolated (Iteration 0.2).
- `makeUser()/makeSource()/makeFeed()/...` factory helpers (add per phase) that
  insert minimal valid rows, mirroring the existing `item()`/`fakeApiMessage()`
  factory style.
- Fake `Connector` and fake `SummarizerService` implementing the interfaces with
  canned data — reuse `stubFetch`/`captureFetch` for the LLM HTTP boundary and
  the `fakeTelegramClient` pattern for MTProto.
- A cookie-jar helper for authed `app.request` calls.

# Out of scope (explicitly deferred — re-add additively)

- Frontend UI (separate plan).
- Email/delivery (Presenter renders; sending deferred).
- `Run` job-audit table (logging for now; add when ops needs it).
- Automatic feed theme classification / tags / `pgvector`.
- KMS wiring (the `KeyProvider` seam is built; the env provider ships first).
- Phone+code Telegram login fallback; multiple accounts per connector.
- `Feed.config` column (add when a connector needs per-feed settings).

# Suggested review cadence

One PR per iteration, in order. A phase is "done" only when its iterations are
green on real Postgres and the authz/secrets tests for the new surface pass. The
reviewer runs `deno check`, `deno lint`, and `deno task test` across the union of
changed files at each phase boundary; the implementer does not run project-wide
gates or formatters.
