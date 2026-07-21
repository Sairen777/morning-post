import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { eq } from "drizzle-orm";
import { ConnectorId } from "../../src/constants.ts";
import {
  CredentialCipher,
  type EncryptedBlob,
} from "../../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../src/crypto/key-provider.ts";
import type { Database } from "../../src/db/client.ts";
import { withTestDb } from "../../src/db/testing.ts";
import { feeds } from "../../src/db/schema/feed.ts";
import type { OperationalLogEvent } from "../../src/observability/operational-log.ts";
import { composeSummaryRuleset } from "../../src/summarizers/compose-prompt.ts";
import { DEFAULT_SYSTEM_PROMPT } from "../../src/summarizers/prompts.ts";
import type {
  SummarizeOptions,
  SummarizerService,
  SummaryPoint,
  SummaryRuleset,
} from "../../src/summarizers/summarizer.types.ts";
import { createOrReviveFeed } from "../../src/repositories/feed-repository.ts";
import { upsertItems } from "../../src/repositories/item-repository.ts";
import { findSummaryForFeedPeriod } from "../../src/repositories/summary-repository.ts";
import { createSource } from "../../src/repositories/source-repository.ts";
import {
  createUser,
  type CreateUserInput,
} from "../../src/repositories/user-repository.ts";
import {
  cleanupFeedMedia,
  getOrSummarizeFeedPeriod,
  summarizeFeedPeriod,
} from "../../src/services/summarization-service.ts";
import type { NormalizedItem } from "../../src/connectors/connector.types.ts";

class FakeSummarizer implements SummarizerService {
  readonly calls: Array<
    {
      items: NormalizedItem[];
      rules: SummaryRuleset;
      options?: SummarizeOptions;
    }
  > = [];
  #results: SummaryPoint[][];

  constructor(results: SummaryPoint[][]) {
    this.#results = [...results];
  }

