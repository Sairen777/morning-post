import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assert,
} from "@std/assert";
import { ConnectorId } from "../../src/constants.ts";
import type { ConnectorHandle } from "../../src/connectors/connector-factory.ts";
import type {
  ConnectorFactoryLike,
} from "../../src/connectors/connector-factory.ts";
import type { NormalizedItem } from "../../src/connectors/connector.types.ts";
import { CredentialCipher, type EncryptedBlob } from "../../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../src/crypto/key-provider.ts";
import type { Database } from "../../src/db/client.ts";
import { withTestDb } from "../../src/db/testing.ts";
import {
  parseEpochMs,
  safeSlug,
  parseDialogueSample,
  promptHash,
  renderSummaryForTerminal,
  parseHumanScore,
  collectHumanGrade,
  createDialogueEvalRecord,
  renderDialogueEvalMarkdownAppend,
  appendDialogueEvalRecord,
  captureDialogueSample,
  summarizeDialogueSample,
  type DialogueSample,
  type DialogueSummarizationResult,
  type HumanGrade,
  type DialogueEvalRecord,
  type DialogueEvalContext,
} from "../../src/evals/dialogue-eval.ts";
import { createOrReviveFeed } from "../../src/repositories/feed-repository.ts";
import { createSource, type PublicSource } from "../../src/repositories/source-repository.ts";
import { createUser, type CreateUserInput } from "../../src/repositories/user-repository.ts";
import { ConflictError } from "../../src/server/errors.ts";
import { composeSummaryRuleset } from "../../src/summarizers/compose-prompt.ts";
import { DEFAULT_SYSTEM_PROMPT } from "../../src/summarizers/prompts.ts";
import type {
  SummarizerService,
  SummaryPoint,
  SummaryRuleset,
  SummarizeOptions,
} from "../../src/summarizers/summarizer.types.ts";
import { parseCaptureDialogueArgs } from "../../scripts/evals/capture-dialogue.ts";
import { parseRunDialogueEvalArgs } from "../../scripts/evals/run-dialogue-eval.ts";

// ─── Helpers ───────────────────────────────────────────────────────────────

class FakeSummarizer implements SummarizerService {
  calls: Array<{ items: NormalizedItem[]; rules: SummaryRuleset; options?: SummarizeOptions }> = [];
  private results: SummaryPoint[][];

  constructor(results: SummaryPoint[][]) {
    this.results = [...results];
  }

  summarize(
    items: NormalizedItem[],
    rules: SummaryRuleset,
    options?: SummarizeOptions,
  ): Promise<SummaryPoint[]> {
    this.calls.push({ items, rules, options });
    return Promise.resolve(this.results.shift() ?? []);
  }
}

function userInput(email: string): CreateUserInput {
  return {
    name: "Test User",
    email,
    passwordHash: "$argon2id$fakehash",
    systemPrompt: "Focus on important changes.",
    defaultLanguage: "English",
    defaultModel: null,
  };
}

function userInputWithModel(email: string): CreateUserInput {
  return {
    name: "Test User",
    email,
    passwordHash: "$argon2id$fakehash",
    systemPrompt: "Focus on important changes.",
    defaultLanguage: "English",
    defaultModel: "custom-model",
  };
}

function credentialCipher(): CredentialCipher {
  return new CredentialCipher(
    new EnvMasterKeyProvider(new Uint8Array(32).fill(41)),
  );
}

async function encryptedCredentials(
  userId: string,
): Promise<EncryptedBlob> {
  return await credentialCipher().encrypt(
    JSON.stringify({ sessionString: "telegram-session" }),
    { userId, connectorId: ConnectorId.Telegram },
  );
}

function item(overrides: Partial<NormalizedItem> = {}): NormalizedItem {
  return {
    connectorId: ConnectorId.Telegram,
    feedExternalId: "test-feed-ext",
    externalId: "1",
    date: 1700000000000,
    title: null,
    text: "Test message content.",
    author: "author1",
    url: null,
    ...overrides,
  };
}

class FakeConnectorFactory implements ConnectorFactoryLike {
  forSourceCalls: Array<{ source: PublicSource; userId: string }> = [];
  private items: NormalizedItem[];
  private feedExternalId: string;
  disposeCalled = false;

  constructor(items: NormalizedItem[], feedExternalId: string) {
    this.items = items;
    this.feedExternalId = feedExternalId;
  }

