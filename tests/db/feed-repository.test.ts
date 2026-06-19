import { assert,
assertEquals,
assertExists,
assertRejects, } from "@std/assert"
import { eq } from "drizzle-orm";
import { ConnectorId } from "../../src/constants.ts";
import { CredentialCipher, type EncryptedBlob } from "../../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../src/crypto/key-provider.ts";
import { withTestDb } from "../../src/db/testing.ts";
import { feeds } from "../../src/db/schema/feed.ts";
import { credentialSchemaFor } from "../../src/connectors/credential-schemas.ts";
import {
  createOrReviveFeed,
  findFeedById,
  listFeedsForSource,
  listFeedsForUser,
  setLastFetched,
  softDeleteFeed,
  updateFeed,
  type CreateOrReviveFeedInput,
} from "../../src/repositories/feed-repository.ts";
import { createSource, deleteSourceCredentials } from "../../src/repositories/source-repository.ts";
import { createUser, type CreateUserInput } from "../../src/repositories/user-repository.ts";
import { ConflictError, NotFoundError } from "../../src/server/errors.ts";
import type { FeedKind } from "../../src/connectors/connector.types.ts";

const telegramCredentials = { sessionString: "telegram-session-secret-3.1" };

function userInput(email: string): CreateUserInput {
  return {
    name: "Feed Owner",
    email,
    passwordHash: "$argon2id$fakehash",
    systemPrompt: "Summarize tersely.",
    defaultLanguage: "en",
    defaultModel: "gpt-4o-mini",
  };
}

function deterministicCipher(): CredentialCipher {
  return new CredentialCipher(new EnvMasterKeyProvider(new Uint8Array(32).fill(7)));
}

async function encryptedTelegramCredentials(
  cipher: CredentialCipher,
  userId: string,
  connectorId: ConnectorId = ConnectorId.Telegram,
): Promise<EncryptedBlob> {
  const parsed = credentialSchemaFor(ConnectorId.Telegram).parse(telegramCredentials);
  return await cipher.encrypt(JSON.stringify(parsed), { userId, connectorId });
}

async function createOwnedSource(
  database: Parameters<typeof createSource>[0],
  email: string,
  connectorId: ConnectorId = ConnectorId.Telegram,
  position: number | null = null,
) {
  const cipher = deterministicCipher();
  const user = await createUser(database, userInput(email));
  const source = await createSource(database, {
    userId: user.id,
    connectorId,
    credentials: await encryptedTelegramCredentials(cipher, user.id, connectorId),
    position,
  });
  return { user, source };
}

function feedInput(
  userId: string,
  sourceId: string,
  overrides: Partial<CreateOrReviveFeedInput> = {},
): CreateOrReviveFeedInput {
  return {
    userId,
    sourceId,
    externalId: "channel-1",
    name: "Morning Channel",
    kind: "news",
    ...overrides,
  };
}

Deno.test("feed repository creates feeds and lists them by source then feed ordering", async () => {
  await withTestDb(async (database) => {
    const { user, source: telegram } = await createOwnedSource(
      database,
      "feed-list@example.com",
      ConnectorId.Telegram,
      2,
    );
    const rss = await createSource(database, {
      userId: user.id,
      connectorId: ConnectorId.RSS,
      credentials: await encryptedTelegramCredentials(deterministicCipher(), user.id, ConnectorId.RSS),
      position: 1,
    });

    const laterSourceFeed = await createOrReviveFeed(
      database,
      feedInput(user.id, telegram.id, { externalId: "telegram", name: "Zed", position: 1 }),
    );
    const secondFeed = await createOrReviveFeed(
      database,
      feedInput(user.id, rss.id, { externalId: "rss-b", name: "Bravo", position: 2 }),
    );
    const firstFeed = await createOrReviveFeed(
      database,
      feedInput(user.id, rss.id, { externalId: "rss-a", name: "Alpha", position: 1 }),
    );

    assertEquals(firstFeed.enabled, true);
    assertEquals(firstFeed.deletedAt, null);
    assertEquals(firstFeed.lastFetchedPeriodEndMs, null);
    assert(!("credentials" in firstFeed));

    const forUser = await listFeedsForUser(database, user.id);
    assertEquals(forUser.map((feed) => feed.id), [firstFeed.id, secondFeed.id, laterSourceFeed.id]);

    const forSource = await listFeedsForSource(database, rss.id, user.id);
    assertEquals(forSource.map((feed) => feed.id), [firstFeed.id, secondFeed.id]);
  });
});

