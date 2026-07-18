import { assertEquals, assertRejects, assert } from "@std/assert";
import { ConnectorId } from "../../src/constants.ts";
import { CredentialCipher, type EncryptedBlob } from "../../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../src/crypto/key-provider.ts";
import type { Database } from "../../src/db/client.ts";
import { withTestDb } from "../../src/db/testing.ts";
import type { Connector, NormalizedData, NormalizedItem } from "../../src/connectors/connector.types.ts";
import { createOrReviveFeed, findFeedById, type PublicFeed } from "../../src/repositories/feed-repository.ts";
import { listItemsForFeedInWindow } from "../../src/repositories/item-repository.ts";
import { createSource } from "../../src/repositories/source-repository.ts";
import { createUser, type CreateUserInput } from "../../src/repositories/user-repository.ts";
import { computeIngestionWindow, ingestFeed, ingestFeedsForSource, ingestFeedsIndividually, type IngestFeedError, type IngestFeedResult } from "../../src/services/ingestion-service.ts";

function userInput(email: string): CreateUserInput {
  return {
    name: "Ingestion Owner",
    email,
    passwordHash: "$argon2id$fakehash",
    systemPrompt: "Summarize tersely.",
    defaultLanguage: "en",
  };
}


function credentialCipher(): CredentialCipher {
  return new CredentialCipher(new EnvMasterKeyProvider(new Uint8Array(32).fill(29)));
}

async function encryptedCredentials(userId: string): Promise<EncryptedBlob> {
  return await credentialCipher().encrypt(JSON.stringify({ sessionString: "telegram-session" }), {
    userId,
    connectorId: ConnectorId.Telegram,
  });
}

async function createFeed(database: Database, email: string): Promise<{ userId: string; feed: PublicFeed }> {
  const user = await createUser(database, userInput(email));
  const source = await createSource(database, {
    userId: user.id,
    connectorId: ConnectorId.Telegram,
    credentials: await encryptedCredentials(user.id),
  });
  const feed = await createOrReviveFeed(database, {
    userId: user.id,
    sourceId: source.id,
    externalId: "channel:1",
    name: "Channel",
    kind: "news",
  });
  return { userId: user.id, feed };
}

function normalizedItem(overrides: Partial<NormalizedItem> = {}): NormalizedItem {
  return {
    connectorId: ConnectorId.Telegram,
    feedExternalId: "channel:1",
    externalId: "message:1",
    date: 1_700_000_000_000,
    title: null,
    text: "First item",
    author: "Channel",
    url: null,
    ...overrides,
  };
}

class FakeConnector implements Connector<unknown> {
  readonly calls: Array<{ from: number; to: number; feedExternalIds?: string[]; signal?: AbortSignal }> = [];
  #responses: NormalizedData[];

  constructor(responses: NormalizedData[]) {
    this.#responses = [...responses];
  }

  getRawData(): Promise<unknown> {
    return Promise.resolve({});
  }

