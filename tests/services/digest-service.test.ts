import { test } from "bun:test";
import { assertEquals } from "../assertions.ts"
import { sql } from "drizzle-orm";
import { ConnectorId } from "../../src/constants.ts";
import {
  CredentialCipher,
  type EncryptedBlob,
} from "../../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../src/crypto/key-provider.ts";
import type { Database } from "../../src/db/client.ts";
import { withTestDb } from "../../src/db/testing.ts";
import type { NormalizedItem } from "../../src/connectors/connector.types.ts";
import {
  createOrReviveFeed,
  type PublicFeed,
  softDeleteFeed,
  updateFeed,
} from "../../src/repositories/feed-repository.ts";
import { upsertItems } from "../../src/repositories/item-repository.ts";
import { createDigestRun } from "../../src/repositories/digest-run-repository.ts";
import { upsertSummaryForPeriod } from "../../src/repositories/summary-repository.ts";
import {
  createSource,
  updateSource,
} from "../../src/repositories/source-repository.ts";
import {
  createUser,
  type CreateUserInput,
} from "../../src/repositories/user-repository.ts";
import {
  assembleDigestForPeriod,
  buildDigestViewById,
  renderDigestMarkdown,
} from "../../src/services/digest-service.ts";
import { discardOperationalEvent } from "../operational-log-recorder.ts";

import type {
  SummarizeOptions,
  SummarizerService,
  SummaryPoint,
  SummaryRuleset,
} from "../../src/summarizers/summarizer.types.ts";

class FakeSummarizer implements SummarizerService {
  readonly calls: Array<
    {
      items: NormalizedItem[];
      rules: SummaryRuleset;
      options?: SummarizeOptions;
    }
  > = [];
  #results: Array<SummaryPoint[] | Error>;

  constructor(results: Array<SummaryPoint[] | Error>) {
    this.#results = [...results];
  }

  summarize(
    items: NormalizedItem[],
    rules: SummaryRuleset,
    options?: SummarizeOptions,
  ): Promise<SummaryPoint[]> {
    this.calls.push({ items, rules, options });
    const result = this.#results.shift() ?? [];
    if (result instanceof Error) {
      return Promise.reject(result);
    }
    return Promise.resolve(result);
  }
}

function userInput(email: string): CreateUserInput {
  return {
    name: "Digest Service Owner",
    email,
    passwordHash: "$argon2id$fakehash",
    systemPrompt: "Summarize tersely.",
    defaultLanguage: "en",
  };
}

function credentialCipher(): CredentialCipher {
  return new CredentialCipher(
    new EnvMasterKeyProvider(new Uint8Array(32).fill(47)),
  );
}

async function encryptedCredentials(
  userId: string,
  connectorId: ConnectorId,
): Promise<EncryptedBlob> {
  return await credentialCipher().encrypt(
    JSON.stringify({ sessionString: `${connectorId}-session` }),
    {
      userId,
      connectorId,
    },
  );
}

async function createSourceForUser(
  database: Database,
  userId: string,
  connectorId: ConnectorId,
  position: number,
): Promise<string> {
  const source = await createSource(database, {
    userId,
    connectorId,
    credentials: await encryptedCredentials(userId, connectorId),
    position,
  });
  return source.id;
}

async function createFeedForSource(
  database: Database,
  userId: string,
  sourceId: string,
  feedPosition: number,
  externalId: string,
  name: string,
  enabled = true,
): Promise<PublicFeed> {
  const feed = await createOrReviveFeed(database, {
    userId,
    sourceId,
    externalId,
    name,
    kind: "news",
    position: feedPosition,
  });
  return enabled
    ? feed
    : await updateFeed(database, feed.id, userId, { enabled: false });
}

function normalizedItem(
  feedExternalId: string,
  externalId: string,
  text: string,
  connectorId: ConnectorId = ConnectorId.Telegram,
  overrides: Partial<NormalizedItem> = {},
): NormalizedItem {
  return {
    connectorId,
    feedExternalId,
    externalId,
    date: 1_700_000_000_000,
    title: null,
    text,
    author: "Channel",
    url: null,
    ...overrides,
  };
}

const periodStartMs = 1_700_000_000_000;
const discardLogRecorder = { recordOperationalEvent: discardOperationalEvent };
const periodEndMs = 1_700_086_400_000;