Deno.test("softDeleteFeed hides feeds by default while preserving the row for history", async () => {
  await withTestDb(async (database) => {
    const { user, source } = await createOwnedSource(database, "feed-delete@example.com");
    const feed = await createOrReviveFeed(database, feedInput(user.id, source.id));

    const deleted = await softDeleteFeed(database, feed.id, user.id);
    assertEquals(deleted.enabled, false);
    assertExists(deleted.deletedAt);

    assertEquals(await listFeedsForUser(database, user.id), []);
    const withDeleted = await listFeedsForUser(database, user.id, { includeDeleted: true });
    assertEquals(withDeleted.length, 1);
    assertEquals(withDeleted[0].id, feed.id);
    assertEquals(withDeleted[0].deletedAt, deleted.deletedAt);
  });
});

Deno.test("feed external id uniqueness is per source and subscribe is idempotent for active duplicates", async () => {
  await withTestDb(async (database) => {
    const { user, source: telegram } = await createOwnedSource(
      database,
      "feed-unique@example.com",
      ConnectorId.Telegram,
    );
    const rss = await createSource(database, {
      userId: user.id,
      connectorId: ConnectorId.RSS,
      credentials: await encryptedTelegramCredentials(deterministicCipher(), user.id, ConnectorId.RSS),
    });

    const first = await createOrReviveFeed(
      database,
      feedInput(user.id, telegram.id, { externalId: "same-external-id", name: "Original" }),
    );
    const duplicate = await createOrReviveFeed(
      database,
      feedInput(user.id, telegram.id, { externalId: "same-external-id", name: "Ignored" }),
    );
    const otherSource = await createOrReviveFeed(
      database,
      feedInput(user.id, rss.id, { externalId: "same-external-id", name: "RSS" }),
    );

    assertEquals(duplicate.id, first.id);
    assertEquals(duplicate.name, "Original");
    assertEquals(otherSource.sourceId, rss.id);
    assertEquals(otherSource.externalId, first.externalId);
    assert(otherSource.id !== first.id);
  });
});

Deno.test("feed repository scopes reads and writes by source owner", async () => {
  await withTestDb(async (database) => {
    const owner = await createOwnedSource(database, "feed-owner@example.com");
    const other = await createOwnedSource(database, "feed-other@example.com");
    const feed = await createOrReviveFeed(
      database,
      feedInput(owner.user.id, owner.source.id, { externalId: "owned" }),
    );

    assertEquals(await findFeedById(database, feed.id, other.user.id), null);
    await assertRejects(
      () => listFeedsForSource(database, owner.source.id, other.user.id),
      NotFoundError,
      "source not found",
    );

    await assertRejects(
      () => updateFeed(database, feed.id, other.user.id, { enabled: false }),
      NotFoundError,
      "feed not found",
    );
    await assertRejects(
      () => softDeleteFeed(database, feed.id, other.user.id),
      NotFoundError,
      "feed not found",
    );
    await assertRejects(
      () => setLastFetched(database, feed.id, other.user.id, 1_700_000_000_000),
      NotFoundError,
      "feed not found",
    );
    await assertRejects(
      () =>
        createOrReviveFeed(
          database,
          feedInput(other.user.id, owner.source.id, { externalId: "cross-user" }),
        ),
      NotFoundError,
      "source not found",
    );
  });
});

