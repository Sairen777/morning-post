# Morning Post — Architecture

## Overview

A tool that fetches content from multiple sources, normalizes it, and summarizes
it based on configurable rules. Starts as a CLI utility, designed as an API from
day one.

Overall flow of data:

// TODO: need a new name for `normalizedData` that is result from adapter and
passed to OAISummarizer

`Connector.getRawData(): connectorRawData` ->
`Connector.getNormalizedData(connectorRawData): connectorNormalizedData` ->
`SummarizerAdapter(connectorNormalizedData): normalizedData` ->
`Summarizer(normalizedData): summarizerData`

---

## Layers

### 1. Connectors

Each connector wraps a single external service (Telegram, RSS, Twitter, etc.)
and is responsible for two things only: **fetching** and **normalizing**.

Every connector implements the same interface `IConnector` that can be found in
`src/connectors/connector.types.ts`

Connector file should have only one exported class that implements `IConnector`
interface.

Connector config (API keys, URLs) is provided at instantiation time via
ENV-variables.

`getRawData()` method of connector is responsible for fetching raw messages from
a given time period from service API. Duplicate calls of this method with the
same arguments during small time window (TODO: I need to specify it) will return
cached result.

`getNormalizedData()` transforms raw data to `INormalizedItem` type while also
downloading and properly linking attachments so they can be summarized by LLM
futher on. (TODO: maybe I need to move while attachment downloading logic to a
different service/class?)

### 2. Summarizer

Accepts an array of `NormalizedItem[]` (got it from `SummarizerAdapter`) and a
**ruleset** defined by user, returns a summary.

Every summarizer implements the same interface `ISummarizer` that can be found
in `src/summarizers/summarizer.types.ts`

The summarizer is also a swappable interface — different LLM backends can
implement it.

### 3. Presenter _(planned)_

Takes the summarizer output and formats/delivers it:

- builds HTML to deliver it via email
- builds markdown file to deliver via web service
- ...etc for RSS, some other view

---

## Things to Consider

- **Media dir concurrency**: the `media/` directory is shared and deleted after
  each run. When this becomes an API with concurrent `/run` requests, each
  request needs its own isolated temp dir (e.g. `media/<requestId>/`) and
  TTL-based cleanup instead of manual deletion at the end.
- **Vision model requirement**: multimodal summarization requires a
  vision-capable model. When switching to hosted APIs (OpenRouter, etc.),
  confirm the selected model supports image input.