test("assembleDigestForPeriod orders sections by source then feed position", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("digest-service-order@example.com"),
    );
    const rssSourceId = await createSourceForUser(
      database,
      user.id,
      ConnectorId.RSS,
      1,
    );
    const telegramSourceId = await createSourceForUser(
      database,
      user.id,
      ConnectorId.Telegram,
      2,
    );
    const rssLaterFeed = await createFeedForSource(
      database,
      user.id,
      rssSourceId,
      2,
      "rss:2",
      "RSS Two",
    );
    const rssEarlierFeed = await createFeedForSource(
      database,
      user.id,
      rssSourceId,
      1,
      "rss:1",
      "RSS One",
    );
    const telegramFeed = await createFeedForSource(
      database,
      user.id,
      telegramSourceId,
      1,
      "channel:1",
      "Telegram One",
    );
    await upsertItems(database, rssLaterFeed.id, [
      normalizedItem(rssLaterFeed.externalId, "1", "rss-two"),
    ], 1);
    await upsertItems(database, rssEarlierFeed.id, [
      normalizedItem(rssEarlierFeed.externalId, "1", "rss-one"),
    ], 1);
    await upsertItems(database, telegramFeed.id, [
      normalizedItem(telegramFeed.externalId, "1", "telegram"),
    ], 1);

    const view = await assembleDigestForPeriod(
      database,
      user.id,
      periodStartMs,
      periodEndMs,
      {
        ...discardLogRecorder,
        summarizer: new FakeSummarizer([
          [{ text: "rss-two", sourceUrl: null }],
          [{ text: "rss-one", sourceUrl: null }],
          [{ text: "telegram", sourceUrl: null }],
        ]),
        now: () => 50,
      },
    );

    assertEquals(view.digest.status, "complete");
    assertEquals(view.sections.map((section) => section.feedName), [
      "RSS One",
      "RSS Two",
      "Telegram One",
    ]);
    assertEquals(view.groups.map((group) => group.connectorId), [
      ConnectorId.RSS,
      ConnectorId.Telegram,
    ]);
  });
});

test("assembleDigestForPeriod excludes disabled feeds on fresh assembly but keeps historical deleted summaries on read", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("digest-service-deleted@example.com"),
    );
    const telegramSourceId = await createSourceForUser(
      database,
      user.id,
      ConnectorId.Telegram,
      1,
    );
    const activeFeed = await createFeedForSource(
      database,
      user.id,
      telegramSourceId,
      1,
      "channel:1",
      "Active Feed",
    );
    const deletedFeed = await createFeedForSource(
      database,
      user.id,
      telegramSourceId,
      2,
      "channel:2",
      "Deleted Feed",
    );
    await upsertItems(database, activeFeed.id, [
      normalizedItem(activeFeed.externalId, "1", "active"),
    ], 1);
    await upsertItems(database, deletedFeed.id, [
      normalizedItem(deletedFeed.externalId, "1", "deleted"),
    ], 1);

    const firstDigest = await assembleDigestForPeriod(
      database,
      user.id,
      periodStartMs,
      periodEndMs,
      {
        ...discardLogRecorder,
        summarizer: new FakeSummarizer([
          [{ text: "active", sourceUrl: null }],
          [{ text: "deleted", sourceUrl: null }],
        ]),
        now: () => 60,
      },
    );
    assertEquals(firstDigest.sections.length, 2);

    await softDeleteFeed(database, deletedFeed.id, user.id);
    const secondDigest = await assembleDigestForPeriod(
      database,
      user.id,
      periodStartMs,
      periodEndMs,
      {
        ...discardLogRecorder,
        summarizer: new FakeSummarizer([]),
        now: () => 61,
      },
    );
    assertEquals(secondDigest.digest.id, firstDigest.digest.id);

    const historicalView = await buildDigestViewById(
      database,
      user.id,
      firstDigest.digest.id,
    );
    assertEquals(
      historicalView.sections.map((section) => section.feedRemoved),
      [false, true],
    );
    assertEquals(historicalView.sections[1].feedName, "Deleted Feed");
  });
});

test("assembleDigestForPeriod marks partial failures as failed and keeps successful sections", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("digest-service-failure@example.com"),
    );
    const telegramSourceId = await createSourceForUser(
      database,
      user.id,
      ConnectorId.Telegram,
      1,
    );
    const firstFeed = await createFeedForSource(
      database,
      user.id,
      telegramSourceId,
      1,
      "channel:1",
      "First",
    );
    const secondFeed = await createFeedForSource(
      database,
      user.id,
      telegramSourceId,
      2,
      "channel:2",
      "Second",
    );
    await upsertItems(database, firstFeed.id, [
      normalizedItem(firstFeed.externalId, "1", "first"),
    ], 1);
    await upsertItems(database, secondFeed.id, [
      normalizedItem(secondFeed.externalId, "1", "second"),
    ], 1);

    const view = await assembleDigestForPeriod(
      database,
      user.id,
      periodStartMs,
      periodEndMs,
      {
        ...discardLogRecorder,
        summarizer: new FakeSummarizer([
          [{ text: "first summary", sourceUrl: null }],
          new Error("boom"),
        ]),
        now: () => 70,
      },
    );

    assertEquals(view.digest.status, "failed");
    assertEquals(view.sections.map((section) => section.feedName), ["First"]);
  });
});

