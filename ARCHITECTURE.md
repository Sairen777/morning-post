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
use `Date` where convenient, but anything crossing a layer is `number`.
Readable date formatting happens at the presentation layer.

---

## Layers

### 1. Connectors

Each connector wraps a single external service (Telegram, RSS, Twitter, etc.)
and is responsible for two things only: **fetching** and **normalizing**.

Every connector implements the `Connector<TRawData>` interface in
`src/connectors/connector.types.ts`. Connector files have exactly one exported
class implementing that interface. Connector config (API keys, URLs) is
provided at instantiation time via env vars.

`getRawData(from, to)` fetches raw messages within the time window from the
service API. Caching for repeat calls in a short window is a DB-layer concern
(see `ROADMAP.md`).

**`getRawData` stays on the interface deliberately.** No external caller uses
it today — only the connector's own `getNormalizedData` consumes it. It
remains public as a structural contract: every connector must separate
fetching from normalization. Removing it would let a future connector tangle
I/O with shape conversion. The redundancy is intentional.

`getNormalizedData(from, to)` transforms raw data into
`Record<sourceId, NormalizedItem[]>`, downloading and linking attachments along
the way. Each `NormalizedItem` carries:

- `connectorId: ConnectorId` (enum, e.g. `ConnectorId.Telegram`)
- `sourceId: string` (matches the map key)
- `date: number` (epoch ms)
- `title`, `text`, `author`, `url`
- optional `media: Media`
- optional `meta: Record<string, unknown>` for connector-specific fields

**Connector-specific data goes in `meta`, not as top-level fields.** Telegram
puts `{ isGroup }` there; other connectors add what they need. Keeps the
cross-layer type connector-agnostic.

### 2. Summarizer

Accepts `NormalizedItem[]` and a `SummaryRuleset`
(`{ systemPrompt, showAuthors?, includeMedia? }`), returns `SummaryPoint[]`.
Has **no domain knowledge** of where items came from — the prompt and shape
hints are fully caller-controlled.

Implements the `SummarizerService` interface in
`src/summarizers/summarizer.types.ts`.

#### Prompts

All system prompts live in `src/summarizers/prompts.ts`. Each builder
(`buildNewsPrompt`, `buildDiscussionPrompt`, …) returns a full
`SummaryRuleset` — prompt text plus matching `showAuthors`/`includeMedia`
defaults. New summarization "modes" go here, not inside the summarizer service
and not inlined in the orchestrator.

#### Backends

Current implementation: `OpenAICompatibleSummarizerService`. Default backend is
**Gemini 2.5 Flash-Lite** (vision-capable). Set `LOCAL_API=true` (or `=1`) to
flip defaults to a local LM Studio / Ollama-style server — useful for offline
dev and for summarizing content that shouldn't leave the machine.

Env vars (consumed at construction time, with hardcoded fallbacks):

| Env                   | Purpose                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LOCAL_API`           | `true`/`1` to use local backend defaults                                                                                                         |
| `SUMMARIZER_MODEL`    | overrides the model name                                                                                                                         |
| `SUMMARIZER_BASE_URL` | overrides the OpenAI-compatible endpoint **root** (the directory containing `chat/completions`, e.g. `https://api.deepseek.com/v1`)              |
| `GEMINI_API_KEY`      | bearer token for the hosted backend                                                                                                              |

Precedence: explicit constructor arg → env var → hardcoded default. Tests rely
on the constructor-arg path to inject mock values.

### 3. Presenter _(planned)_

Takes the summarizer output and formats/delivers it:

- builds HTML to deliver via email
- builds markdown file to deliver via web service
- …etc for RSS or other views

Readable date formatting happens here.

---

## Things to Consider

- **Media dir concurrency**: the `media/` directory is shared. When this
  becomes an API with concurrent `/run` requests, each request needs its own
  isolated temp dir (e.g. `media/<requestId>/`) and TTL-based cleanup instead
  of single-shot deletion.
- **Caching**: per-window `getRawData` caching + persistence belongs with the
  DB layer in `ROADMAP.md`. Memory-only caching is a footgun under concurrent
  API requests.
- **Vision model requirement**: multimodal summarization requires a
  vision-capable model. If swapping to a text-only backend (e.g.
  `deepseek-chat`), either flip `includeMedia: false` in the relevant prompt
  builders or have the summarizer strip media before dispatch.