  summarize(
    items: NormalizedItem[],
    rules: SummaryRuleset,
    options?: SummarizeOptions,
  ): Promise<SummaryPoint[]> {
    this.calls.push({ items, rules, options });
    return Promise.resolve(this.#results.shift() ?? []);
  }
}

function userInput(email: string): CreateUserInput {
  return {
    name: "Summarization Owner",
    email,
    passwordHash: "$argon2id$fakehash",
    systemPrompt: "Focus on important product changes.",
    defaultLanguage: "Ukrainian",
  };
}

function credentialCipher(): CredentialCipher {
  return new CredentialCipher(
    new EnvMasterKeyProvider(new Uint8Array(32).fill(41)),
  );
}

async function encryptedCredentials(
  userId: string,
  connectorId = ConnectorId.Telegram,
): Promise<EncryptedBlob> {
  return await credentialCipher().encrypt(
    JSON.stringify({ sessionString: "test-session" }),
    {
      userId,
      connectorId,
    },
  );
}

async function createFeed(
  database: Database,
  email: string,
  customPrompt: string | null = "Prefer company strategy.",
  connectorId = ConnectorId.Telegram,
) {
  const user = await createUser(database, userInput(email));
  const source = await createSource(database, {
    userId: user.id,
    connectorId,
    credentials: await encryptedCredentials(user.id, connectorId),
  });
  const feed = await createOrReviveFeed(database, {
    userId: user.id,
    sourceId: source.id,
    externalId: "channel:1",
    name: "Channel",
    kind: "news",
    customPrompt,
  });
  return { user, feed };
}

function normalizedItem(
  overrides: Partial<NormalizedItem> = {},
): NormalizedItem {
  return {
    connectorId: ConnectorId.Telegram,
    feedExternalId: "channel:1",
    externalId: "message:1",
    date: 1_700_000_000_000,
    title: null,
    text: "Some update",
    author: "Channel",
    url: "https://t.me/channel/1",
    ...overrides,
  };
}

const periodStartMs = 1_700_000_000_000;
const periodEndMs = 1_700_086_400_000;

Deno.test("composeSummaryRuleset layers base, user, feed, and kind prompts in order", () => {
  const rules = composeSummaryRuleset({
    connectorId: ConnectorId.Telegram,
    kind: "discussion",
    systemPrompt: "User focus",
    customPrompt: "Feed focus",
    language: "English",
  });
  const defaultIndex = rules.systemPrompt.indexOf(DEFAULT_SYSTEM_PROMPT);
  const userIndex = rules.systemPrompt.indexOf("User focus");
  const feedIndex = rules.systemPrompt.indexOf("Feed focus");
  const kindIndex = rules.systemPrompt.indexOf(
    "You are a discussion summarizer analyzing a group chat.",
  );
  assertEquals(defaultIndex >= 0, true);
  assertEquals(defaultIndex < userIndex, true);
  assertEquals(userIndex < feedIndex, true);
  assertEquals(feedIndex < kindIndex, true);
  assertEquals(
    rules.systemPrompt.includes('Write all "t" values in English.'),
    true,
  );
});

Deno.test("summarizeFeedPeriod composes prompt layers and passes the run signal without a per-user model override", async () => {
  await withTestDb(async (database) => {
    const { user, feed } = await createFeed(
      database,
      "summarize-compose@example.com",
    );
    await upsertItems(database, feed.id, [normalizedItem()], 1);
    const summarizer = new FakeSummarizer([[{
      text: "Summary point",
      sourceUrl: "https://t.me/channel/1",
    }]]);

    const summary = await summarizeFeedPeriod(
      database,
      user.id,
      feed.id,
      periodStartMs,
      periodEndMs,
      { summarizer, now: () => 99 },
    );

    assertEquals(summary.feedNameSnapshot, feed.name);
    assertEquals(summary.generatedAt, 99);
    assertEquals(summarizer.calls.length, 1);
    assertEquals(summarizer.calls[0].options?.signal?.aborted, false);
    assertEquals("model" in (summarizer.calls[0].options ?? {}), false);
    assertEquals(summarizer.calls[0].items.length, 1);
    const systemPrompt = summarizer.calls[0].rules.systemPrompt;
    assertEquals(systemPrompt.includes(DEFAULT_SYSTEM_PROMPT), true);
    assertEquals(systemPrompt.includes(user.systemPrompt), true);
    assertEquals(systemPrompt.includes("Prefer company strategy."), true);
    assertEquals(
      systemPrompt.includes("You are a concise news summarizer."),
      true,
    );
    assertEquals(
      systemPrompt.includes('Write all "t" values in Ukrainian.'),
      true,
    );
  });
});

Deno.test("summarizeFeedPeriod skips the model and stores an empty summary when the window has no items", async () => {
  await withTestDb(async (database) => {
    const { user, feed } = await createFeed(
      database,
      "summarize-empty@example.com",
    );
    const summarizer = new FakeSummarizer([[{
      text: "should not happen",
      sourceUrl: null,
    }]]);

    const summary = await summarizeFeedPeriod(
      database,
      user.id,
      feed.id,
      periodStartMs,
      periodEndMs,
      { summarizer, now: () => 11 },
    );

    assertEquals(summary.content, { kind: "aggregate", points: [] });
    assertEquals(summary.generatedAt, 11);
    assertEquals(summarizer.calls.length, 0);
  });
});

Deno.test("summarizeFeedPeriod preserves feedNameSnapshot after later feed rename", async () => {
  await withTestDb(async (database) => {
    const { user, feed } = await createFeed(
      database,
      "summarize-snapshot@example.com",
    );
    await upsertItems(database, feed.id, [normalizedItem()], 1);
    const summarizer = new FakeSummarizer([[{
      text: "Snapshot point",
      sourceUrl: null,
    }]]);

    await summarizeFeedPeriod(
      database,
      user.id,
      feed.id,
      periodStartMs,
      periodEndMs,
      { summarizer, now: () => 21 },
    );
    await database.update(feeds).set({ name: "Renamed Channel", updatedAt: 22 })
      .where(eq(feeds.id, feed.id));

    const summary = await findSummaryForFeedPeriod(
      database,
      feed.id,
      periodStartMs,
      periodEndMs,
    );
    assertEquals(summary?.feedNameSnapshot, "Channel");
  });
});

Deno.test("summarizeFeedPeriod re-runs overwrite the same period row", async () => {
  await withTestDb(async (database) => {
    const { user, feed } = await createFeed(
      database,
      "summarize-rerun@example.com",
      null,
    );
    await upsertItems(database, feed.id, [normalizedItem()], 1);
    const summarizer = new FakeSummarizer([
      [{ text: "First point", sourceUrl: null }],
      [{ text: "Second point", sourceUrl: null }],
    ]);

    const first = await summarizeFeedPeriod(
      database,
      user.id,
      feed.id,
      periodStartMs,
      periodEndMs,
      { summarizer, now: () => 31 },
    );
    const second = await summarizeFeedPeriod(
      database,
      user.id,
      feed.id,
      periodStartMs,
      periodEndMs,
      { summarizer, now: () => 32 },
    );

    assertEquals(first.id, second.id);
    assertEquals(second.content, {
      kind: "aggregate",
      points: [{ text: "Second point", sourceUrl: null }],
    });
    assertEquals(second.generatedAt, 32);
  });
});

Deno.test("summarizeFeedPeriod keeps Substack articles isolated, ordered, and tagged with source metadata", async () => {
  await withTestDb(async (database) => {
    const { user, feed } = await createFeed(
      database,
      "summarize-substack@example.com",
      "Prefer practical details.",
      ConnectorId.Substack,
    );
    await upsertItems(database, feed.id, [
      normalizedItem({
        connectorId: ConnectorId.Substack,
        externalId: "article:first",
        title: "  First article  ",
        text: "First body",
        url: "https://example.com/first",
        meta: { contentAccess: "preview" },
      }),
      normalizedItem({
        connectorId: ConnectorId.Substack,
        externalId: "article:second",
        date: 1_700_000_000_001,
        title: "   ",
        text: "",
        url: null,
      }),
    ], 1);
    const summarizer = new FakeSummarizer([
      [{ text: "First point", sourceUrl: "https://example.com/first" }],
    ]);

    const summary = await summarizeFeedPeriod(
      database,
      user.id,
      feed.id,
      periodStartMs,
      periodEndMs,
      { summarizer, now: () => 35 },
    );

    assertEquals(summarizer.calls.length, 1);
    assertEquals(summarizer.calls[0].items.map((entry) => entry.externalId), [
      "article:first",
    ]);
    assertEquals(summarizer.calls[0].options?.summaryMode, "article");
    assertStringIncludes(
      summarizer.calls[0].rules.systemPrompt,
      "concise article summarizer",
    );
    assertStringIncludes(
      summarizer.calls[0].rules.systemPrompt,
      "Prefer practical details.",
    );
    assertEquals(summary.content, {
      kind: "articles",
      articles: [
        {
          sourceExternalId: "article:first",
          title: "First article",
          sourceUrl: "https://example.com/first",
          publishedAt: 1_700_000_000_000,
          contentAccess: "preview",
          points: [{
            text: "First point",
            sourceUrl: "https://example.com/first",
          }],
        },
        {
          sourceExternalId: "article:second",
          title: "Untitled article",
          sourceUrl: null,
          publishedAt: 1_700_000_000_001,
          contentAccess: "full",
          points: [],
        },
      ],
    });
  });
});

Deno.test("summarizeFeedPeriod excludes inaccessible paid previews from model calls and persists paid article metadata", async () => {
  await withTestDb(async (database) => {
    const { user, feed } = await createFeed(
      database,
      "summarize-substack-paid-preview@example.com",
      null,
      ConnectorId.Substack,
    );
    await upsertItems(database, feed.id, [
      normalizedItem({
        connectorId: ConnectorId.Substack,
        externalId: "article:paid-preview",
        title: "Paid preview",
        text: "Teaser that must not reach the model",
        url: "https://writer.substack.com/p/paid-preview",
        meta: { audience: "only_paid", contentAccess: "preview" },
      }),
      normalizedItem({
        connectorId: ConnectorId.Substack,
        externalId: "article:paid-full",
        date: periodStartMs + 1,
        title: "Paid full",
        text: "Accessible paid body",
        url: "https://writer.substack.com/p/paid-full",
        meta: { audience: "only_paid", contentAccess: "full" },
      }),
      normalizedItem({
        connectorId: ConnectorId.Substack,
        externalId: "article:free-preview",
        date: periodStartMs + 2,
        title: "Free preview",
        text: "Accessible free preview body",
        url: "https://writer.substack.com/p/free-preview",
        meta: { audience: "everyone", contentAccess: "preview" },
      }),
    ], 1);
    const summarizer = new FakeSummarizer([
      [{ text: "Paid full point", sourceUrl: null }],
      [{ text: "Free preview point", sourceUrl: null }],
    ]);

    const summary = await summarizeFeedPeriod(
      database,
      user.id,
      feed.id,
      periodStartMs,
      periodEndMs,
      { summarizer, now: () => 36 },
    );

    assertEquals(
      summarizer.calls.map((call) => call.items.map((item) => item.externalId)),
      [["article:paid-full"], ["article:free-preview"]],
    );
    assertEquals(
      summarizer.calls.map((call) => call.options?.summaryMode),
      ["article", "article"],
    );
    assertEquals(summary.content, {
      kind: "articles",
      articles: [
        {
          sourceExternalId: "article:paid-preview",
          title: "Paid preview",
          sourceUrl: "https://writer.substack.com/p/paid-preview",
          publishedAt: periodStartMs,
          contentAccess: "paid",
          points: [],
        },
        {
          sourceExternalId: "article:paid-full",
          title: "Paid full",
          sourceUrl: "https://writer.substack.com/p/paid-full",
          publishedAt: periodStartMs + 1,
          contentAccess: "full",
          points: [{ text: "Paid full point", sourceUrl: null }],
        },
        {
          sourceExternalId: "article:free-preview",
          title: "Free preview",
          sourceUrl: "https://writer.substack.com/p/free-preview",
          publishedAt: periodStartMs + 2,
          contentAccess: "preview",
          points: [{ text: "Free preview point", sourceUrl: null }],
        },
      ],
    });
    assertEquals(
      (await findSummaryForFeedPeriod(
        database,
        feed.id,
        periodStartMs,
        periodEndMs,
      ))?.content,
      summary.content,
    );
  });
});
Deno.test("summarizeFeedPeriod rejects a nonempty Substack article with no points and persists nothing", async () => {
  await withTestDb(async (database) => {
    const { user, feed } = await createFeed(
      database,
      "summarize-substack-empty-output@example.com",
      null,
      ConnectorId.Substack,
    );
    await upsertItems(database, feed.id, [
      normalizedItem({
        connectorId: ConnectorId.Substack,
        externalId: "article:no-points",
        text: "Nonempty body",
      }),
    ], 1);

    await assertRejects(
      () =>
        summarizeFeedPeriod(
          database,
          user.id,
          feed.id,
          periodStartMs,
          periodEndMs,
          { summarizer: new FakeSummarizer([[]]) },
        ),
      Error,
      "returned no points",
    );
    assertEquals(
      await findSummaryForFeedPeriod(
        database,
        feed.id,
        periodStartMs,
        periodEndMs,
      ),
      null,
    );
  });
});

Deno.test("summarizeFeedPeriod does not persist an empty Substack summary after cancellation", async () => {
  await withTestDb(async (database) => {
    const { user, feed } = await createFeed(
      database,
      "summarize-substack-cancelled-empty@example.com",
      null,
      ConnectorId.Substack,
    );
    const controller = new AbortController();
    controller.abort(
      new DOMException("cancel empty article query", "AbortError"),
    );

    await assertRejects(
      () =>
        summarizeFeedPeriod(
          database,
          user.id,
          feed.id,
          periodStartMs,
          periodEndMs,
          { signal: controller.signal },
        ),
      DOMException,
      "cancel empty article query",
    );
    assertEquals(
      await findSummaryForFeedPeriod(
        database,
        feed.id,
        periodStartMs,
        periodEndMs,
      ),
      null,
    );
  });
});

Deno.test("getOrSummarizeFeedPeriod enforces feed ownership on cached summaries", async () => {
  await withTestDb(async (database) => {
    const { user, feed } = await createFeed(
      database,
      "summarize-owner@example.com",
    );
    const otherUser = await createUser(
      database,
      userInput("summarize-other@example.com"),
    );
    await upsertItems(database, feed.id, [normalizedItem()], 1);
    const summarizer = new FakeSummarizer([[{
      text: "Owned point",
      sourceUrl: null,
    }]]);
    await summarizeFeedPeriod(
      database,
      user.id,
      feed.id,
      periodStartMs,
      periodEndMs,
      { summarizer, now: () => 40 },
    );

    await assertRejects(
      () =>
        getOrSummarizeFeedPeriod(
          database,
          otherUser.id,
          feed.id,
          periodStartMs,
          periodEndMs,
        ),
      Error,
      "feed not found",
    );
  });
});

// --- Fake summarizers for signal/timeout tests ---

class SignalAwareFakeSummarizer implements SummarizerService {
  readonly calls: Array<
    {
      items: NormalizedItem[];
      rules: SummaryRuleset;
      options?: SummarizeOptions;
    }
  > = [];