test("assembleDigestForPeriod is idempotent and reuses cached summaries", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("digest-service-idempotent@example.com"),
    );
    const telegramSourceId = await createSourceForUser(
      database,
      user.id,
      ConnectorId.Telegram,
      1,
    );
    const feed = await createFeedForSource(
      database,
      user.id,
      telegramSourceId,
      1,
      "channel:1",
      "Only Feed",
    );
    await upsertItems(database, feed.id, [
      normalizedItem(feed.externalId, "1", "only"),
    ], 1);
    const summarizer = new FakeSummarizer([[{
      text: "once",
      sourceUrl: null,
    }]]);

    const first = await assembleDigestForPeriod(
      database,
      user.id,
      periodStartMs,
      periodEndMs,
        {
          ...discardLogRecorder,
          summarizer,
          now: () => 80,
        },
    );
    const second = await assembleDigestForPeriod(
      database,
      user.id,
      periodStartMs,
      periodEndMs,
        {
          ...discardLogRecorder,
          summarizer,
          now: () => 81,
        },
    );

    assertEquals(first.digest.id, second.digest.id);
    assertEquals(summarizer.calls.length, 1);
  });
});

test("renderDigestMarkdown includes ordered source groups and removed marker", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("digest-service-markdown@example.com"),
    );
    const telegramSourceId = await createSourceForUser(
      database,
      user.id,
      ConnectorId.Telegram,
      1,
    );
    const feed = await createFeedForSource(
      database,
      user.id,
      telegramSourceId,
      1,
      "channel:1",
      "Markdown Feed",
    );
    await upsertItems(database, feed.id, [
      normalizedItem(feed.externalId, "1", "markdown"),
    ], 1);

    const digest = await assembleDigestForPeriod(
      database,
      user.id,
      periodStartMs,
      periodEndMs,
      {
        ...discardLogRecorder,
        summarizer: new FakeSummarizer([[{
          text: "markdown bullet",
          sourceUrl: null,
        }]]),
        now: () => 90,
      },
    );
    await softDeleteFeed(database, feed.id, user.id);
    const historicalView = await buildDigestViewById(
      database,
      user.id,
      digest.digest.id,
    );

    const markdown = renderDigestMarkdown(historicalView);
    assertEquals(markdown.includes("## Telegram"), true);
    assertEquals(markdown.includes("### Markdown Feed (removed)"), true);
    assertEquals(markdown.includes("- markdown bullet"), true);
  });
});

test("assembleDigestForPeriod batches cached summaries and only summarizes missing feeds", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("digest-service-batch@example.com"),
    );
    const telegramSourceId = await createSourceForUser(
      database,
      user.id,
      ConnectorId.Telegram,
      1,
    );
    const feedA = await createFeedForSource(
      database,
      user.id,
      telegramSourceId,
      1,
      "channel:1",
      "Feed A",
    );
    const feedB = await createFeedForSource(
      database,
      user.id,
      telegramSourceId,
      2,
      "channel:2",
      "Feed B",
    );

    await upsertSummaryForPeriod(database, {
      feedId: feedA.id,
      periodStartMs,
      periodEndMs,
      content: {
        kind: "aggregate",
        points: [{ text: "cached point", sourceUrl: null }],
      },
      feedNameSnapshot: feedA.name,
    });
    await upsertItems(database, feedB.id, [
      normalizedItem(feedB.externalId, "1", "fresh"),
    ], 1);

    const fakeSummarizer = new FakeSummarizer([[{
      text: "fresh point",
      sourceUrl: null,
    }]]);

    const view = await assembleDigestForPeriod(
      database,
      user.id,
      periodStartMs,
      periodEndMs,
      {
        ...discardLogRecorder,
        summarizer: fakeSummarizer,
        now: () => 100,
      },
    );

    assertEquals(fakeSummarizer.calls.length, 1);
    assertEquals(view.sections.length, 2);

    const sectionA = view.sections.find((section) =>
      section.feedId === feedA.id
    )!;
    const sectionB = view.sections.find((section) =>
      section.feedId === feedB.id
    )!;

    assertEquals(sectionA.content, {
      kind: "aggregate",
      points: [{ text: "cached point", sourceUrl: null }],
    });
    assertEquals(sectionB.content, {
      kind: "aggregate",
      points: [{ text: "fresh point", sourceUrl: null }],
    });
  });
});