Deno.test("createOrReviveFeed revives a soft-deleted feed instead of creating a duplicate", async () => {
  await withTestDb(async (database) => {
    const { user, source } = await createOwnedSource(database, "feed-revive@example.com");
    const feed = await createOrReviveFeed(
      database,
      feedInput(user.id, source.id, {
        customPrompt: "Old prompt",
        position: 4,
        kind: "news",
      }),
    );
    await softDeleteFeed(database, feed.id, user.id);

    const revived = await createOrReviveFeed(
      database,
      feedInput(user.id, source.id, {
        name: "Revived name",
        kind: "discussion",
        customPrompt: "New prompt",
        position: 1,
      }),
    );

    assertEquals(revived.id, feed.id);
    assertEquals(revived.name, "Revived name");
    assertEquals(revived.kind, "discussion");
    assertEquals(revived.customPrompt, "New prompt");
    assertEquals(revived.position, 1);
    assertEquals(revived.enabled, true);
    assertEquals(revived.deletedAt, null);

    const allRows = await listFeedsForUser(database, user.id, { includeDeleted: true });
    assertEquals(allRows.length, 1);
    assertEquals(allRows[0].id, feed.id);
  });
});

Deno.test("createOrReviveFeed rejects disconnected sources", async () => {
  await withTestDb(async (database) => {
    const { user, source } = await createOwnedSource(database, "feed-disconnected-subscribe@example.com");
    const feed = await createOrReviveFeed(database, feedInput(user.id, source.id));
    await deleteSourceCredentials(database, source.id, user.id);

    await assertRejects(
      () => createOrReviveFeed(database, feedInput(user.id, source.id, { name: "Revived" })),
      ConflictError,
      "source must be reconnected before feeds can be subscribed",
    );
    await assertRejects(
      () => createOrReviveFeed(database, feedInput(user.id, source.id, { externalId: "new-feed" })),
      ConflictError,
      "source must be reconnected before feeds can be subscribed",
    );

    const historicalFeeds = await listFeedsForUser(database, user.id, { includeDeleted: true });
    assertEquals(historicalFeeds.length, 1);
    assertEquals(historicalFeeds[0].id, feed.id);
    assertEquals(historicalFeeds[0].deletedAt !== null, true);
  });
});

Deno.test("feed row validation rejects unknown feed kinds at repository boundary", async () => {
  await withTestDb(async (database) => {
    const { source } = await createOwnedSource(database, "feed-kind@example.com");
    const now = Date.now();

    await assertRejects(
      () => database.insert(feeds).values({
        sourceId: source.id,
        externalId: "bad-kind",
        name: "Bad Kind",
        kind: "invalid" as FeedKind,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      }),
    );
  });
});

Deno.test("setLastFetched updates only the fetch cursor and row timestamp", async () => {
  await withTestDb(async (database) => {
    const { user, source } = await createOwnedSource(database, "feed-cursor@example.com");
    const feed = await createOrReviveFeed(
      database,
      feedInput(user.id, source.id, {
        customPrompt: "Keep this prompt",
        position: 9,
        kind: "discussion",
      }),
    );

    const updated = await setLastFetched(database, feed.id, user.id, 1_700_000_123_456);
    assertEquals(updated.lastFetchedPeriodEndMs, 1_700_000_123_456);
    assertEquals(updated.id, feed.id);
    assertEquals(updated.sourceId, feed.sourceId);
    assertEquals(updated.externalId, feed.externalId);
    assertEquals(updated.name, feed.name);
    assertEquals(updated.kind, feed.kind);
    assertEquals(updated.customPrompt, feed.customPrompt);
    assertEquals(updated.position, feed.position);
    assertEquals(updated.enabled, feed.enabled);
    assertEquals(updated.deletedAt, feed.deletedAt);
    assertEquals(updated.createdAt, feed.createdAt);
  });
});

Deno.test("feed check constraint rejects invalid feed kind at database level", async () => {
  await withTestDb(async (database) => {
    const { user, source } = await createOwnedSource(database, "feed-check@example.com");
    const feed = await createOrReviveFeed(database, feedInput(user.id, source.id, { kind: "news" }));

    await assertRejects(
      () => database.update(feeds).set({ kind: "invalid" as FeedKind }).where(eq(feeds.id, feed.id)),
    );
  });
});