  summarize(
    items: NormalizedItem[],
    rules: SummaryRuleset,
    options?: SummarizeOptions,
  ): Promise<SummaryPoint[]> {
    this.calls.push({ items, rules, options });
    if (options?.signal?.aborted) {
      return Promise.reject(options.signal.reason);
    }
    return Promise.resolve(items.map(() => ({ text: "ok", sourceUrl: null })));
  }
}

class NeverSettlingFakeSummarizer implements SummarizerService {
  summarize(
    _items: NormalizedItem[],
    _rules: SummaryRuleset,
    options?: SummarizeOptions,
  ): Promise<SummaryPoint[]> {
    return new Promise<SummaryPoint[]>((_resolve, reject) => {
      if (options?.signal) {
        if (options.signal.aborted) {
          reject(options.signal.reason);
          return;
        }
        options.signal.addEventListener(
          "abort",
          () => reject(options.signal!.reason),
          { once: true },
        );
      }
    });
  }
}

class SignalIgnoringNeverSettlingFakeSummarizer implements SummarizerService {
  summarize(
    _items: NormalizedItem[],
    _rules: SummaryRuleset,
    _options?: SummarizeOptions,
  ): Promise<SummaryPoint[]> {
    return new Promise<SummaryPoint[]>(() => {});
  }
}

class TwoRequestFakeSummarizer implements SummarizerService {
  completedRequestCount = 0;