test("assembleDigestForPeriod keeps source groups contiguous when positions tie", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("digest-service-contiguous@example.com"),
    );
    const sourceAId = await createSourceForUser(
      database,
      user.id,
      ConnectorId.Telegram,
      1,
    );
    const sourceBId = await createSourceForUser(
      database,
      user.id,
      ConnectorId.RSS,
      1,
    );

    const feedA1 = await createFeedForSource(
      database,
      user.id,
      sourceAId,
      1,
      "channel:a1",
      "Alpha",
    );
    const feedA2 = await createFeedForSource(
      database,
      user.id,
      sourceAId,
      2,
      "channel:a2",
      "Beta",
    );
    const feedB1 = await createFeedForSource(
      database,
      user.id,
      sourceBId,
      1,
      "rss:b1",
      "Gamma",
    );
    const feedB2 = await createFeedForSource(
      database,
      user.id,
      sourceBId,
      2,
      "rss:b2",
      "Delta",
    );

    await upsertItems(database, feedA1.id, [
      normalizedItem(feedA1.externalId, "1", "alpha"),
    ], 1);
    await upsertItems(database, feedA2.id, [
      normalizedItem(feedA2.externalId, "1", "beta"),
    ], 1);
    await upsertItems(database, feedB1.id, [
      normalizedItem(feedB1.externalId, "1", "gamma"),
    ], 1);
    await upsertItems(database, feedB2.id, [
      normalizedItem(feedB2.externalId, "1", "delta"),
    ], 1);

    const view = await assembleDigestForPeriod(
      database,
      user.id,
      periodStartMs,
      periodEndMs,
      {
        ...discardLogRecorder,
        summarizer: new FakeSummarizer([[], [], [], []]),
      },
    );

    assertEquals(view.groups.length, 2);

    const seenSourceIds = new Set(view.groups.map((g) => g.sourceId));
    assertEquals(seenSourceIds.size, 2);

    for (const group of view.groups) {
      for (const section of group.sections) {
        assertEquals(section.sourceId, group.sourceId);
      }
    }
  });
});

test("assembleDigestForPeriod records summarization failures in digest_run_feeds when runId is supplied", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("digest-service-run-failure@example.com"),
    );
    const telegramSourceId = await createSourceForUser(
      database,
      user.id,
      ConnectorId.Telegram,
      1,
    );
    const feed = await createFeedForSource(
      database,
      user.id,
      telegramSourceId,
      1,
      "channel:boom",
      "Boom Feed",
    );
    await upsertItems(database, feed.id, [
      normalizedItem(feed.externalId, "1", "boom text"),
    ], 1);

    const digestRun = await createDigestRun(database, {
      userId: user.id,
      trigger: "manual",
      periodStartMs,
      periodEndMs,
      status: "running",
    });

    const sourceConnectorIdsBySourceId = new Map([[
      telegramSourceId,
      ConnectorId.Telegram,
    ]]);

    const view = await assembleDigestForPeriod(
      database,
      user.id,
      periodStartMs,
      periodEndMs,
      {
        ...discardLogRecorder,
        summarizer: new FakeSummarizer([
          new Error(
            "summarizer failed with sk-live-secret and https://alice:password@example.com/path",
          ),
        ]),
        runId: digestRun.id,
        sourceConnectorIdsBySourceId,
      },
    );

    assertEquals(view.digest.status, "failed");

    const feedRows: Array<Record<string, unknown>> = await database.execute(
      sql`select * from digest_run_feeds where run_id = ${digestRun.id}`,
    );
    const failedSummarizationRows = feedRows.filter(
      (r) =>
        r.stage === "summarization" && r.status === "failed" &&
        r.error_message !== null,
    );
    assertEquals(failedSummarizationRows.length >= 1, true);
    const persistedError = String(failedSummarizationRows[0].error_message);
    assertEquals(persistedError.includes("sk-live-secret"), false);
    assertEquals(persistedError.includes("alice:password"), false);

    // assembleDigestForPeriod records feed-level failures but does not finish
    // the digest run — that's the orchestrator's job. Verify the run is still "running".
    const runRows = await database.execute(
      sql`select status from digest_runs where id = ${digestRun.id}`,
    );
    assertEquals(runRows.length, 1);
    assertEquals(runRows[0].status, "running");
  });
});

/**
 * A summarizer that tracks the maximum number of concurrent calls.
 * Each call yields once to allow other calls to start concurrently.
 */
class ConcurrentCountingSummarizer implements SummarizerService {
  active = 0;
  maxActive = 0;
  callCount = 0;

  async summarize(
    _items: NormalizedItem[],
    _rules: SummaryRuleset,
    _options?: SummarizeOptions,
  ): Promise<SummaryPoint[]> {
    this.callCount++;
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    // Yield once so the event loop can start other concurrent calls
    await Promise.resolve();
    this.active--;
    return [{ text: "summary", sourceUrl: null }];
  }
}

