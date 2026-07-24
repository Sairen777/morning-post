## Configuration

- Backend config (model name, base URL, API key, capability flags) reads from env vars with hardcoded fallbacks. Precedence: constructor arg → env var → default. Keeps call sites flexible and tests injectable.
- All system-prompt text lives in `src/summarizers/prompts.ts`. Don't inline prompts in the summarizer class or the orchestrator. Each prompt builder returns a full `SummaryRuleset` (prompt text + matching capability hints).

## Documentation

Keep up to date Technical Design Documentation in the `/docs` folder. Whanever you add new feature or change existig behaviour make sure to update the documentation.