  async forSource(
    source: PublicSource,
    userId: string,
  ): Promise<ConnectorHandle> {
    this.forSourceCalls.push({ source, userId });
    const self = this;
    return {
      connector: {
        getNormalizedData: async (
          _from: number,
          _to: number,
          feedExternalIds?: string[],
        ) => {
          return { [self.feedExternalId]: self.items };
        },
      } as ConnectorHandle["connector"],
      dispose: async () => {
        self.disposeCalled = true;
      },
    };
  }
}

// ─── Setup helpers ──────────────────────────────────────────────────────────

async function createDiscussionFeed(
  database: Database,
  email: string,
  customPrompt: string | null = "Prefer company strategy.",
  useModelInput = false,
) {
  const input = useModelInput ? userInputWithModel(email) : userInput(email);
  const user = await createUser(database, input);
  const source = await createSource(database, {
    userId: user.id,
    connectorId: ConnectorId.Telegram,
    credentials: await encryptedCredentials(user.id),
  });
  const feed = await createOrReviveFeed(database, {
    userId: user.id,
    sourceId: source.id,
    externalId: "discussion:1",
    name: "Discussion Chat",
    kind: "discussion",
    customPrompt,
  });
  return { user, source, feed };
}

const periodFromMs = 1_700_000_000_000;
const periodToMs = 1_700_086_400_000;