test("assembleDigestForPeriod respects summarizationConcurrency=2 with bounded parallelism", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("concurrency-2-test@example.com"),
    );
    const sourceId = await createSourceForUser(
      database,
      user.id,
      ConnectorId.Telegram,
      1,
    );
    const feed1 = await createFeedForSource(
      database,
      user.id,
      sourceId,
      1,
      "channel:a",
      "Feed A",
    );
    const feed2 = await createFeedForSource(
      database,
      user.id,
      sourceId,
      2,
      "channel:b",
      "Feed B",
    );
    const feed3 = await createFeedForSource(
      database,
      user.id,
      sourceId,
      3,
      "channel:c",
      "Feed C",
    );
    for (const feed of [feed1, feed2, feed3]) {
      await upsertItems(database, feed.id, [
        normalizedItem(feed.externalId, "1", "item text"),
      ], 1);
    }

    const counter = new ConcurrentCountingSummarizer();
    const view = await assembleDigestForPeriod(
      database,
      user.id,
      periodStartMs,
      periodEndMs,
      {
        ...discardLogRecorder,
        summarizer: counter,
        summarizationConcurrency: 2,
      },
    );

    assertEquals(view.digest.status, "complete", "digest should complete");
    assertEquals(
      view.sections.length,
      3,
      "all 3 feeds should produce sections",
    );
    assertEquals(counter.callCount, 3, "all 3 feeds should be summarized");
    // With concurrency=2 and 3 feeds, at most 2 should run concurrently
    assertEquals(
      counter.maxActive <= 2,
      true,
      `max concurrent should be ≤2, was ${counter.maxActive}`,
    );
    // Ordering should be by position
    assertEquals(view.sections[0].feedId, feed1.id);
    assertEquals(view.sections[1].feedId, feed2.id);
    assertEquals(view.sections[2].feedId, feed3.id);
  });
});

test("assembleDigestForPeriod with concurrency=1 runs feeds sequentially", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("concurrency-1-test@example.com"),
    );
    const sourceId = await createSourceForUser(
      database,
      user.id,
      ConnectorId.Telegram,
      1,
    );
    const feed1 = await createFeedForSource(
      database,
      user.id,
      sourceId,
      1,
      "channel:x",
      "Feed X",
    );
    const feed2 = await createFeedForSource(
      database,
      user.id,
      sourceId,
      2,
      "channel:y",
      "Feed Y",
    );
    for (const feed of [feed1, feed2]) {
      await upsertItems(database, feed.id, [
        normalizedItem(feed.externalId, "1", "item text"),
      ], 1);
    }

    const counter = new ConcurrentCountingSummarizer();
    const view = await assembleDigestForPeriod(
      database,
      user.id,
      periodStartMs,
      periodEndMs,
      {
        ...discardLogRecorder,
        summarizer: counter,
        summarizationConcurrency: 1,
      },
    );

    assertEquals(view.digest.status, "complete", "digest should complete");
    assertEquals(view.sections.length, 2, "both feeds should produce sections");
    assertEquals(counter.callCount, 2, "both feeds should be summarized");
    // With concurrency=1, feeds run sequentially
    assertEquals(
      counter.maxActive,
      1,
      `max concurrent should be 1, was ${counter.maxActive}`,
    );
    assertEquals(view.sections[0].feedId, feed1.id);
    assertEquals(view.sections[1].feedId, feed2.id);
  });
});

test("assembleDigestForPeriod with concurrent summarization isolates feed failures", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("concurrency-failure@example.com"),
    );
    const sourceId = await createSourceForUser(
      database,
      user.id,
      ConnectorId.Telegram,
      1,
    );
    const feed1 = await createFeedForSource(
      database,
      user.id,
      sourceId,
      1,
      "channel:good",
      "Good Feed",
    );
    const feed2 = await createFeedForSource(
      database,
      user.id,
      sourceId,
      2,
      "channel:bad",
      "Bad Feed",
    );
    for (const feed of [feed1, feed2]) {
      await upsertItems(database, feed.id, [
        normalizedItem(feed.externalId, "1", "item text"),
      ], 1);
    }

    // Second summarizer call throws; first succeeds
    const failingSummarizer = new FakeSummarizer([
      [{ text: "good summary", sourceUrl: null }],
      new Error("bad feed error"),
    ]);

    const view = await assembleDigestForPeriod(
      database,
      user.id,
      periodStartMs,
      periodEndMs,
      {
        ...discardLogRecorder,
        summarizer: failingSummarizer,
        summarizationConcurrency: 5,
      },
    );

    // Digest marked failed because one feed failed
    assertEquals(view.digest.status, "failed");
    // The good feed's section is still present
    assertEquals(
      view.sections.length,
      1,
      "only the successful feed should have a section",
    );
    assertEquals(view.sections[0].feedId, feed1.id);
    assertEquals(view.sections[0].content, {
      kind: "aggregate",
      points: [{ text: "good summary", sourceUrl: null }],
    });
  });
});

