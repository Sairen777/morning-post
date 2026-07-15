import { assertEquals } from "@std/assert";
import { sql } from "drizzle-orm";
import { ConnectorId } from "../../src/constants.ts";
import { CredentialCipher, type EncryptedBlob } from "../../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../src/crypto/key-provider.ts";
import type { Database } from "../../src/db/client.ts";
import { withTestDb } from "../../src/db/testing.ts";
import type { NormalizedItem } from "../../src/connectors/connector.types.ts";
import { createOrReviveFeed, softDeleteFeed, updateFeed, type PublicFeed } from "../../src/repositories/feed-repository.ts";
import { upsertItems } from "../../src/repositories/item-repository.ts";
import { createDigestRun } from "../../src/repositories/digest-run-repository.ts";
import { upsertSummaryForPeriod } from "../../src/repositories/summary-repository.ts";
import { createSource } from "../../src/repositories/source-repository.ts";
import { createUser, type CreateUserInput } from "../../src/repositories/user-repository.ts";
import { assembleDigestForPeriod, buildDigestViewById, renderDigestMarkdown } from "../../src/services/digest-service.ts";
import type { SummarizeOptions, SummarizerService, SummaryPoint, SummaryRuleset } from "../../src/summarizers/summarizer.types.ts";

class FakeSummarizer implements SummarizerService {
  readonly calls: Array<{ items: NormalizedItem[]; rules: SummaryRuleset; options?: SummarizeOptions }> = [];
  #results: Array<SummaryPoint[] | Error>;

  constructor(results: Array<SummaryPoint[] | Error>) {
    this.#results = [...results];
  }

  summarize(items: NormalizedItem[], rules: SummaryRuleset, options?: SummarizeOptions): Promise<SummaryPoint[]> {
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
    defaultModel: "gpt-4o-mini",
  };
}

function credentialCipher(): CredentialCipher {
  return new CredentialCipher(new EnvMasterKeyProvider(new Uint8Array(32).fill(47)));
}

async function encryptedCredentials(userId: string, connectorId: ConnectorId): Promise<EncryptedBlob> {
  return await credentialCipher().encrypt(JSON.stringify({ sessionString: `${connectorId}-session` }), {
    userId,
    connectorId,
  });
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
  return enabled ? feed : await updateFeed(database, feed.id, userId, { enabled: false });
}

function normalizedItem(feedExternalId: string, externalId: string, text: string): NormalizedItem {
  return {
    connectorId: ConnectorId.Telegram,
    feedExternalId,
    externalId,
    date: 1_700_000_000_000,
    title: null,
    text,
    author: "Channel",
    url: null,
  };
}

const periodStartMs = 1_700_000_000_000;
const periodEndMs = 1_700_086_400_000;

Deno.test("assembleDigestForPeriod orders sections by source then feed position", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, userInput("digest-service-order@example.com"));
    const rssSourceId = await createSourceForUser(database, user.id, ConnectorId.RSS, 1);
    const telegramSourceId = await createSourceForUser(database, user.id, ConnectorId.Telegram, 2);
    const rssLaterFeed = await createFeedForSource(database, user.id, rssSourceId, 2, "rss:2", "RSS Two");
    const rssEarlierFeed = await createFeedForSource(database, user.id, rssSourceId, 1, "rss:1", "RSS One");
    const telegramFeed = await createFeedForSource(database, user.id, telegramSourceId, 1, "channel:1", "Telegram One");
    await upsertItems(database, rssLaterFeed.id, [normalizedItem(rssLaterFeed.externalId, "1", "rss-two")], 1);
    await upsertItems(database, rssEarlierFeed.id, [normalizedItem(rssEarlierFeed.externalId, "1", "rss-one")], 1);
    await upsertItems(database, telegramFeed.id, [normalizedItem(telegramFeed.externalId, "1", "telegram")], 1);

    const view = await assembleDigestForPeriod(database, user.id, periodStartMs, periodEndMs, {
      summarizer: new FakeSummarizer([
        [{ text: "rss-two", sourceUrl: null }],
        [{ text: "rss-one", sourceUrl: null }],
        [{ text: "telegram", sourceUrl: null }],
      ]),
      now: () => 50,
    });

    assertEquals(view.digest.status, "complete");
    assertEquals(view.sections.map((section) => section.feedName), ["RSS One", "RSS Two", "Telegram One"]);
    assertEquals(view.groups.map((group) => group.connectorId), [ConnectorId.RSS, ConnectorId.Telegram]);
  });
});

