# Morning Post — Architecture

## Overview

A tool that fetches content from multiple sources, normalizes it, and summarizes it based on configurable rules. Starts as a CLI utility, designed as an API from day one.

---

## Layers

### 1. Connectors

Each connector wraps a single external service (Telegram, RSS, Twitter, etc.) and is responsible for two things only: **fetching** and **normalizing**.

Every connector implements the same interface:

```ts
interface Connector {
  id: string           // e.g. "telegram", "rss"
  label: string
  fetch(params: FetchParams): Promise<NormalizedItem[]>
}

interface FetchParams {
  from: Date
  to: Date
  sourceId: string     // channel ID, feed URL, twitter handle, etc.
}

interface NormalizedItem {
  connectorId: string
  sourceId: string
  date: Date
  title: string | null
  text: string
  url: string | null
}
```

Connector config (API keys, URLs) is provided at instantiation time, not hardcoded.

### 2. Summarizer

Accepts an array of `NormalizedItem[]` and a **ruleset**, returns a summary.

```ts
interface SummaryRuleset {
  language?: string          // e.g. "English", "Ukrainian"
  focus?: string             // e.g. "tech news only", "ignore sports"
  format?: string            // e.g. "bullet points", "short paragraphs"
  maxLength?: number         // in tokens or chars
}

interface SummarizerService {
  summarize(items: NormalizedItem[], rules: SummaryRuleset): Promise<string>
}
```

The summarizer is also a swappable interface — different LLM backends can implement it.

### 3. Presenter *(planned)*

Takes the summarizer output and formats/delivers it — email, markdown file, Telegram message, etc. Not in scope yet.

---

## API Design

Even as a CLI tool, all logic goes through the same service interfaces so the API layer is just a thin wrapper later.

```
POST /run
  body: { connectors: ConnectorConfig[], rules: SummaryRuleset, from: Date, to: Date }
  returns: { summary: string, items: NormalizedItem[] }

GET /connectors
  returns: list of available connector types

POST /connectors/test
  body: ConnectorConfig
  returns: sample NormalizedItem[] or error
```

---

## Current Status

- [x] Telegram connector (fetch messages from subscribed channels by date range)
- [ ] Summarizer service
- [ ] API routes wired up
- [ ] RSS connector
- [ ] Presenter layer