test("assembleDigestForPeriod keeps Telegram aggregate and Substack articles isolated and ordered", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("digest-service-mixed@example.com"),
    );
    const telegramSourceId = await createSourceForUser(
      database,
      user.id,
      ConnectorId.Telegram,
      1,
    );
    const substackSourceId = await createSourceForUser(
      database,
      user.id,
      ConnectorId.Substack,
      2,
    );
    const telegramFeed = await createFeedForSource(
      database,
      user.id,
      telegramSourceId,
      1,
      "channel:mixed",
      "Telegram",
    );
    const substackFeed = await createFeedForSource(
      database,
      user.id,
      substackSourceId,
      1,
      "https://writer.substack.com",
      "Writer",
    );
    await upsertItems(database, telegramFeed.id, [
      normalizedItem(telegramFeed.externalId, "telegram-1", "telegram text"),
    ], 1);
    await upsertItems(database, substackFeed.id, [
      normalizedItem(
        substackFeed.externalId,
        "article-1",
        "first text",
        ConnectorId.Substack,
        {
          title: "First ] article\\\ncontinued",
          date: periodStartMs + 1_000,
          url: "https://writer.substack.com/p/first) draft",
          meta: { contentAccess: "preview" },
        },
      ),
      normalizedItem(
        substackFeed.externalId,
        "article-2",
        "",
        ConnectorId.Substack,
        {
          title: "Second article",
          date: periodStartMs + 2_000,
          url: null,
          meta: { contentAccess: "full" },
        },
      ),
    ], 1);

    const view = await assembleDigestForPeriod(
      database,
      user.id,
      periodStartMs,
      periodEndMs,
      {
        ...discardLogRecorder,
        summarizer: new FakeSummarizer([
          [{ text: "telegram point", sourceUrl: null }],
          [{ text: "first point", sourceUrl: null }],
        ]),
        summarizationConcurrency: 1,
        now: () => 120,
      },
    );

    assertEquals(view.sections.map((section) => section.content.kind), [
      "aggregate",
      "articles",
    ]);
    assertEquals(view.sections[0].content, {
      kind: "aggregate",
      points: [{ text: "telegram point", sourceUrl: null }],
    });
    assertEquals(view.sections[1].content, {
      kind: "articles",
      articles: [
        {
          sourceExternalId: "article-1",
          title: "First ] article\\\ncontinued",
          sourceUrl: "https://writer.substack.com/p/first) draft",
          publishedAt: periodStartMs + 1_000,
          contentAccess: "preview",
          points: [{ text: "first point", sourceUrl: null }],
        },
        {
          sourceExternalId: "article-2",
          title: "Second article",
          sourceUrl: null,
          publishedAt: periodStartMs + 2_000,
          contentAccess: "full",
          points: [],
        },
      ],
    });

    const markdown = renderDigestMarkdown(view);
    const firstHeading = markdown.indexOf(
      "#### [First \\] article\\\\ continued](<https://writer.substack.com/p/first)%20draft>)",
    );
    const firstPoint = markdown.indexOf("- first point");
    const secondHeading = markdown.indexOf("#### Second article");
    assertEquals(
      firstHeading >= 0 && firstHeading < firstPoint &&
        firstPoint < secondHeading,
      true,
    );
    assertEquals(markdown.match(/^#### /gm)?.length, 2);
    assertEquals(markdown.includes("continued\n"), false);
    assertEquals(markdown.includes("Preview"), true);
    assertEquals(markdown.includes("- Nothing to report."), true);
    assertEquals(markdown.includes("- telegram point"), true);
  });
});

test("renderDigestMarkdown displays an explicit empty article collection", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("digest-service-no-articles@example.com"),
    );
    const sourceId = await createSourceForUser(
      database,
      user.id,
      ConnectorId.Substack,
      1,
    );
    const feed = await createFeedForSource(
      database,
      user.id,
      sourceId,
      1,
      "https://empty.substack.com",
      "Empty",
    );
    await upsertSummaryForPeriod(database, {
      feedId: feed.id,
      periodStartMs,
      periodEndMs,
      content: { kind: "articles", articles: [] },
      feedNameSnapshot: feed.name,
    });
    const digest = await assembleDigestForPeriod(
      database,
      user.id,
      periodStartMs,
      periodEndMs,
      { ...discardLogRecorder },
    );
    assertEquals(renderDigestMarkdown(digest).includes("No articles."), true);
  });
});

