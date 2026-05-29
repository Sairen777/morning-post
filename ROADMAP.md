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
("politics", "tech", …). These map to a curated **tag** vocabulary. They can
elaborate per interest and add a free-form description in a textarea. An LLM
condenses all of that into a single `generatedPrompt` stored on their
`InterestProfile`; the raw answers are kept so the prompt can be regenerated
whenever interests change. Everything is editable in settings.

A user can attach a `customPrompt` to any individual feed. It is composed with
the user's general prompt by explicit layering (see ARCHITECTURE.md → Prompt
layering), not by a vague "higher priority".

Each feed's theme is classified on add, then refreshed on a schedule: an LLM
picks tag(s) from the controlled vocabulary. Theme tags **boost** the relevant
fragments of the prompt — they never hard-gate the user's general prompt.

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
- defaultLanguage? (default summary/presentation language)
- defaultModel? (optional per-user model override)
- createdAt, updatedAt

### InterestProfile (1:1 with User)

Raw answers are the source of truth; `generatedPrompt` is a derived cache. It
MUST be regenerated whenever `rawAnswers` or any of the user's `UserTag` rows
change — the regenerate action writes `generatedPrompt`, bumps `promptVersion`,
and sets `generatedAt` atomically.

- userId (PK / FK)
- rawAnswers: jsonb — free-form questionnaire dump, read back as a whole
- generatedPrompt: text — LLM-condensed from rawAnswers + the user's tags
- generatedAt
- promptVersion — bumped on each regeneration; useful for diagnostics and for
  detecting when a user's prompt is newer than a cached summary (the
  `rulesetHash` will differ). No direct link to `Summary`.

### Tag (curated controlled vocabulary, seeded)

- id
- slug (unique; deterministic lowercase-with-dashes)
- displayName
- description? — helps the classifier map feed content onto the tag
- createdAt

### UserTag (M:N user ↔ tag — the checkbox selections)

- userId (FK)
- tagId (FK)
- PK(userId, tagId)

### Source (one per user per connector; holds credentials)

- id
- userId (FK)
- connectorId (ConnectorId enum)
- credentials: jsonb — per-connector shape (Telegram session string, Reddit OAuth, …)
- enabled
- createdAt, updatedAt
- UNIQUE(userId, connectorId)

### Feed (a single subscription within a source)

Replaces the old per-connector `TelegramChannel` / `TelegramDialogue` /
`…Source` tables. Connector-specific fields live in `config`, the persistence
twin of `NormalizedItem.meta`.

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
- enabled — soft pause without unsubscribing
- deletedAt? — soft delete (summaries are retained; see Deletion & history)
- config: jsonb — per-connector feed settings; forward-looking, often `{}` in v1
  (feed identity is `externalId` / `name` / `kind`)
- lastFetchedPeriodEndMs? — scheduler cursor; the next fetch window is
  `from = lastFetchedPeriodEndMs + 1, to = now`. A brand-new feed falls back to
  a fixed lookback.
- createdAt, updatedAt
- UNIQUE(sourceId, externalId)

### FeedTag (M:N feed ↔ tag — theme classification)

- feedId (FK)
- tagId (FK)
- inferred — true = LLM-classified, false = user-set
- inferredAt? — TTL for the scheduled re-classification job
- PK(feedId, tagId)

### Item (cached NormalizedItem)

Lets a period be re-summarized (e.g. after a prompt change) without
re-fetching, and survives connector hiccups.

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
string. `rulesetHash` is the cache key — it hashes the composed prompt layers, so
editing any layer invalidates only the affected summaries.

- id
- feedId (FK)
- periodStartMs, periodEndMs
- rulesetHash
- points: jsonb — SummaryPoint[], rendered as a whole
- feedNameSnapshot — feed name at generation time; survives rename and soft-delete
- generatedAt
- UNIQUE(feedId, periodStartMs, periodEndMs, rulesetHash)

### Digest (the morning post — composite across feeds for a period)

- id
- userId (FK)
- periodStartMs, periodEndMs
- status: 'pending' | 'complete' | 'failed'
- createdAt

v1 models one `Digest` per `(user, period)`. Multiple named digests per user
(a `Digest.label` / `kind`) are deferred — additive later, no schema break.

### DigestSection (normalized; replaces a `Digest.sections` JSON blob)

Normalized because it is queried, reordered, and joined.

- id
- digestId (FK)
- summaryId (FK)
- feedId (FK) — intentionally denormalized from `Summary.feedId` (read-path
  convenience: sections-by-feed without a join). Do not normalize it away.
- titleSnapshot
- orderIndex
- UNIQUE(digestId, orderIndex)

### Run (job auditability)

- id
- userId (FK)
- digestId? (FK) — null while a run executes, set on completion; null after
  failure means no digest was produced; non-digest runs (e.g. re-classification
  jobs) stay null permanently.
- startedAt, finishedAt?
- status: 'running' | 'success' | 'failed'
- error?

## Deletion & history

Past summaries are immutable: a feed soft-delete (`Feed.deletedAt`) never
deletes or rewrites `Summary` rows. Each `Summary` carries `feedNameSnapshot` so
a digest still renders correctly after the feed is renamed upstream or removed.
Soft-delete keeps the relational link alive for queries like "all my summaries
from this feed this year, including from before I unsubscribed".

## Theme classification

Throw feed content at the LLM and have it pick tag slug(s) from the controlled
vocabulary (e.g. "classify this; reply with one slug from this list: …"). Run on
feed add, then re-run on a schedule for feeds whose `FeedTag.inferredAt` is older
than the TTL; expose a manual "re-classify now" action.