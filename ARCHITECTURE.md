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

- **User** owns one **InterestProfile** (1:1), many **UserTag** links into the
  curated **Tag** vocabulary, and many **Source** rows (one per connector,
  holding that connector's credentials).
- A **Source** has many **Feed** rows — the individual subscriptions (channel,
  dialogue, subreddit, RSS URL). A **Feed** has many **FeedTag** links (its
  classified themes), cached **Item** rows, and immutable **Summary** rows.
- A **Digest** is the user-facing morning post for a period; its ordered
  **DigestSection** rows reference the **Summary** rows it aggregates. A **Run**
  records each job execution for audit.

The persistence model mirrors the runtime's connector-agnostic stance: one
generic `Source`/`Feed`/`Summary` triad instead of per-connector tables.
Connector-specific fields live in `Source.credentials` and `Feed.config` — the
persistence twin of `NormalizedItem.meta`.

All cross-layer timestamps are epoch ms (`number`); periods are explicit
`periodStartMs`/`periodEndMs` ranges, never a day string.

**Deletion is non-destructive to history.** A feed is soft-deleted
(`Feed.deletedAt`); `Summary` rows are never deleted or rewritten. Each summary
snapshots `feedNameSnapshot` at generation time so digests still render after a
feed is renamed upstream or removed.

#### Scheduling, caching & lifecycle invariants

- **Fetch-window cursor.** Each `Feed` records `lastFetchedPeriodEndMs`. The
  scheduler computes the next window as `from = lastFetchedPeriodEndMs + 1,
  to = now`; a brand-new feed falls back to a fixed lookback. The
  `UNIQUE(Item.feedId, externalId)` constraint makes overlapping windows safe.
- **Item upsert.** `Item` writes are `ON CONFLICT (feedId, externalId) DO
  UPDATE payload, fetchedAt` — re-fetching an edited message refreshes the
  cache rather than failing or silently skipping.
- **`DigestSection.feedId` is intentionally denormalized** from
  `Summary.feedId` (read-path convenience: sections-by-feed without a join).
  Do not normalize it away.
- **Digest scope (v1).** One `Digest` per `(user, period)`. Multiple named
  digests per user (a `Digest.label`/`kind`) are deferred — additive later, no
  schema break.
- **`Run.digestId` semantics.** Null while a run executes, set on completion;
  null after failure means no digest was produced; non-digest runs (e.g.
  re-classification jobs) stay null permanently.

#### JSON columns

Use `jsonb`, never `json` (binary, indexable). Validate every JSON column's
shape at the app boundary (Zod/Valibot) on read and write — the DB does not
enforce it. Reserve JSON for polymorphic or read-whole blobs; normalize anything
you filter, join, sort, or aggregate on.

| Column                       | Storage    | Why                                                       |
| ---------------------------- | ---------- | --------------------------------------------------------- |
| `Source.credentials`         | jsonb      | per-connector shape, never joined on                      |
| `Feed.config`                | jsonb      | per-connector feed settings; forward-looking, often `{}` in v1 |
| `Item.payload`               | jsonb      | cached `NormalizedItem`, read whole                       |
| `Summary.points`             | jsonb      | `SummaryPoint[]`, rendered whole                          |
| `InterestProfile.rawAnswers` | jsonb      | free-form questionnaire, read whole                       |
| `DigestSection`              | relational | queried/reordered/joined — a table, not a `sections` blob |
| `FeedTag.inferred`           | column     | boolean filtered on                                       |

#### Prompt layering

The summarizer stays domain-agnostic; the caller composes the system prompt in
one place by explicit layering, in order:

```
[base role from prompts.ts]
[InterestProfile.generatedPrompt]   # user interests
[Feed.customPrompt?]                # feed-specific override
[kind-specific instructions]        # news vs discussion vs …
```

The composed string is hashed into `Summary.rulesetHash` — the cache key for a
(feed, period) summary. Editing any layer changes the hash and invalidates only
the affected summaries. A feed's custom prompt is layered, not assigned an
abstract "priority": LLMs honor position and structure, not declared precedence.

The `kind`-specific layer is chosen from `Feed.kind` **passed by the caller** —
`selectRuleset(items, kind)` — not inferred from item contents. (Today
`selectRuleset(items)` reads `meta.isGroup`; it gains an explicit `kind`
parameter once feeds are DB-backed, keeping `NormalizedItem` connector-agnostic.)

**`generatedPrompt` regeneration contract.** `generatedPrompt` MUST be
regenerated whenever `rawAnswers` or any of the user's `UserTag` rows change.
The regenerate action writes `generatedPrompt`, bumps `promptVersion`, and sets
`generatedAt` atomically — so the layer-2 input never goes stale against the
raw answers it derives from.

#### Tags

Tags are a curated, seeded controlled vocabulary — the interest checkboxes. A
`slug` is deterministic (lowercase-with-dashes) with a UNIQUE constraint.
Checkbox selections write `UserTag`; the free-form textarea is stored in
`InterestProfile.rawAnswers` and never mints tags. Feed theme classification has
the LLM pick slug(s) from this same vocabulary, writing
`FeedTag(inferred=true, inferredAt)`, refreshed on a schedule by TTL on
`inferredAt` plus a manual "re-classify now" action. Theme tags boost relevant
prompt fragments rather than hard-gating the general prompt.

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
- **Tag canonicalization at scale**: the controlled vocabulary is the v1 answer
  for dedup (no "f1" vs "formula one" because users pick from a fixed list). If
  free-text tags are ever allowed, add LLM-mediated canonicalization (map a
  phrase onto existing tags, passing the current vocabulary as context) and,
  once the vocabulary outgrows a prompt (~200+ tags), embedding similarity
  search (e.g. `pgvector`) plus an admin "merge tags" tool. Defer until needed.
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