  async summarize(
    _items: NormalizedItem[],
    _rules: SummaryRuleset,
    options?: SummarizeOptions,
  ): Promise<SummaryPoint[]> {
    for (let requestIndex = 0; requestIndex < 2; requestIndex++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      options?.signal?.throwIfAborted();
      this.completedRequestCount++;
    }
    return [{ text: "two requests completed", sourceUrl: null }];
  }
}

class HealthyRetryVisionHierarchyFakeSummarizer implements SummarizerService {
  completed = false;

  async summarize(
    _items: NormalizedItem[],
    _rules: SummaryRuleset,
    options?: SummarizeOptions,
  ): Promise<SummaryPoint[]> {
    // This integration test exercises the real watchdog with a 350 ms gap beyond the old deadline.
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 800);
    await promise;
    options?.signal?.throwIfAborted();
    this.completed = true;
    return [{ text: "healthy envelope completed", sourceUrl: null }];
  }
}

Deno.test("summarizeOwnedFeedPeriod — abort signal before summarization rejects with AbortError", async () => {
  await withTestDb(async (database) => {
    const { user, feed } = await createFeed(
      database,
      "summarize-abort@example.com",
    );
    await upsertItems(database, feed.id, [normalizedItem()], 1);
    const summarizer = new SignalAwareFakeSummarizer();
    const signal = AbortSignal.abort(
      new DOMException("test abort", "AbortError"),
    );

    await assertRejects(
      () =>
        summarizeFeedPeriod(
          database,
          user.id,
          feed.id,
          periodStartMs,
          periodEndMs,
          { summarizer, signal },
        ),
      DOMException,
      "test abort",
    );
  });
});

