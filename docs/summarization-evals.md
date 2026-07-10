# Summarization eval workflow

This repo has a local, human-graded eval loop for dialogue/discussion summarization.

## Local artifacts

The workflow writes local-only files that are ignored by git:

- `eval-data/` — captured Telegram dialogue samples.
- `eval-results/` — generated summaries, prompt snapshots, model names, scores, and comments.

Do not commit either directory.

## Capture a dialogue sample

Capture stores one fixed Telegram discussion feed and period as JSON:

```bash
deno task eval:capture-dialogue -- \
  --user-id <user-id> \
  --source-id <telegram-source-id> \
  --feed-id <discussion-feed-id> \
  --from 2026-06-01T00:00:00Z \
  --to 2026-06-02T00:00:00Z \
  --slug smoke-dialogue \
  --force
```

The command uses the stored source credentials through `ConnectorFactory.forSource(...)`; it does not instantiate Telegram clients directly and does not write fetched items to the database.

The capture command is intentionally discussion-only. It rejects non-discussion feeds with `feed must be a discussion` because the eval target is dialogue summarization.

## Run an interactive eval

Run the current production summarization path against a captured sample:

```bash
deno task eval -- --sample eval-data/dialogues/smoke-dialogue.json
```

The command prints the generated summary, prompts for a human score from 1 to 10, asks for one comment, and appends a Markdown record to `eval-results/dialogues/evaluations.md` by default.

Optional overrides:

```bash
deno task eval -- \
  --sample eval-data/dialogues/smoke-dialogue.json \
  --user-id <user-id> \
  --feed-id <discussion-feed-id> \
  --results eval-results/dialogues/evaluations.md
```

## Production prompt/model path

The eval intentionally measures the same production path used by feed summarization:

1. Load the user and feed from the database.
2. Compose rules with `composeSummaryRuleset({ kind, systemPrompt, customPrompt, language })`.
3. Use the user system prompt, feed custom prompt, discussion prompt, and user default language.
4. Resolve the recorded model with `resolveOpenAICompatibleSummarizerModel(user.defaultModel)`.
5. Summarize with `OpenAICompatibleSummarizerService` unless a test injects a fake summarizer.

No eval command exposes prompt, model, method, or variant flags. Compare prompt/model experiments by changing the same production configuration the app uses, then appending another human-graded run.

## Stored eval record

Each appended Markdown record includes:

- capture period and feed metadata,
- model name used for the run,
- SHA-256 hash of the exact full system prompt,
- the full system prompt in a fenced details block,
- generated summary output,
- human score and comment.

The prompt hash keeps the table readable while preserving the exact prompt text below the row for comparisons across prompt/model changes.
