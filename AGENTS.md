# Plan & Act

When planning a feature implementation, always think about test cases. Write test cases in the plan, think about edge cases feature-wise and app-wise (new user, user with unorthodox settings, user with a different language/timezone, etc).

When implementing a feature, always write tests for the feature first. Try to write unit, e2e and integration tests for all the features. If a certain type of test does not exist in the project yet, notify user about it and add to the plan adding the support for it.

Never change existing test logic if they were passing before changes. If a test stopped passing, try to find case for it in the new code.

If during implementation you catched an unexpected behaviour that you had to fix, make sure to write tests for that behaviour.

# Code style

## Method size — single responsibility

Methods should follow a single responsibility principle. If a method does
different things, move logic into separate methods.

## Naming

- **No abbreviations.** Use the full word.
  - Bad: `Msg`, `msg`, `replyToMsgId`, `baseMsg`, `textMsg`
  - Good: `Message`, `message`, `replyToMessageId`, `baseMessage`,
    `messageWithText`
  - Single-letter callback params like `m => m.id` are fine — they're
    scope-local placeholders, not abbreviations.
- **No `I`-prefix on interfaces.** Plain PascalCase: `Connector`, not
  `IConnector`; `NormalizedItem`, not `INormalizedItem`.
- **Enum vs interface clash**: when an enum and an interface would share a name,
  suffix the enum. Example: `ConnectorId` enum + `Connector` interface.

## Types

- All public method boundaries use **epoch milliseconds** (`number`) for
  timestamps, not `Date`. Internal-only types can keep `Date` if convenient, but
  anything crossing a layer is `number`.
- Connector-specific fields go on a `meta: Record<string, unknown>` slot on
  `NormalizedItem`, not as top-level fields. Keeps the cross-layer item type
  connector-agnostic.

## Configuration

- Backend config (model name, base URL, API key, capability flags) reads from
  env vars with hardcoded fallbacks. Precedence: constructor arg → env var →
  default. Keeps call sites flexible and tests injectable.
- All system-prompt text lives in `src/summarizers/prompts.ts`. Don't inline
  prompts in the summarizer class or the orchestrator. Each prompt builder
  returns a full `SummaryRuleset` (prompt text + matching capability hints).

## Comments

- Default to no comments. Add one only when the _why_ is non-obvious: a hidden
  constraint, a subtle invariant, a workaround. Don't restate what the code does
  — well-named identifiers cover that.
- When a comment explains _why_ a guard exists (e.g. "defensive — shouldn't
  happen but the upstream API sometimes…"), keep it. When you'd otherwise write
  "TODO: do this later", either do it now or leave it with a clear scope and
  pointer (e.g. "belongs with the DB layer, see ROADMAP.md").

## Documentation

Keep up to date Technical Design Documentation in the `/docs` folder. Whanever you add new feature or change existig behaviour make sure to update the documentation.