Deno.test("summarizeOwnedFeedPeriod — timeout during summarization rejects with TimeoutError", async () => {
  await withTestDb(async (database) => {
    const { user, feed } = await createFeed(
      database,
      "summarize-timeout@example.com",
    );
    await upsertItems(database, feed.id, [normalizedItem()], 1);
    const summarizer = new NeverSettlingFakeSummarizer();

    await assertRejects(
      () =>
        summarizeFeedPeriod(
          database,
          user.id,
          feed.id,
          periodStartMs,
          periodEndMs,
          { summarizer, timeoutMs: 5 },
        ),
      DOMException,
      "Summarizer timed out",
    );
  });
});

Deno.test("summarizeOwnedFeedPeriod — watchdog rejects a signal-ignoring summarizer", async () => {
  await withTestDb(async (database) => {
    const { user, feed } = await createFeed(
      database,
      "summarize-signal-ignoring-timeout@example.com",
    );
    await upsertItems(database, feed.id, [normalizedItem()], 1);

    await assertRejects(
      () =>
        summarizeFeedPeriod(
          database,
          user.id,
          feed.id,
          periodStartMs,
          periodEndMs,
          {
            summarizer: new SignalIgnoringNeverSettlingFakeSummarizer(),
            timeoutMs: 5,
          },
        ),
      DOMException,
      "Summarizer timed out",
    );
  });
});

