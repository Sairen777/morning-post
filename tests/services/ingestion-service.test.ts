import { assertEquals, assertRejects } from "@std/assert";
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
import { computeIngestionWindow, ingestFeed } from "../../src/services/ingestion-service.ts";

function userInput(email: string): CreateUserInput {
  return {
    name: "Ingestion Owner",
    email,
    passwordHash: "$argon2id$fakehash",
    systemPrompt: "Summarize tersely.",
    defaultLanguage: "en",
    defaultModel: "gpt-4o-mini",
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
  readonly calls: Array<{ from: number; to: number; feedExternalIds?: string[] }> = [];
  #responses: NormalizedData[];

  constructor(responses: NormalizedData[]) {
    this.#responses = [...responses];
  }

  getRawData(): Promise<unknown> {
    return Promise.resolve({});
  }

  getNormalizedData(from: number, to: number, feedExternalIds?: string[]): Promise<NormalizedData> {
    this.calls.push({ from, to, feedExternalIds });
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