test("assembleDigestForPeriod partitions paid posts by source preference while preserving section and paid ordering", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("digest-service-paid-partition@example.com"),
    );
    const sourceId = await createSourceForUser(
      database,
      user.id,
      ConnectorId.Substack,
      1,
    );
    const paidOnlyFeed = await createFeedForSource(
      database,
      user.id,
      sourceId,
      1,
      "https://paid-only.substack.com",
      "Paid ] only",
    );
    const emptyFeed = await createFeedForSource(
      database,
      user.id,
      sourceId,
      2,
      "https://empty-paid.substack.com",
      "Genuinely empty",
    );
    const mixedFeed = await createFeedForSource(
      database,
      user.id,
      sourceId,
      3,
      "https://mixed-paid.substack.com",
      "Mixed",
    );
    await upsertItems(database, paidOnlyFeed.id, [
      normalizedItem(
        paidOnlyFeed.externalId,
        "paid-1",
        "Paid article text",
        ConnectorId.Substack,
        { author: "  Writer [One]  " },
      ),
      normalizedItem(
        paidOnlyFeed.externalId,
        "paid-2",
        "Paid article text",
        ConnectorId.Substack,
        { author: "   " },
      ),
    ], 1);

    await upsertSummaryForPeriod(database, {
      feedId: paidOnlyFeed.id,
      periodStartMs,
      periodEndMs,
      feedNameSnapshot: paidOnlyFeed.name,
      content: {
        kind: "articles",
        articles: [
          {
            sourceExternalId: "paid-1",
            title: "First paid",
            sourceUrl: "https://paid-only.substack.com/p/first) draft",
            publishedAt: periodStartMs + 1,
            contentAccess: "paid",
            points: [],
          },
          {
            sourceExternalId: "paid-2",
            title: "Unsafe ] paid",
            sourceUrl: "javascript:alert(1)",
            publishedAt: periodStartMs + 2,
            contentAccess: "paid",
            points: [],
          },
        ],
      },
    });
    await upsertSummaryForPeriod(database, {
      feedId: emptyFeed.id,
      periodStartMs,
      periodEndMs,
      feedNameSnapshot: emptyFeed.name,
      content: { kind: "articles", articles: [] },
    });
    await upsertSummaryForPeriod(database, {
      feedId: mixedFeed.id,
      periodStartMs,
      periodEndMs,
      feedNameSnapshot: mixedFeed.name,
      content: {
        kind: "articles",
        articles: [
          {
            sourceExternalId: "free",
            title: "Free article",
            sourceUrl: null,
            publishedAt: periodStartMs + 3,
            contentAccess: "full",
            points: [{ text: "Free point", sourceUrl: null }],
          },
          {
            sourceExternalId: "paid-3",
            title: "Third paid",
            sourceUrl: null,
            publishedAt: periodStartMs + 4,
            contentAccess: "paid",
            points: [],
          },
        ],
      },
    });

    const optedOutView = await assembleDigestForPeriod(
      database,
      user.id,
      periodStartMs,
      periodEndMs,
      { ...discardLogRecorder },
    );
    assertEquals(optedOutView.paidPosts, []);
    assertEquals(optedOutView.sections.map((section) => section.feedName), [
      "Genuinely empty",
      "Mixed",
    ]);
    assertEquals(
      renderDigestMarkdown(optedOutView).includes("First paid"),
      false,
    );

    await updateSource(database, sourceId, user.id, {
      showPaidPostTitles: true,
    });

    const view = await assembleDigestForPeriod(
      database,
      user.id,
      periodStartMs,
      periodEndMs,
      { ...discardLogRecorder },
    );

    assertEquals(view.sections.map((section) => section.feedName), [
      "Genuinely empty",
      "Mixed",
    ]);
    assertEquals(view.sections[0].content, {
      kind: "articles",
      articles: [],
    });
    assertEquals(view.sections[1].content, {
      kind: "articles",
      articles: [{
        sourceExternalId: "free",
        title: "Free article",
        sourceUrl: null,
        publishedAt: periodStartMs + 3,
        contentAccess: "full",
        points: [{ text: "Free point", sourceUrl: null }],
      }],
    });
    assertEquals(view.paidPosts, [
      {
        newsletterName: "Paid ] only",
        title: "First paid",
        sourceUrl: "https://paid-only.substack.com/p/first) draft",
        publishedAt: periodStartMs + 1,
      },
      {
        newsletterName: "Paid ] only",
        title: "Unsafe ] paid",
        sourceUrl: "javascript:alert(1)",
        publishedAt: periodStartMs + 2,
      },
      {
        newsletterName: "Mixed",
        title: "Third paid",
        sourceUrl: null,
        publishedAt: periodStartMs + 4,
      },
    ]);

    const markdown = renderDigestMarkdown(view);
    const paidHeading = markdown.indexOf("## Paid posts");
    const paidMarkdown = markdown.slice(paidHeading);
    const paidOnlyHeading = markdown.indexOf("### Paid \\] only");
    const firstPaid = markdown.indexOf(
      "- [First paid](<https://paid-only.substack.com/p/first)%20draft>)",
    );
    const unsafePaid = markdown.indexOf("- Unsafe \\] paid");
    const mixedHeading = markdown.indexOf("### Mixed", unsafePaid);
    const thirdPaid = markdown.indexOf("- Third paid");
    assertEquals(paidHeading > markdown.indexOf("Free point"), true);
    assertEquals(paidHeading < paidOnlyHeading, true);
    assertEquals(paidOnlyHeading < firstPaid, true);
    assertEquals(firstPaid < unsafePaid, true);
    assertEquals(unsafePaid < mixedHeading, true);
    assertEquals(mixedHeading < thirdPaid, true);
    assertEquals(paidMarkdown.match(/^### Paid \\] only$/gm)?.length, 1);
    assertEquals(paidMarkdown.match(/^### Mixed$/gm)?.length, 1);
    assertEquals(markdown.includes("javascript:alert"), false);
    assertEquals(markdown.includes("Writer"), false);
    assertEquals(markdown.includes("- Paid \\] only --"), false);
    assertEquals(markdown.includes("- Mixed --"), false);
    assertEquals(markdown.includes("### Genuinely empty"), true);
    assertEquals(markdown.includes("No articles."), true);
  });
});
test("assembleDigestForPeriod records cancellation as a feed failure without persisting a section", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("digest-service-cancelled@example.com"),
    );
    const sourceId = await createSourceForUser(
      database,
      user.id,
      ConnectorId.Substack,
      1,
    );
    const feed = await createFeedForSource(
      database,
      user.id,
      sourceId,
      1,
      "https://cancelled.substack.com",
      "Cancelled",
    );
    await upsertItems(database, feed.id, [
      normalizedItem(
        feed.externalId,
        "cancelled-1",
        "article text",
        ConnectorId.Substack,
        {
          title: "Cancelled article",
          meta: { contentAccess: "full" },
        },
      ),
    ], 1);
    const controller = new AbortController();
    controller.abort(new DOMException("Digest cancelled", "AbortError"));

    const view = await assembleDigestForPeriod(
      database,
      user.id,
      periodStartMs,
      periodEndMs,
      {
        ...discardLogRecorder,
        summarizer: new FakeSummarizer([[{
          text: "must not persist",
          sourceUrl: null,
        }]]),
        signal: controller.signal,
      },
    );

    assertEquals(view.digest.status, "failed");
    assertEquals(view.sections, []);
  });
});