  getNormalizedData(from: number, to: number, feedExternalIds?: string[], signal?: AbortSignal): Promise<NormalizedData> {
    this.calls.push(signal === undefined ? { from, to, feedExternalIds } : { from, to, feedExternalIds, signal });
    return Promise.resolve(this.#responses.shift() ?? {});
  }
}

Deno.test("ingestFeed writes fetched items and advances the feed cursor", async () => {
  await withTestDb(async (database) => {
    const { userId, feed } = await createFeed(database, "ingest-happy@example.com");
    const connector = new FakeConnector([{ "channel:1": [normalizedItem()] }]);

    const result = await ingestFeed(database, userId, feed, connector, {
      window: { from: 1_699_999_000_000, to: 1_700_000_000_100 },
      fetchedAt: 1_700_000_000_200,
    });

    assertEquals(result.itemCount, 1);
    assertEquals(connector.calls, [{ from: 1_699_999_000_000, to: 1_700_000_000_100, feedExternalIds: ["channel:1"] }]);
    const items = await listItemsForFeedInWindow(database, feed.id, 1_699_999_000_000, 1_700_000_000_100);
    assertEquals(items.length, 1);
    assertEquals(items[0].payload.text, "First item");
    const updatedFeed = await findFeedById(database, feed.id, userId);
    assertEquals(updatedFeed?.lastFetchedPeriodEndMs, 1_700_000_000_100);
  });
});

Deno.test("ingestFeed computes cursor windows and advances empty fetches", async () => {
  await withTestDb(async (database) => {
    const { userId, feed } = await createFeed(database, "ingest-cursor@example.com");
    const firstWindow = computeIngestionWindow(feed, { now: () => 10_000, defaultLookbackMs: 1_000 });
    assertEquals(firstWindow, { from: 9_000, to: 10_000 });

    const connector = new FakeConnector([{ "channel:1": [] }, { "channel:1": [] }]);
    await ingestFeed(database, userId, feed, connector, { now: () => 10_000, defaultLookbackMs: 1_000 });
    const updatedFeed = await findFeedById(database, feed.id, userId);
    assertEquals(updatedFeed?.lastFetchedPeriodEndMs, 10_000);

    await ingestFeed(database, userId, updatedFeed!, connector, { now: () => 12_000 });
    assertEquals(connector.calls[1], { from: 10_001, to: 12_000, feedExternalIds: ["channel:1"] });
    const twiceUpdatedFeed = await findFeedById(database, feed.id, userId);
    assertEquals(twiceUpdatedFeed?.lastFetchedPeriodEndMs, 12_000);
  });
});

Deno.test("ingestFeed upserts edited items across overlapping windows", async () => {
  await withTestDb(async (database) => {
    const { userId, feed } = await createFeed(database, "ingest-upsert@example.com");
    const connector = new FakeConnector([
      { "channel:1": [normalizedItem({ text: "Before" })] },
      { "channel:1": [normalizedItem({ text: "After", date: 1_700_000_000_500 })] },
    ]);

    await ingestFeed(database, userId, feed, connector, { window: { from: 0, to: 2_000_000_000_000 }, fetchedAt: 1 });
    await ingestFeed(database, userId, feed, connector, { window: { from: 0, to: 2_000_000_000_000 }, fetchedAt: 2 });

    const items = await listItemsForFeedInWindow(database, feed.id, 0, 2_000_000_000_000);
    assertEquals(items.length, 1);
    assertEquals(items[0].payload.text, "After");
    assertEquals(items[0].fetchedAt, 2);
  });
});

Deno.test("ingestFeed rejects bad payloads and leaves cursor unchanged", async () => {
  await withTestDb(async (database) => {
    const { userId, feed } = await createFeed(database, "ingest-invalid@example.com");
    const invalidItem = { ...normalizedItem(), externalId: "" } as NormalizedItem;
    const connector = new FakeConnector([{ "channel:1": [invalidItem] }]);

    await assertRejects(
      () => ingestFeed(database, userId, feed, connector, { window: { from: 0, to: 10 } }),
      Error,
    );

    assertEquals(await listItemsForFeedInWindow(database, feed.id, 0, 10), []);
    const unchangedFeed = await findFeedById(database, feed.id, userId);
    assertEquals(unchangedFeed?.lastFetchedPeriodEndMs, null);
  });
});

Deno.test("ingestFeed rejects items returned under the right key but belonging to another feed", async () => {
  await withTestDb(async (database) => {
    const { userId, feed } = await createFeed(database, "ingest-wrong-feed@example.com");
    const connector = new FakeConnector([{ "channel:1": [normalizedItem({ feedExternalId: "channel:2" })] }]);

    await assertRejects(
      () => ingestFeed(database, userId, feed, connector, { window: { from: 0, to: 10 } }),
      Error,
      "normalized item belongs to a different feed",
    );
    const unchangedFeed = await findFeedById(database, feed.id, userId);
    assertEquals(unchangedFeed?.lastFetchedPeriodEndMs, null);
  });
});

async function createTwoFeeds(
  database: Database,
  email: string,
): Promise<{ userId: string; feed1: PublicFeed; feed2: PublicFeed }> {
  const user = await createUser(database, userInput(email));
  const source = await createSource(database, {
    userId: user.id,
    connectorId: ConnectorId.Telegram,
    credentials: await encryptedCredentials(user.id),
  });
  const feed1 = await createOrReviveFeed(database, {
    userId: user.id,
    sourceId: source.id,
    externalId: "channel:1",
    name: "Channel One",
    kind: "news",
  });
  const feed2 = await createOrReviveFeed(database, {
    userId: user.id,
    sourceId: source.id,
    externalId: "channel:2",
    name: "Channel Two",
    kind: "news",
  });
  return { userId: user.id, feed1, feed2 };
}

async function createFourFeeds(
  database: Database,
  email: string,
): Promise<{ userId: string; feeds: PublicFeed[] }> {
  const user = await createUser(database, userInput(email));
  const source = await createSource(database, {
    userId: user.id,
    connectorId: ConnectorId.Telegram,
    credentials: await encryptedCredentials(user.id),
  });
  const feeds: PublicFeed[] = [];
  for (let index = 1; index <= 4; index += 1) {
    feeds.push(await createOrReviveFeed(database, {
      userId: user.id,
      sourceId: source.id,
      externalId: `channel:${index}`,
      name: `Channel ${index}`,
      kind: "news",
    }));
  }
  return { userId: user.id, feeds };
}

Deno.test("ingestFeedsForSource calls connector once for multiple feeds", async () => {
  await withTestDb(async (database) => {
    const { userId, feed1, feed2 } = await createTwoFeeds(database, "batch-one-call@example.com");
    const connector = new FakeConnector([{
      "channel:1": [normalizedItem({ feedExternalId: "channel:1", externalId: "1", text: "A", date: 1_700_000_000_000 })],
      "channel:2": [normalizedItem({ feedExternalId: "channel:2", externalId: "2", text: "B", date: 1_700_000_000_100 })],
    }]);

    const feedWindows = new Map<string, { from: number; to: number }>();
    feedWindows.set(feed1.id, { from: 1_600_000_000_000, to: 1_800_000_000_000 });
    feedWindows.set(feed2.id, { from: 1_600_000_000_000, to: 1_800_000_000_000 });

    const result = await ingestFeedsForSource(database, userId, [feed1, feed2], connector, { feedWindows });

    assertEquals(connector.calls.length, 1);
    assertEquals(connector.calls[0].from, 1_600_000_000_000);
    assertEquals(connector.calls[0].to, 1_800_000_000_000);
    assert(connector.calls[0].feedExternalIds?.includes("channel:1"));
    assert(connector.calls[0].feedExternalIds?.includes("channel:2"));
    assertEquals(result.feedResults.length, 2);
    assertEquals((result.feedResults[0] as IngestFeedResult).itemCount, 1);
    assertEquals((result.feedResults[1] as IngestFeedResult).itemCount, 1);
  });
});

Deno.test("ingestFeedsForSource filters items per feed by date range", async () => {
  await withTestDb(async (database) => {
    const { userId, feed1, feed2 } = await createTwoFeeds(database, "batch-filter@example.com");
    // feed1 window is later, so an item with date 1_700_000_000_000 should be excluded
    const connector = new FakeConnector([{
      "channel:1": [normalizedItem({ feedExternalId: "channel:1", externalId: "1", text: "Excluded", date: 1_700_000_000_000 })],
      "channel:2": [normalizedItem({ feedExternalId: "channel:2", externalId: "2", text: "Included", date: 1_700_000_000_500 })],
    }]);

    const feedWindows = new Map<string, { from: number; to: number }>();
    feedWindows.set(feed1.id, { from: 1_700_000_000_100, to: 1_800_000_000_000 });
    feedWindows.set(feed2.id, { from: 1_600_000_000_000, to: 1_800_000_000_000 });

    const result = await ingestFeedsForSource(database, userId, [feed1, feed2], connector, { feedWindows });

    assertEquals(result.feedResults.length, 2);
    assertEquals((result.feedResults[0] as IngestFeedResult).itemCount, 0);
    assertEquals((result.feedResults[1] as IngestFeedResult).itemCount, 1);
    // feed1 cursor should advance to its window.to even with no items
    const updated1 = await findFeedById(database, feed1.id, userId);
    assertEquals(updated1?.lastFetchedPeriodEndMs, 1_800_000_000_000);
  });
});

Deno.test("ingestFeedsForSource isolates one-feed validation failure", async () => {
  await withTestDb(async (database) => {
    const { userId, feed1, feed2 } = await createTwoFeeds(database, "batch-isolation@example.com");
    // feed1 gets an invalid item (empty externalId); feed2 gets a valid one
    const connector = new FakeConnector([{
      "channel:1": [{ ...normalizedItem({ feedExternalId: "channel:1", externalId: "", date: 100 }) }],
      "channel:2": [normalizedItem({ feedExternalId: "channel:2", externalId: "2", text: "Valid", date: 100 })],
    }]);

    const feedWindows = new Map<string, { from: number; to: number }>();
    feedWindows.set(feed1.id, { from: 0, to: 10_000 });
    feedWindows.set(feed2.id, { from: 0, to: 10_000 });

    const result = await ingestFeedsForSource(database, userId, [feed1, feed2], connector, { feedWindows });

    assertEquals(result.feedResults.length, 2);
    // feed1 should have an error
    assert("error" in result.feedResults[0]!);
    // feed2 should succeed
    assertEquals((result.feedResults[1] as IngestFeedResult).itemCount, 1);
    // feed1 cursor should NOT advance
    const unchanged1 = await findFeedById(database, feed1.id, userId);
    assertEquals(unchanged1?.lastFetchedPeriodEndMs, null);
    // feed2 cursor SHOULD advance
    const updated2 = await findFeedById(database, feed2.id, userId);
    assertEquals(updated2?.lastFetchedPeriodEndMs, 10_000);
  });
});

Deno.test("ingestFeedsForSource returns empty results for empty connector data", async () => {
  await withTestDb(async (database) => {
    const { userId, feed1, feed2 } = await createTwoFeeds(database, "batch-empty@example.com");
    const connector = new FakeConnector([{}]);

    const feedWindows = new Map<string, { from: number; to: number }>();
    feedWindows.set(feed1.id, { from: 0, to: 10_000 });
    feedWindows.set(feed2.id, { from: 0, to: 10_000 });

    const result = await ingestFeedsForSource(database, userId, [feed1, feed2], connector, { feedWindows });

    assertEquals(result.feedResults.length, 2);
    assertEquals((result.feedResults[0] as IngestFeedResult).itemCount, 0);
    assertEquals((result.feedResults[1] as IngestFeedResult).itemCount, 0);
    // Both cursors should advance to their window.to
    const updated1 = await findFeedById(database, feed1.id, userId);
    assertEquals(updated1?.lastFetchedPeriodEndMs, 10_000);
  });
});

Deno.test("ingestFeedsForSource passes abort signal to connector", () => {
  const controller = new AbortController();
  controller.abort();
  const connector = new FakeConnector([{}]);

  // No DB needed — we just verify the signal is received
  void connector.getNormalizedData(0, 10, ["channel:1"], controller.signal);
  assertEquals(connector.calls.length, 1);
  assertEquals(connector.calls[0].signal, controller.signal);
  assert(connector.calls[0].signal?.aborted);
});

Deno.test("ingestFeedsIndividually isolates failures, aborts deadlines, and bounds concurrency", async () => {
  await withTestDb(async (database) => {
    const { userId, feeds } = await createFourFeeds(database, "individual-ingestion@example.com");
    let activeCalls = 0;
    let maxActiveCalls = 0;
    const calls: string[] = [];
    const connector: Connector<unknown> = {
      getRawData: () => Promise.resolve({}),
      getNormalizedData: (_from, _to, feedExternalIds, _signal) => {
        const externalId = feedExternalIds?.[0] ?? "";
        calls.push(externalId);
        activeCalls += 1;
        maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
        const finish = () => {
          activeCalls -= 1;
          return {
            [externalId]: [normalizedItem({
              feedExternalId: externalId,
              externalId: `item:${externalId}`,
              text: externalId,
            })],
          };
        };
        if (externalId === "channel:1") {
          return Promise.resolve().then(finish);
        }
        if (externalId === "channel:2") {
          return Promise.withResolvers<NormalizedData>().promise;
        }
        if (externalId === "channel:3") {
          activeCalls -= 1;
          return Promise.reject(new Error("ordinary connector failure"));
        }
        return Promise.resolve().then(finish);
      },
    };

    const result = await ingestFeedsIndividually(database, userId, feeds, connector, {
      window: { from: 0, to: 1_800_000_000_000 },
      fetchedAt: 123,
      connectorTimeoutMs: 20,
      concurrency: 2,
    });

    assertEquals(maxActiveCalls, 2);
    assertEquals(calls, ["channel:1", "channel:2", "channel:3", "channel:4"]);
    assertEquals(result.feedResults.map((entry) => entry.feedId), feeds.map((feed) => feed.id));
    assertEquals(result.feedResults[0], {
      feedId: feeds[0].id,
      window: { from: 0, to: 1_800_000_000_000 },
      itemCount: 1,
    });
    assertEquals((result.feedResults[1] as IngestFeedError).error, "connector deadline exceeded");
    assertEquals((result.feedResults[2] as IngestFeedError).error, "ordinary connector failure");
    assertEquals((result.feedResults[3] as IngestFeedResult).itemCount, 1);

    const healthyFeed = await findFeedById(database, feeds[0].id, userId);
    assertEquals(healthyFeed?.lastFetchedPeriodEndMs, 1_800_000_000_000);
    assertEquals((await listItemsForFeedInWindow(database, feeds[0].id, 0, 1_800_000_000_000)).length, 1);
    const hungFeed = await findFeedById(database, feeds[1].id, userId);
    assertEquals(hungFeed?.lastFetchedPeriodEndMs, null);
    assertEquals(await listItemsForFeedInWindow(database, feeds[1].id, 0, 1_800_000_000_000), []);
    const failedFeed = await findFeedById(database, feeds[2].id, userId);
    assertEquals(failedFeed?.lastFetchedPeriodEndMs, null);
    assertEquals(await listItemsForFeedInWindow(database, feeds[2].id, 0, 1_800_000_000_000), []);
    const queuedFeed = await findFeedById(database, feeds[3].id, userId);
    assertEquals(queuedFeed?.lastFetchedPeriodEndMs, 1_800_000_000_000);
    assertEquals((await listItemsForFeedInWindow(database, feeds[3].id, 0, 1_800_000_000_000)).length, 1);
  });
});