// ═══════════════════════════════════════════════════════════════════════════
// Test 1: parseEpochMs
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("parseEpochMs accepts epoch-ms strings and ISO strings, rejects invalid input", async () => {
  // epoch-ms
  assertEquals(parseEpochMs("1700000000000"), 1700000000000);
  assertEquals(parseEpochMs("0"), 0);

  // ISO strings
  assertEquals(parseEpochMs("2024-01-01T00:00:00.000Z"), Date.parse("2024-01-01T00:00:00.000Z"));
  assertEquals(parseEpochMs("2024-01-01"), Date.parse("2024-01-01"));

  // rejects invalid
  await assertRejects(
    async () => parseEpochMs("not a date"),
    Error,
    "invalid time",
  );
  await assertRejects(
    async () => parseEpochMs(""),
    Error,
    "invalid time",
  );
  await assertRejects(
    async () => parseEpochMs("abc123"),
    Error,
    "invalid time",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 2: safeSlug
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("safeSlug converts spaces/punctuation to -, rejects all-punctuation string", async () => {
  assertEquals(safeSlug("Hello World"), "Hello-World");
  assertEquals(safeSlug("foo@bar.com"), "foo-bar-com");
  assertEquals(safeSlug("a_b-c"), "a_b-c");
  assertEquals(safeSlug("  leading-and-trailing  "), "leading-and-trailing");
  assertEquals(safeSlug("UPPER.lower123"), "UPPER-lower123");

  // rejects all-punctuation
  await assertRejects(
    async () => safeSlug("!@#$%"),
    Error,
    "slug is empty",
  );
  await assertRejects(
    async () => safeSlug("---"),
    Error,
    "slug is empty",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 3: parseDialogueSample
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("parseDialogueSample accepts valid sample, rejects kind:other and feed.kind:news", async () => {
  const valid: DialogueSample = {
    schemaVersion: 1,
    kind: "dialogue-sample",
    capturedAt: 1700000000000,
    period: { fromMs: 1700000000000, toMs: 1700086400000 },
    user: { id: "user-1" },
    source: { id: "src-1", connectorId: "Telegram" },
    feed: {
      id: "feed-1",
      sourceId: "src-1",
      externalId: "ext-1",
      name: "Test Discussion",
      kind: "discussion",
    },
    itemCount: 0,
    items: [],
  };

  const result = parseDialogueSample(valid);
  assertEquals(result.kind, "dialogue-sample");
  assertEquals(result.feed.kind, "discussion");
  assertEquals(result.itemCount, 0);

  // rejects kind: "other"
  await assertRejects(
    async () => parseDialogueSample({ ...valid, kind: "other" }),
    Error,
  );

  // rejects feed.kind: "news"
  await assertRejects(
    async () =>
      parseDialogueSample({
        ...valid,
        feed: { ...valid.feed, kind: "news" },
      }),
    Error,
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 4: captureDialogueSample with fake ConnectorFactoryLike + test DB
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("captureDialogueSample calls getNormalizedData with correct params, returns exact items, sets itemCount, includes user.id, calls dispose", async () => {
  await withTestDb(async (database) => {
    const { user, source, feed } = await createDiscussionFeed(
      database,
      "capture@test.com",
    );

    const testItems = [
      item({ externalId: "msg-1", text: "Hello" }),
      item({ externalId: "msg-2", text: "World" }),
    ];

    const factory = new FakeConnectorFactory(testItems, feed.externalId);

    const sample = await captureDialogueSample({
      database,
      userId: user.id,
      sourceId: source.id,
      feedId: feed.id,
      fromMs: periodFromMs,
      toMs: periodToMs,
      connectorFactory: factory,
    });

    // Assert factory was called
    assertEquals(factory.forSourceCalls.length, 1);
    assertEquals(factory.forSourceCalls[0].source.id, source.id);
    assertEquals(factory.forSourceCalls[0].userId, user.id);

    // Assert dispose was called
    assertEquals(factory.disposeCalled, true);

    // Assert exact items
    assertEquals(sample.items.length, 2);
    assertEquals(sample.items[0].externalId, "msg-1");
    assertEquals(sample.items[1].externalId, "msg-2");

    // Assert itemCount
    assertEquals(sample.itemCount, 2);

    // Assert user.id
    assertEquals(sample.user.id, user.id);

    // Assert period
    assertEquals(sample.period.fromMs, periodFromMs);
    assertEquals(sample.period.toMs, periodToMs);

    // Assert feed metadata
    assertEquals(sample.feed.id, feed.id);
    assertEquals(sample.feed.kind, "discussion");
    assertEquals(sample.feed.name, feed.name);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 5: captureDialogueSample rejects news feed
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("captureDialogueSample rejects news feed with ConflictError 'feed must be a discussion'", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, userInput("newsfeed@test.com"));
    const source = await createSource(database, {
      userId: user.id,
      connectorId: ConnectorId.Telegram,
      credentials: await encryptedCredentials(user.id),
    });
    const newsFeed = await createOrReviveFeed(database, {
      userId: user.id,
      sourceId: source.id,
      externalId: "news:1",
      name: "News Channel",
      kind: "news",
    });

    await assertRejects(
      () =>
        captureDialogueSample({
          database,
          userId: user.id,
          sourceId: source.id,
          feedId: newsFeed.id,
          fromMs: periodFromMs,
          toMs: periodToMs,
        }),
      ConflictError,
      "feed must be a discussion",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 6: summarizeDialogueSample composes all prompt layers
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("summarizeDialogueSample systemPrompt contains DEFAULT_SYSTEM_PROMPT, user.systemPrompt, feed.customPrompt, and discussion prompt text", async () => {
  await withTestDb(async (database) => {
    const { user, source, feed } = await createDiscussionFeed(
      database,
      "prompt-layers@test.com",
      "Emphasize security issues.",
    );

    const testItems = [
      item({ externalId: "msg-1", text: "Security breach reported" }),
    ];

    const fakeSummarizer = new FakeSummarizer([
      [{ text: "Security breach discussed", sourceUrl: null }],
    ]);

    const sample: DialogueSample = {
      schemaVersion: 1,
      kind: "dialogue-sample",
      capturedAt: Date.now(),
      period: { fromMs: periodFromMs, toMs: periodToMs },
      user: { id: user.id },
      source: { id: source.id, connectorId: source.connectorId },
      feed: {
        id: feed.id,
        sourceId: feed.sourceId,
        externalId: feed.externalId,
        name: feed.name,
        kind: "discussion",
      },
      itemCount: testItems.length,
      items: testItems,
    };

    const result = await summarizeDialogueSample({
      database,
      sample,
      summarizer: fakeSummarizer,
    });

    const prompt = result.context.rules.systemPrompt;

    // DEFAULT_SYSTEM_PROMPT should be present
    assertStringIncludes(prompt, "daily-digest summarizer");

    // user.systemPrompt should be present
    assertStringIncludes(prompt, "Focus on important changes");

    // feed.customPrompt should be present
    assertStringIncludes(prompt, "Emphasize security issues");

    // discussion prompt text should be present
    assertStringIncludes(prompt, "discussion summarizer");
    assertStringIncludes(prompt, "main topics discussed");

    // summarizer was called
    assertEquals(fakeSummarizer.calls.length, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 7: summarizeDialogueSample model handling
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("summarizeDialogueSample passes { model: user.defaultModel } to summarizer and records context.model", async () => {
  await withTestDb(async (database) => {
    const { user, source, feed } = await createDiscussionFeed(
      database,
      "model-test@test.com",
      null,
      true,
    );

    const testItems = [item({ externalId: "msg-1" })];

    const fakeSummarizer = new FakeSummarizer([
      [{ text: "Summary point", sourceUrl: null }],
    ]);

    const sample: DialogueSample = {
      schemaVersion: 1,
      kind: "dialogue-sample",
      capturedAt: Date.now(),
      period: { fromMs: periodFromMs, toMs: periodToMs },
      user: { id: user.id },
      source: { id: source.id, connectorId: source.connectorId },
      feed: {
        id: feed.id,
        sourceId: feed.sourceId,
        externalId: feed.externalId,
        name: feed.name,
        kind: "discussion",
      },
      itemCount: testItems.length,
      items: testItems,
    };

    const result = await summarizeDialogueSample({
      database,
      sample,
      summarizer: fakeSummarizer,
    });

    // context.model should be the user's defaultModel
    assertEquals(result.context.model, "custom-model");

    // summarizer was called with { model: user.defaultModel }
    assertEquals(fakeSummarizer.calls.length, 1);
    assertEquals(fakeSummarizer.calls[0].options?.model, "custom-model");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 8: summarizeDialogueSample empty items
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("summarizeDialogueSample returns points:[] and does not call summarizer when items empty", async () => {
  await withTestDb(async (database) => {
    const { user, source, feed } = await createDiscussionFeed(
      database,
      "empty@test.com",
    );

    const fakeSummarizer = new FakeSummarizer([]);

    const sample: DialogueSample = {
      schemaVersion: 1,
      kind: "dialogue-sample",
      capturedAt: Date.now(),
      period: { fromMs: periodFromMs, toMs: periodToMs },
      user: { id: user.id },
      source: { id: source.id, connectorId: source.connectorId },
      feed: {
        id: feed.id,
        sourceId: feed.sourceId,
        externalId: feed.externalId,
        name: feed.name,
        kind: "discussion",
      },
      itemCount: 0,
      items: [],
    };

    const result = await summarizeDialogueSample({
      database,
      sample,
      summarizer: fakeSummarizer,
    });

    // should return empty points
    assertEquals(result.points.length, 0);

    // should not call summarizer
    assertEquals(fakeSummarizer.calls.length, 0);

    // context should still be populated
    assertEquals(result.context.user.id, user.id);
    assertEquals(result.context.feed.id, feed.id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 9: renderSummaryForTerminal
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("renderSummaryForTerminal includes model, feed name, prompt SHA-256, and numbered points", async () => {
  const context: DialogueEvalContext = {
    user: {
      id: "u1",
      name: "Tester",
      email: "t@t.com",
      passwordHash: "h",
      systemPrompt: "sp",
      defaultLanguage: "en",
      defaultModel: null,
      createdAt: 1,
      updatedAt: 1,
    },
    feed: {
      id: "f1",
      sourceId: "s1",
      externalId: "ext1",
      name: "My Discussion Feed",
      kind: "discussion",
      customPrompt: null,
      position: null,
      enabled: true,
      deletedAt: null,
      lastFetchedPeriodEndMs: null,
      createdAt: 1,
      updatedAt: 1,
    },
    rules: { systemPrompt: "test prompt" },
    model: "gpt-4o-mini",
    systemPromptHash: await promptHash("test prompt"),
  };

  const result: DialogueSummarizationResult = {
    context,
    points: [
      { text: "Topic A discussed", sourceUrl: null },
      { text: "Decision B made", sourceUrl: null },
    ],
  };

  const output = renderSummaryForTerminal(result);
  assertStringIncludes(output, "Model: gpt-4o-mini");
  assertStringIncludes(output, "Feed: My Discussion Feed");
  assertStringIncludes(output, "Prompt SHA-256:");
  assertStringIncludes(output, "1. Topic A discussed");
  assertStringIncludes(output, "2. Decision B made");

  // Test zero points case
  const emptyResult: DialogueSummarizationResult = {
    context,
    points: [],
  };
  const emptyOutput = renderSummaryForTerminal(emptyResult);
  assertStringIncludes(emptyOutput, "(no summary points)");
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 10: parseHumanScore
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("parseHumanScore accepts 1 and 10; rejects 0, 11, 8.5, and non-numeric", async () => {
  // valid scores
  assertEquals(parseHumanScore("1"), 1);
  assertEquals(parseHumanScore("10"), 10);
  assertEquals(parseHumanScore("5"), 5);

  // rejects 0
  await assertRejects(
    async () => parseHumanScore("0"),
    Error,
    "score must be an integer from 1 to 10",
  );

  // rejects 11
  await assertRejects(
    async () => parseHumanScore("11"),
    Error,
    "score must be an integer from 1 to 10",
  );

  // rejects 8.5
  await assertRejects(
    async () => parseHumanScore("8.5"),
    Error,
    "score must be an integer from 1 to 10",
  );

  // rejects non-numeric
  await assertRejects(
    async () => parseHumanScore("abc"),
    Error,
    "score must be an integer from 1 to 10",
  );

  // rejects empty
  await assertRejects(
    async () => parseHumanScore(""),
    Error,
    "score must be an integer from 1 to 10",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 11: collectHumanGrade
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("collectHumanGrade retries invalid score, captures valid score, captures comment, throws 'evaluation cancelled' on null", async () => {
  // success case: valid score and comment
  {
    const inputs = ["5", "Great summary"];
    let callIndex = 0;
    const readLine = (message: string): string | null => {
      if (callIndex >= inputs.length) return null;
      return inputs[callIndex++];
    };

    const grade = collectHumanGrade(readLine);
    assertEquals(grade.score, 5);
    assertEquals(grade.comment, "Great summary");
  }

  // retry case: invalid then valid
  {
    const inputs = ["invalid", "0", "11", "7", "ok"];
    let callIndex = 0;
    const readLine = (message: string): string | null => {
      if (callIndex >= inputs.length) return null;
      return inputs[callIndex++];
    };

    const grade = collectHumanGrade(readLine);
    assertEquals(grade.score, 7);
    assertEquals(grade.comment, "ok");
  }

  // empty comment is allowed
  {
    const inputs = ["9", ""];
    let callIndex = 0;
    const readLine = (message: string): string | null => {
      if (callIndex >= inputs.length) return null;
      return inputs[callIndex++];
    };

    const grade = collectHumanGrade(readLine);
    assertEquals(grade.score, 9);
    assertEquals(grade.comment, "");
  }

  // throws on null score
  {
    const inputs: (string | null)[] = [null];
    let callIndex = 0;
    const readLine = (_message: string): string | null => {
      return inputs[callIndex++];
    };

    await assertRejects(
      async () => collectHumanGrade(readLine),
      Error,
      "evaluation cancelled",
    );
  }

  // throws on null comment
  {
    const inputs: (string | null)[] = ["3", null];
    let callIndex = 0;
    const readLine = (_message: string): string | null => {
      return inputs[callIndex++];
    };

    await assertRejects(
      async () => collectHumanGrade(readLine),
      Error,
      "evaluation cancelled",
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 12: renderDialogueEvalMarkdownAppend + appendDialogueEvalRecord
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("renderDialogueEvalMarkdownAppend and appendDialogueEvalRecord create header, append table row, include full prompt, summary output, escape pipe/newline in comment", async () => {
  const sample: DialogueSample = {
    schemaVersion: 1,
    kind: "dialogue-sample",
    capturedAt: 1700000000000,
    period: { fromMs: 1700000000000, toMs: 1700086400000 },
    user: { id: "user-1" },
    source: { id: "src-1", connectorId: "Telegram" },
    feed: {
      id: "feed-1",
      sourceId: "src-1",
      externalId: "ext-1",
      name: "Test Discussion",
      kind: "discussion",
    },
    itemCount: 2,
    items: [item(), item()],
  };

  const context: DialogueEvalContext = {
    user: {
      id: "u1",
      name: "Tester",
      email: "t@t.com",
      passwordHash: "h",
      systemPrompt: "sp",
      defaultLanguage: "en",
      defaultModel: null,
      createdAt: 1,
      updatedAt: 1,
    },
    feed: {
      id: "f1",
      sourceId: "s1",
      externalId: "ext1",
      name: "Test Discussion",
      kind: "discussion",
      customPrompt: null,
      position: null,
      enabled: true,
      deletedAt: null,
      lastFetchedPeriodEndMs: null,
      createdAt: 1,
      updatedAt: 1,
    },
    rules: { systemPrompt: "You are a test prompt\nwith multiple lines" },
    model: "gpt-4o-mini",
    systemPromptHash: await promptHash("You are a test prompt\nwith multiple lines"),
  };

  const result: DialogueSummarizationResult = {
    context,
    points: [
      { text: "Point one", sourceUrl: null },
      { text: "Point two", sourceUrl: null },
    ],
  };

  const grade: HumanGrade = {
    score: 8,
    comment: "Good but | could be better\nwith newlines",
  };

  // Test renderDialogueEvalMarkdownAppend directly
  const now = 1700100000000;
  const record = await createDialogueEvalRecord({ sample, result, grade, now: () => now });
  const markdown = renderDialogueEvalMarkdownAppend(record);

  // Table row includes key fields
  assertStringIncludes(markdown, "Test Discussion");
  assertStringIncludes(markdown, "gpt-4o-mini");
  assertStringIncludes(markdown, "sha256:");
  assertStringIncludes(markdown, "| 8 |");

  // Comment escapes pipe
  assert(markdown.includes("\\|"), "pipe should be escaped in table cell");
  assertStringIncludes(markdown, "\\n");

  // Full prompt is in fenced block
  assertStringIncludes(markdown, "You are a test prompt");
  assertStringIncludes(markdown, "with multiple lines");
  assertStringIncludes(markdown, "```text");

  // Summary output
  assertStringIncludes(markdown, "Point one");
  assertStringIncludes(markdown, "Point two");

  // Full system prompt hash in details
  assertStringIncludes(markdown, `id="prompt-${context.systemPromptHash}"`);

  // Test appendDialogueEvalRecord end to end
  const tmpDir = await Deno.makeTempDir({ prefix: "dialogue-eval-test-" });
  try {
    const resultsPath = `${tmpDir}/evaluations.md`;

    await appendDialogueEvalRecord(resultsPath, record);

    const fileContent = await Deno.readTextFile(resultsPath);

    // Should contain the header
    assertStringIncludes(fileContent, "# Dialogue summarization evals");
    assertStringIncludes(fileContent, "| Date | Feed | Period | Used model | Used system prompt | Score | Comment |");

    // Should contain our record
    assertStringIncludes(fileContent, "Test Discussion");
    assertStringIncludes(fileContent, "sha256:");

    // Append a second record — should be appended, not overwritten
    const record2 = await createDialogueEvalRecord({
      sample,
      result,
      grade: { score: 9, comment: "Second eval" },
      now: () => now + 1000,
    });
    await appendDialogueEvalRecord(resultsPath, record2);

    const updatedContent = await Deno.readTextFile(resultsPath);

    // Header row + separator + 2 data rows = 4 pipe-delimited lines
    const tableLines = updatedContent
      .split("\n")
      .filter((l) => l.startsWith("|"));
    // header, separator, two data rows
    assertEquals(tableLines.length, 4);

    assertStringIncludes(updatedContent, "| 9 |");
    assertStringIncludes(updatedContent, "Second eval");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 13: parseCaptureDialogueArgs accepts all required flags
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("parseCaptureDialogueArgs accepts all required flags, parses ISO/epoch, slug-normalizes, sets force only when --force present", () => {
  // all required flags with ISO times
  const args1 = parseCaptureDialogueArgs([
    "--user-id", "user-uuid",
    "--source-id", "source-uuid",
    "--feed-id", "feed-uuid",
    "--from", "2024-01-01T00:00:00.000Z",
    "--to", "2024-01-02T00:00:00.000Z",
    "--slug", "My Test Slug",
  ]);
  assertEquals(args1.userId, "user-uuid");
  assertEquals(args1.sourceId, "source-uuid");
  assertEquals(args1.feedId, "feed-uuid");
  assertEquals(args1.fromMs, Date.parse("2024-01-01T00:00:00.000Z"));
  assertEquals(args1.toMs, Date.parse("2024-01-02T00:00:00.000Z"));
  assertEquals(args1.slug, "My-Test-Slug");
  assertEquals(args1.force, false);

  const argsWithTaskSeparator = parseCaptureDialogueArgs([
    "--",
    "--user-id", "user-uuid",
    "--source-id", "source-uuid",
    "--feed-id", "feed-uuid",
    "--from", "2024-01-01T00:00:00.000Z",
    "--to", "2024-01-02T00:00:00.000Z",
    "--slug", "separator-slug",
  ]);
  assertEquals(argsWithTaskSeparator.slug, "separator-slug");

  // with --force
  const args2 = parseCaptureDialogueArgs([
    "--user-id", "user-uuid",
    "--source-id", "source-uuid",
    "--feed-id", "feed-uuid",
    "--from", "1700000000000",
    "--to", "1700086400000",
    "--slug", "epoch-slug",
    "--force",
  ]);
  assertEquals(args2.force, true);
  assertEquals(args2.fromMs, 1700000000000);
  assertEquals(args2.toMs, 1700086400000);
  assertEquals(args2.slug, "epoch-slug");

  // slug normalization: special chars
  const args3 = parseCaptureDialogueArgs([
    "--user-id", "u",
    "--source-id", "s",
    "--feed-id", "f",
    "--from", "2024-01-01",
    "--to", "2024-01-01",
    "--slug", "foo@bar!baz#qux",
  ]);
  assertEquals(args3.slug, "foo-bar-baz-qux");
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 14: parseCaptureDialogueArgs rejects missing required and unknown flags
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("parseCaptureDialogueArgs rejects missing required flags and unknown flags", async () => {
  // missing required flag
  await assertRejects(
    async () =>
      parseCaptureDialogueArgs([
        "--source-id", "s",
        "--feed-id", "f",
        "--from", "2024-01-01",
        "--to", "2024-01-01",
        "--slug", "test",
      ]),
    Error,
    "missing required option: --user-id",
  );

  // unknown flag
  await assertRejects(
    async () =>
      parseCaptureDialogueArgs([
        "--user-id", "u",
        "--source-id", "s",
        "--feed-id", "f",
        "--from", "2024-01-01",
        "--to", "2024-01-01",
        "--slug", "test",
        "--unknown-flag",
      ]),
    Error,
    "unknown option: --unknown-flag",
  );

  // non-flag arg
  await assertRejects(
    async () => parseCaptureDialogueArgs(["positional-arg"]),
    Error,
    "unknown option: positional-arg",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 15: parseRunDialogueEvalArgs
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("parseRunDialogueEvalArgs requires --sample, returns default resultsPath, returns null userId/feedId when omitted, accepts overrides, rejects unknown flags", async () => {
  // minimum: only --sample
  const args1 = parseRunDialogueEvalArgs(["--sample", "path/to/sample.json"]);
  assertEquals(args1.samplePath, "path/to/sample.json");
  assertEquals(args1.userId, null);
  assertEquals(args1.feedId, null);
  assertEquals(args1.resultsPath, "eval-results/dialogues/evaluations.md");

  const argsWithTaskSeparator = parseRunDialogueEvalArgs(["--", "--sample", "path/to/sample.json"]);
  assertEquals(argsWithTaskSeparator.samplePath, "path/to/sample.json");
  assertEquals(argsWithTaskSeparator.userId, null);
  assertEquals(argsWithTaskSeparator.feedId, null);

  // with optional overrides
  const args2 = parseRunDialogueEvalArgs([
    "--sample", "sample.json",
    "--user-id", "user-1",
    "--feed-id", "feed-1",
    "--results", "custom/results.md",
  ]);
  assertEquals(args2.samplePath, "sample.json");
  assertEquals(args2.userId, "user-1");
  assertEquals(args2.feedId, "feed-1");
  assertEquals(args2.resultsPath, "custom/results.md");

  // missing --sample
  await assertRejects(
    async () => parseRunDialogueEvalArgs(["--user-id", "u1"]),
    Error,
    "missing required option: --sample",
  );

  // unknown flag
  await assertRejects(
    async () =>
      parseRunDialogueEvalArgs(["--sample", "s.json", "--unknown", "val"]),
    Error,
    "unknown option: --unknown",
  );

  // non-flag arg
  await assertRejects(
    async () => parseRunDialogueEvalArgs(["positional"]),
    Error,
    "unknown option: positional",
  );
});