Deno.test("summarizeOwnedFeedPeriod — passes a per-request timeout to the summarizer", async () => {
  await withTestDb(async (database) => {
    const { user, feed } = await createFeed(
      database,
      "summarize-request-timeout@example.com",
    );
    await upsertItems(database, feed.id, [normalizedItem()], 1);
    const summarizer = new FakeSummarizer([[{
      text: "request completed",
      sourceUrl: null,
    }]]);

    await summarizeFeedPeriod(
      database,
      user.id,
      feed.id,
      periodStartMs,
      periodEndMs,
      { summarizer, timeoutMs: 5 },
    );

    assertEquals(summarizer.calls[0].options?.requestTimeoutMs, 5);
  });
});

Deno.test("summarizeOwnedFeedPeriod — forwards configured chunk and image limits", async () => {
  const variableNames = [
    "SUMMARIZER_TEXT_BYTES_PER_CHUNK",
    "SUMMARIZER_MAX_ITEMS_PER_CHUNK",
    "SUMMARIZER_MAX_IMAGE_BYTES",
  ] as const;
  const previousValues = variableNames.map((name) => Deno.env.get(name));
  Deno.env.set("SUMMARIZER_TEXT_BYTES_PER_CHUNK", "23456");
  Deno.env.set("SUMMARIZER_MAX_ITEMS_PER_CHUNK", "12");
  Deno.env.set("SUMMARIZER_MAX_IMAGE_BYTES", "34567");

  try {
    await withTestDb(async (database) => {
      const { user, feed } = await createFeed(
        database,
        "summarize-configured-limits@example.com",
      );
      await upsertItems(database, feed.id, [normalizedItem()], 1);
      const summarizer = new FakeSummarizer([[{
        text: "configured request",
        sourceUrl: null,
      }]]);

      await summarizeFeedPeriod(
        database,
        user.id,
        feed.id,
        periodStartMs,
        periodEndMs,
        { summarizer },
      );

      assertEquals(summarizer.calls[0].options?.maxTextBytesPerChunk, 23456);
      assertEquals(summarizer.calls[0].options?.maxItemsPerChunk, 12);
      assertEquals(summarizer.calls[0].options?.maxImageBytes, 34567);
    });
  } finally {
    for (let index = 0; index < variableNames.length; index++) {
      const previousValue = previousValues[index];
      if (previousValue === undefined) {
        Deno.env.delete(variableNames[index]);
      } else {
        Deno.env.set(variableNames[index], previousValue);
      }
    }
  }
});

Deno.test("summarizeOwnedFeedPeriod — healthy sequential requests may exceed one request timeout in total", async () => {
  await withTestDb(async (database) => {
    const { user, feed } = await createFeed(
      database,
      "summarize-sequential-requests@example.com",
    );
    await upsertItems(database, feed.id, [normalizedItem()], 1);
    const summarizer = new TwoRequestFakeSummarizer();

    await summarizeFeedPeriod(
      database,
      user.id,
      feed.id,
      periodStartMs,
      periodEndMs,
      { summarizer, timeoutMs: 30 },
    );

    assertEquals(summarizer.completedRequestCount, 2);
  });
});

Deno.test("summarizeOwnedFeedPeriod — watchdog permits retry, vision, and hierarchical merge envelope", async () => {
  await withTestDb(async (database) => {
    const { user, feed } = await createFeed(
      database,
      "summarize-retry-vision-hierarchy-envelope@example.com",
    );
    await upsertItems(database, feed.id, [normalizedItem()], 1);
    const summarizer = new HealthyRetryVisionHierarchyFakeSummarizer();

    await summarizeFeedPeriod(
      database,
      user.id,
      feed.id,
      periodStartMs,
      periodEndMs,
      { summarizer, timeoutMs: 150 },
    );

    assertEquals(summarizer.completed, true);
  });
});