test("buildDigestViewById hides only explicit-false paid Substack evidence", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("digest-service-stale-paid@example.com"),
    );
    const sourceId = await createSourceForUser(
      database,
      user.id,
      ConnectorId.Substack,
      0,
    );
    const feed = await createFeedForSource(
      database,
      user.id,
      sourceId,
      0,
      "https://access.substack.com",
      "Access",
    );
    await upsertItems(database, feed.id, [
      normalizedItem(
        feed.externalId,
        "legacy",
        "Teaser",
        ConnectorId.Substack,
        {
          date: periodStartMs + 1,
          meta: { audience: "only_paid" },
        },
      ),
      normalizedItem(feed.externalId, "free", "Teaser", ConnectorId.Substack, {
        date: periodStartMs + 2,
        meta: { audience: "only_paid", hasPaidSubscription: false },
      }),
      normalizedItem(feed.externalId, "paid", "Full", ConnectorId.Substack, {
        date: periodStartMs + 3,
        meta: { audience: "only_paid", hasPaidSubscription: true },
      }),
      normalizedItem(
        feed.externalId,
        "ordinary",
        "Full",
        ConnectorId.Substack,
        {
          date: periodStartMs + 4,
          meta: { audience: "everyone" },
        },
      ),
      normalizedItem(
        feed.externalId,
        "non-substack",
        "Full",
        ConnectorId.Telegram,
        {
          date: periodStartMs + 5,
          meta: { audience: "only_paid", hasPaidSubscription: false },
        },
      ),
    ]);
    await upsertSummaryForPeriod(database, {
      feedId: feed.id,
      periodStartMs,
      periodEndMs,
      feedNameSnapshot: feed.name,
      content: {
        kind: "articles",
        articles: ["legacy", "free", "paid", "ordinary", "non-substack"].map((
          id,
          index,
        ) => ({
          sourceExternalId: id,
          title: id,
          sourceUrl: null,
          publishedAt: periodStartMs + index + 1,
          contentAccess: "full" as const,
          points: [{ text: `stale-${id}`, sourceUrl: null }],
        })),
      },
    });
    const digest = await assembleDigestForPeriod(
      database,
      user.id,
      periodStartMs,
      periodEndMs,
      { ...discardLogRecorder },
    );

    assertEquals(
      digest.sections[0].content.kind === "articles"
        ? digest.sections[0].content.articles.map((article) => article.title)
        : [],
      ["legacy", "paid", "ordinary", "non-substack"],
    );
    assertEquals(digest.paidPosts, []);
    const markdown = renderDigestMarkdown(digest);
    assertEquals(markdown.includes("stale-legacy"), true);
    assertEquals(markdown.includes("stale-paid"), true);
    assertEquals(markdown.includes("stale-free"), false);

    await updateSource(database, sourceId, user.id, {
      showPaidPostTitles: true,
    });
    const optedIn = await buildDigestViewById(
      database,
      user.id,
      digest.digest.id,
    );
    assertEquals(optedIn.paidPosts.map((post) => post.title), ["free"]);
    assertEquals(
      optedIn.sections[0].content.kind === "articles"
        ? optedIn.sections[0].content.articles.map((article) => article.title)
        : [],
      ["legacy", "paid", "ordinary", "non-substack"],
    );
  });
});