Deno.test("assembleDigestForPeriod excludes disabled feeds on fresh assembly but keeps historical deleted summaries on read", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, userInput("digest-service-deleted@example.com"));
    const telegramSourceId = await createSourceForUser(database, user.id, ConnectorId.Telegram, 1);
    const activeFeed = await createFeedForSource(database, user.id, telegramSourceId, 1, "channel:1", "Active Feed");
    const deletedFeed = await createFeedForSource(database, user.id, telegramSourceId, 2, "channel:2", "Deleted Feed");
    await upsertItems(database, activeFeed.id, [normalizedItem(activeFeed.externalId, "1", "active")], 1);
    await upsertItems(database, deletedFeed.id, [normalizedItem(deletedFeed.externalId, "1", "deleted")], 1);

    const firstDigest = await assembleDigestForPeriod(database, user.id, periodStartMs, periodEndMs, {
      summarizer: new FakeSummarizer([
        [{ text: "active", sourceUrl: null }],
        [{ text: "deleted", sourceUrl: null }],
      ]),
      now: () => 60,
    });
    assertEquals(firstDigest.sections.length, 2);

    await softDeleteFeed(database, deletedFeed.id, user.id);
    const secondDigest = await assembleDigestForPeriod(database, user.id, periodStartMs, periodEndMs, {
      summarizer: new FakeSummarizer([]),
      now: () => 61,
    });
    assertEquals(secondDigest.digest.id, firstDigest.digest.id);

    const historicalView = await buildDigestViewById(database, user.id, firstDigest.digest.id);
    assertEquals(historicalView.sections.map((section) => section.feedRemoved), [false, true]);
    assertEquals(historicalView.sections[1].feedName, "Deleted Feed");
  });
});

Deno.test("assembleDigestForPeriod marks partial failures as failed and keeps successful sections", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, userInput("digest-service-failure@example.com"));
    const telegramSourceId = await createSourceForUser(database, user.id, ConnectorId.Telegram, 1);
    const firstFeed = await createFeedForSource(database, user.id, telegramSourceId, 1, "channel:1", "First");
    const secondFeed = await createFeedForSource(database, user.id, telegramSourceId, 2, "channel:2", "Second");
    await upsertItems(database, firstFeed.id, [normalizedItem(firstFeed.externalId, "1", "first")], 1);
    await upsertItems(database, secondFeed.id, [normalizedItem(secondFeed.externalId, "1", "second")], 1);

    const view = await assembleDigestForPeriod(database, user.id, periodStartMs, periodEndMs, {
      summarizer: new FakeSummarizer([
        [{ text: "first summary", sourceUrl: null }],
        new Error("boom"),
      ]),
      now: () => 70,
    });

    assertEquals(view.digest.status, "failed");
    assertEquals(view.sections.map((section) => section.feedName), ["First"]);
  });
});

Deno.test("assembleDigestForPeriod is idempotent and reuses cached summaries", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, userInput("digest-service-idempotent@example.com"));
    const telegramSourceId = await createSourceForUser(database, user.id, ConnectorId.Telegram, 1);
    const feed = await createFeedForSource(database, user.id, telegramSourceId, 1, "channel:1", "Only Feed");
    await upsertItems(database, feed.id, [normalizedItem(feed.externalId, "1", "only")], 1);
    const summarizer = new FakeSummarizer([[{ text: "once", sourceUrl: null }]]);

    const first = await assembleDigestForPeriod(database, user.id, periodStartMs, periodEndMs, { summarizer, now: () => 80 });
    const second = await assembleDigestForPeriod(database, user.id, periodStartMs, periodEndMs, { summarizer, now: () => 81 });

    assertEquals(first.digest.id, second.digest.id);
    assertEquals(summarizer.calls.length, 1);
  });
});

Deno.test("renderDigestMarkdown includes ordered source groups and removed marker", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, userInput("digest-service-markdown@example.com"));
    const telegramSourceId = await createSourceForUser(database, user.id, ConnectorId.Telegram, 1);
    const feed = await createFeedForSource(database, user.id, telegramSourceId, 1, "channel:1", "Markdown Feed");
    await upsertItems(database, feed.id, [normalizedItem(feed.externalId, "1", "markdown")], 1);

    const digest = await assembleDigestForPeriod(database, user.id, periodStartMs, periodEndMs, {
      summarizer: new FakeSummarizer([[{ text: "markdown bullet", sourceUrl: null }]]),
      now: () => 90,
    });
    await softDeleteFeed(database, feed.id, user.id);
    const historicalView = await buildDigestViewById(database, user.id, digest.digest.id);

    const markdown = renderDigestMarkdown(historicalView);
    assertEquals(markdown.includes("## Telegram"), true);
    assertEquals(markdown.includes("### Markdown Feed (removed)"), true);
    assertEquals(markdown.includes("- markdown bullet"), true);
  });
});