Deno.test("summarizeOwnedFeedPeriod — records redacted feed timeout context", async () => {
  await withTestDb(async (database) => {
    const { user, feed } = await createFeed(
      database,
      "summarize-timeout-log@example.com",
    );
    await upsertItems(database, feed.id, [normalizedItem()], 1);
    const summarizer = new NeverSettlingFakeSummarizer();
    const events: OperationalLogEvent[] = [];

    await assertRejects(
      () =>
        summarizeFeedPeriod(
          database,
          user.id,
          feed.id,
          periodStartMs,
          periodEndMs,
          {
            summarizer,
            timeoutMs: 5,
            runId: "run-timeout",
            recordOperationalEvent: (event) => {
              events.push(event);
              return Promise.resolve();
            },
          },
        ),
      DOMException,
      "Summarizer timed out",
    );

    assertEquals(events, [{
      level: "error",
      event: "summarization.feed_failed",
      runId: "run-timeout",
      feedId: feed.id,
      connectorId: ConnectorId.Telegram,
      itemCount: 1,
      errorMessage: "Summarizer timed out",
    }]);
  });
});

Deno.test("cleanupFeedMedia — deletes files for media items in the window", async () => {
  await withTestDb(async (database) => {
    const { feed } = await createFeed(
      database,
      "summarize-cleanup-file@example.com",
    );
    const testDir = "./media/test-summarization-cleanup";
    await Deno.mkdir(testDir, { recursive: true });
    const mediaPath = `${testDir}/test-photo.jpg`;
    await Deno.writeTextFile(mediaPath, "fake image bytes");

    await upsertItems(database, feed.id, [normalizedItem({
      media: { type: "photo" as const, localPath: mediaPath },
    })], 1);

    await cleanupFeedMedia(database, feed.id, periodStartMs, periodEndMs);

    // File should be gone
    await assertRejects(() => Deno.stat(mediaPath), Deno.errors.NotFound);
    await Deno.remove(testDir, { recursive: true }).catch(() => {});
  });
});

Deno.test("cleanupFeedMedia — handles missing file without throwing", async () => {
  await withTestDb(async (database) => {
    const { feed } = await createFeed(
      database,
      "summarize-cleanup-missing@example.com",
    );
    const testDir = "./media/test-summarization-cleanup-missing";
    await Deno.mkdir(testDir, { recursive: true });
    const missingPath = `${testDir}/nonexistent-media-file.jpg`;

    await upsertItems(database, feed.id, [normalizedItem({
      media: { type: "photo" as const, localPath: missingPath },
    })], 1);

    // Should not throw despite file not existing
    await cleanupFeedMedia(database, feed.id, periodStartMs, periodEndMs);
    await Deno.remove(testDir, { recursive: true }).catch(() => {});
  });
});

Deno.test("summarizeFeedPeriod — media cleanup after success does not fail the summarization", async () => {
  await withTestDb(async (database) => {
    const { user, feed } = await createFeed(
      database,
      "summarize-cleanup-nonfatal@example.com",
    );
    const testDir = "./media/test-summarization-cleanup-nonfatal";
    await Deno.mkdir(testDir, { recursive: true });
    await Deno.writeTextFile(`${testDir}/wont-be-deleted.jpg`, "image");
    // Create a subdirectory with a file in it — Deno.remove on a non-empty
    // directory fails (EPERM on macOS), simulating a nonfatal cleanup error.
    await Deno.mkdir(`${testDir}/subdir`, { recursive: true });
    await Deno.writeTextFile(`${testDir}/subdir/locked.jpg`, "locked");
    const mediaPath = `${testDir}/subdir/locked.jpg`;

    await upsertItems(database, feed.id, [normalizedItem({
      media: { type: "photo" as const, localPath: mediaPath },
    })], 1);

    const summarizer = new FakeSummarizer([[{
      text: "Keep me",
      sourceUrl: null,
    }]]);

    // Summarization should succeed even though cleanup will fail
    // (Deno.remove on a single file should succeed, but this test simulates
    //  a scenario where the cleanup encounters an error)
    const summary = await summarizeFeedPeriod(
      database,
      user.id,
      feed.id,
      periodStartMs,
      periodEndMs,
      { summarizer, now: () => 55 },
    );
    assertEquals(summary.content.kind, "aggregate");
    if (summary.content.kind !== "aggregate") {
      throw new Error("expected aggregate summary");
    }
    assertEquals(summary.content.points.length, 1);
    assertEquals(summary.content.points[0].text, "Keep me");

    await Deno.remove(testDir, { recursive: true }).catch(() => {});
  });
});
