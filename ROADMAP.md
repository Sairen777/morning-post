<!-- Authored by: Claude Sonnet 4.5 (claude-sonnet-4-5-20250929) -->
- [] telegram
- [] substack
- [] rss
- [] reddit selected subreddits (post summarize only?)
- [] optionally parse comments (telegram, youtube, substack etc)

## Flow

User registers and adds **sources** (one per connector they connect, e.g. their
Telegram account). Within each source they subscribe to **feeds** — the
individual channels, group dialogues, subreddits, or RSS URLs they want
summarized.

During onboarding the user picks interests from a screen of checkboxes
("politics", "tech", …) backed by a hardcoded UI constant — NOT a database
vocabulary — and may add a free-form description in a textarea. A questionnaire
UI MAY use an LLM to draft a starting prompt from those answers, but only the
final, editable `systemPrompt` is stored on the `User` (no raw answers, no
derived/regenerated cache). Everything is editable in settings.

A user can attach a `customPrompt` to any individual feed for per-feed steering.
It is composed with the user's `systemPrompt` by explicit layering (see
ARCHITECTURE.md → Prompt layering), not by a vague "higher priority".

The digest is ordered by **source** (`Source.position`) and then by **feed**
(`Feed.position`, else name). Automatic per-feed theme classification is deferred
(see ARCHITECTURE.md → Things to Consider).

Connectors to build: see the checklist above (Telegram, Substack, RSS, Reddit;
optional comment parsing).

## Entities

All ids are uuid. All cross-layer timestamps are **epoch milliseconds**
(`number`) — see ARCHITECTURE.md. JSON columns use `jsonb` and are
shape-validated at the app boundary; see the JSON ledger in ARCHITECTURE.md.

### User

- id
- name
- email (unique)
- passwordHash (argon2id — never store plaintext)
- systemPrompt — the effective summarization prompt. User-editable; a
  questionnaire UI MAY LLM-draft it, but only the final prompt is stored (no
  raw answers, no derived/regenerated cache).
- defaultLanguage? (default summary/presentation language)
- defaultModel? (optional per-user model override)
- createdAt, updatedAt

### Source (one per user per connector; holds credentials)

- id
- userId (FK)
- connectorId (ConnectorId enum)
- credentials: jsonb — per-connector secrets, stored ENCRYPTED (authenticated; key outside the DB). A Telegram session string is full-account access; see the Credentials note below.
- position? — PRIMARY digest sort key (orders the platform/section buckets)
- enabled
- createdAt, updatedAt
- UNIQUE(userId, connectorId)

**Credentials are the crown jewels.** A Telegram session string is an
unrevokable, full-account bearer token — only the user can kill it in
Telegram → Devices; there is no server-side scope or revoke. This is a
multi-user service on a VPS, so store `credentials` with **envelope encryption +
per-user data keys** and keep the **master key off the box** (a KMS / external
secrets service), never on the VPS disk, in a column, or in DB backups — an
on-box key is barely better than plaintext against a rooted host, whereas an
off-box key gives a revocation kill-switch and stays out of backup blast radius.
Prefer the least-powerful credential a connector offers (OAuth scopes, bot
tokens) to shrink the radius. "Disconnect" deletes the row; for Telegram also
prompt the user to revoke the session. See ARCHITECTURE → Credentials & secrets.

### Feed (a single subscription within a source)

Replaces the old per-connector `TelegramChannel` / `TelegramDialogue` /
`…Source` tables.

- id
- sourceId (FK)
- externalId — the connector's native id for the channel / dialogue / subreddit
  / feed URL. Unique only WITHIN its source (`UNIQUE(sourceId, externalId)`): two
  users subscribing to the same channel yield two feeds sharing one externalId.
  The runtime `NormalizedData` map key (and `NormalizedItem.sourceId`) is this
  external id — source-scoped, NOT a global id and NOT a `Source`. Resolve it to
  a `Feed` via the `(sourceId, externalId)` pair or the surrogate `Feed.id`.
  Slated to be renamed `feedExternalId` (and `SourceSummary` → `FeedSummary`)
  before persistence integration.
- name
- kind: 'news' | 'discussion' | … — drives ruleset selection. The caller passes
  it to `selectRuleset(items, kind)`; it is no longer inferred from the runtime
  `meta.isGroup` flag.
- customPrompt? — feed-level override, layered over the user prompt
- position? — optional within-source order (else order by name)
- enabled — soft pause without unsubscribing
- deletedAt? — soft delete (summaries are retained; see Deletion & history)
- lastFetchedPeriodEndMs? — scheduler cursor; the next fetch window is
  `from = lastFetchedPeriodEndMs + 1, to = now`. A brand-new feed falls back to
  a fixed lookback.
- createdAt, updatedAt
- UNIQUE(sourceId, externalId)

### Item (cached NormalizedItem)

Lets a period be re-summarized (e.g. after a prompt change) without
re-fetching, and survives connector hiccups. RSS/Reddit cannot re-fetch past
content, so this cache becomes load-bearing once those connectors land.

- id
- feedId (FK)
- externalId
- date
- payload: jsonb — the NormalizedItem blob, read as a whole
- fetchedAt
- UNIQUE(feedId, externalId) — writes upsert: `ON CONFLICT (feedId, externalId)
  DO UPDATE payload, fetchedAt`, so a re-fetched edited message refreshes the
  cache rather than failing or silently skipping.

### Summary (per-feed, per-period result — immutable)

One concept replacing the old `ChannelSummary` + `DialogueSummary`. A period is
an explicit epoch-ms range (the pipeline already takes `(from, to)`), not a day
string. Re-running a window produces/overwrites that window's summary; there is
no hash-based cache invalidation.

- id
- feedId (FK)
- periodStartMs, periodEndMs
- points: jsonb — SummaryPoint[], rendered as a whole
- feedNameSnapshot — feed name at generation time; survives rename and soft-delete
- generatedAt
- UNIQUE(feedId, periodStartMs, periodEndMs)

### Digest (the morning post — composite across feeds for a period)

- id
- userId (FK)
- periodStartMs, periodEndMs
- status: 'pending' | 'complete' | 'failed'
- createdAt, updatedAt

Sections are DERIVED, not stored: the period's `Summary` rows for the user's
non-deleted feeds, ordered by `Source.position`, then by `Feed.position` (else
feed name). v1 models one `Digest` per `(user, period)`. Multiple named digests
per user (a `Digest.label` / `kind`) are deferred — additive later, no schema
break.

## Deletion & history

Past summaries are immutable: a feed soft-delete (`Feed.deletedAt`) never
deletes or rewrites `Summary` rows. Each `Summary` carries `feedNameSnapshot` so
a digest still renders correctly after the feed is renamed upstream or removed.
Soft-delete keeps the relational link alive for queries like "all my summaries
from this feed this year, including from before I unsubscribed".