Deno.test("assembleDigestForPeriod batches cached summaries and only summarizes missing feeds", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, userInput("digest-service-batch@example.com"));
    const telegramSourceId = await createSourceForUser(database, user.id, ConnectorId.Telegram, 1);
    const feedA = await createFeedForSource(database, user.id, telegramSourceId, 1, "channel:1", "Feed A");
    const feedB = await createFeedForSource(database, user.id, telegramSourceId, 2, "channel:2", "Feed B");

    await upsertSummaryForPeriod(database, {
      feedId: feedA.id,
      periodStartMs,
      periodEndMs,
      points: [{ text: "cached point", sourceUrl: null }],
      feedNameSnapshot: feedA.name,
    });
    await upsertItems(database, feedB.id, [normalizedItem(feedB.externalId, "1", "fresh")], 1);

    const fakeSummarizer = new FakeSummarizer([[{ text: "fresh point", sourceUrl: null }]]);

    const view = await assembleDigestForPeriod(database, user.id, periodStartMs, periodEndMs, {
      summarizer: fakeSummarizer,
      now: () => 100,
    });

    assertEquals(fakeSummarizer.calls.length, 1);
    assertEquals(view.sections.length, 2);

    const sectionA = view.sections.find((section) => section.feedId === feedA.id)!;
    const sectionB = view.sections.find((section) => section.feedId === feedB.id)!;

    assertEquals(sectionA.points, [{ text: "cached point", sourceUrl: null }]);
    assertEquals(sectionB.points, [{ text: "fresh point", sourceUrl: null }]);
  });
});

Deno.test("assembleDigestForPeriod keeps source groups contiguous when positions tie", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, userInput("digest-service-contiguous@example.com"));
    const sourceAId = await createSourceForUser(database, user.id, ConnectorId.Telegram, 1);
    const sourceBId = await createSourceForUser(database, user.id, ConnectorId.RSS, 1);

    const feedA1 = await createFeedForSource(database, user.id, sourceAId, 1, "channel:a1", "Alpha");
    const feedA2 = await createFeedForSource(database, user.id, sourceAId, 2, "channel:a2", "Beta");
    const feedB1 = await createFeedForSource(database, user.id, sourceBId, 1, "rss:b1", "Gamma");
    const feedB2 = await createFeedForSource(database, user.id, sourceBId, 2, "rss:b2", "Delta");

    await upsertItems(database, feedA1.id, [normalizedItem(feedA1.externalId, "1", "alpha")], 1);
    await upsertItems(database, feedA2.id, [normalizedItem(feedA2.externalId, "1", "beta")], 1);
    await upsertItems(database, feedB1.id, [normalizedItem(feedB1.externalId, "1", "gamma")], 1);
    await upsertItems(database, feedB2.id, [normalizedItem(feedB2.externalId, "1", "delta")], 1);

    const view = await assembleDigestForPeriod(database, user.id, periodStartMs, periodEndMs, {
      summarizer: new FakeSummarizer([[], [], [], []]),
    });

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

Deno.test("assembleDigestForPeriod records summarization failures in digest_run_feeds when runId is supplied", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, userInput("digest-service-run-failure@example.com"));
    const telegramSourceId = await createSourceForUser(database, user.id, ConnectorId.Telegram, 1);
    const feed = await createFeedForSource(database, user.id, telegramSourceId, 1, "channel:boom", "Boom Feed");
    await upsertItems(database, feed.id, [normalizedItem(feed.externalId, "1", "boom text")], 1);

    const digestRun = await createDigestRun(database, {
      userId: user.id,
      trigger: "manual",
      periodStartMs,
      periodEndMs,
      status: "running",
    });

    const sourceConnectorIdsBySourceId = new Map([[telegramSourceId, ConnectorId.Telegram]]);

    const view = await assembleDigestForPeriod(database, user.id, periodStartMs, periodEndMs, {
      summarizer: new FakeSummarizer([
        new Error(
          "summarizer failed with sk-live-secret and https://alice:password@example.com/path",
        ),
      ]),
      runId: digestRun.id,
      sourceConnectorIdsBySourceId,
    });

    assertEquals(view.digest.status, "failed");

    const feedRows: Array<Record<string, unknown>> = await database.execute(
      sql`select * from digest_run_feeds where run_id = ${digestRun.id}`,
    );
    const failedSummarizationRows = feedRows.filter(
      (r) => r.stage === "summarization" && r.status === "failed" && r.error_message !== null,
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

Deno.test("assembleDigestForPeriod respects summarizationConcurrency=2 with bounded parallelism", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, userInput("concurrency-2-test@example.com"));
    const sourceId = await createSourceForUser(database, user.id, ConnectorId.Telegram, 1);
    const feed1 = await createFeedForSource(database, user.id, sourceId, 1, "channel:a", "Feed A");
    const feed2 = await createFeedForSource(database, user.id, sourceId, 2, "channel:b", "Feed B");
    const feed3 = await createFeedForSource(database, user.id, sourceId, 3, "channel:c", "Feed C");
    for (const feed of [feed1, feed2, feed3]) {
      await upsertItems(database, feed.id, [normalizedItem(feed.externalId, "1", "item text")], 1);
    }

    const counter = new ConcurrentCountingSummarizer();
    const view = await assembleDigestForPeriod(database, user.id, periodStartMs, periodEndMs, {
      summarizer: counter,
      summarizationConcurrency: 2,
    });

    assertEquals(view.digest.status, "complete", "digest should complete");
    assertEquals(view.sections.length, 3, "all 3 feeds should produce sections");
    assertEquals(counter.callCount, 3, "all 3 feeds should be summarized");
    // With concurrency=2 and 3 feeds, at most 2 should run concurrently
    assertEquals(counter.maxActive <= 2, true, `max concurrent should be ≤2, was ${counter.maxActive}`);
    // Ordering should be by position
    assertEquals(view.sections[0].feedId, feed1.id);
    assertEquals(view.sections[1].feedId, feed2.id);
    assertEquals(view.sections[2].feedId, feed3.id);
  });
});

Deno.test("assembleDigestForPeriod with concurrency=1 runs feeds sequentially", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, userInput("concurrency-1-test@example.com"));
    const sourceId = await createSourceForUser(database, user.id, ConnectorId.Telegram, 1);
    const feed1 = await createFeedForSource(database, user.id, sourceId, 1, "channel:x", "Feed X");
    const feed2 = await createFeedForSource(database, user.id, sourceId, 2, "channel:y", "Feed Y");
    for (const feed of [feed1, feed2]) {
      await upsertItems(database, feed.id, [normalizedItem(feed.externalId, "1", "item text")], 1);
    }

    const counter = new ConcurrentCountingSummarizer();
    const view = await assembleDigestForPeriod(database, user.id, periodStartMs, periodEndMs, {
      summarizer: counter,
      summarizationConcurrency: 1,
    });

    assertEquals(view.digest.status, "complete", "digest should complete");
    assertEquals(view.sections.length, 2, "both feeds should produce sections");
    assertEquals(counter.callCount, 2, "both feeds should be summarized");
    // With concurrency=1, feeds run sequentially
    assertEquals(counter.maxActive, 1, `max concurrent should be 1, was ${counter.maxActive}`);
    assertEquals(view.sections[0].feedId, feed1.id);
    assertEquals(view.sections[1].feedId, feed2.id);
  });
});

Deno.test("assembleDigestForPeriod with concurrent summarization isolates feed failures", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, userInput("concurrency-failure@example.com"));
    const sourceId = await createSourceForUser(database, user.id, ConnectorId.Telegram, 1);
    const feed1 = await createFeedForSource(database, user.id, sourceId, 1, "channel:good", "Good Feed");
    const feed2 = await createFeedForSource(database, user.id, sourceId, 2, "channel:bad", "Bad Feed");
    for (const feed of [feed1, feed2]) {
      await upsertItems(database, feed.id, [normalizedItem(feed.externalId, "1", "item text")], 1);
    }

    // Second summarizer call throws; first succeeds
    const failingSummarizer = new FakeSummarizer([
      [{ text: "good summary", sourceUrl: null }],
      new Error("bad feed error"),
    ]);

    const view = await assembleDigestForPeriod(database, user.id, periodStartMs, periodEndMs, {
      summarizer: failingSummarizer,
      summarizationConcurrency: 5,
    });

    // Digest marked failed because one feed failed
    assertEquals(view.digest.status, "failed");
    // The good feed's section is still present
    assertEquals(view.sections.length, 1, "only the successful feed should have a section");
    assertEquals(view.sections[0].feedId, feed1.id);
    assertEquals(view.sections[0].points[0].text, "good summary");
  });
});
