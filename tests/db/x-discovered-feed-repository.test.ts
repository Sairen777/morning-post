import { test } from "bun:test";
import { assertEquals, assertExists, assertThrows } from "../assertions.ts";
import { and, eq, isNull } from "drizzle-orm";
import { ConnectorId } from "../../src/constants.ts";
import {
  CredentialCipher,
  type EncryptedBlob,
} from "../../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../src/crypto/key-provider.ts";
import { withTestDb } from "../../src/db/testing.ts";
import type { Database } from "../../src/db/client.ts";
import { feeds } from "../../src/db/schema/feed.ts";
import { sources } from "../../src/db/schema/source.ts";
import type { AvailableFeed } from "../../src/connectors/connector.types.ts";
import {
  createOrReviveFeed,
  resetFeedsForSourceConnection,
  softDeleteFeed,
} from "../../src/repositories/feed-repository.ts";
import {
  createSource,
  deleteSourceCredentials,
  updateSource,
  upsertSourceCredentials,
} from "../../src/repositories/source-repository.ts";
import { createUser } from "../../src/repositories/user-repository.ts";
import {
  listDiscoveredFeedsForSource,
  replaceDiscoveredFeedsForRevision,
} from "../../src/repositories/x-discovered-feed-repository.ts";
import { ConflictError, ValidationError } from "../../src/server/errors.ts";

const cipher = new CredentialCipher(
  new EnvMasterKeyProvider(new Uint8Array(32).fill(31)),
);

const LIST_FEED = "x:list:44196397";
const GROUP_FEED = "x:chat:group-42";

function catalogedFeeds(): AvailableFeed[] {
  return [
    { externalId: LIST_FEED, name: "Curated List", kind: "news" },
    {
      externalId: GROUP_FEED,
      name: "Group (5 participants) - group-42",
      kind: "discussion",
    },
  ];
}

async function encryptedXCredentials(
  userId: string,
): Promise<EncryptedBlob> {
  return await cipher.encrypt(
    JSON.stringify({
      apiKey: "twex-api-key",
      authToken: "auth-token-123",
      cookie: "auth_token=auth-token-123; ct0=csrf-token-456",
      pin: "1234",
      listQuery: "my-lists",
      xUserId: "x-user-1",
      xUsername: "alice",
    }),
    { userId, connectorId: ConnectorId.X },
  );
}

async function createOwnedXSource(database: Database, email: string) {
  const user = await createUser(database, {
    name: "X Catalog Owner",
    email,
    passwordHash: "$argon2id$fakehash",
    systemPrompt: "Summarize tersely.",
    defaultLanguage: "en",
  });
  const source = await createSource(database, {
    userId: user.id,
    connectorId: ConnectorId.X,
    credentials: await encryptedXCredentials(user.id),
  });
  return { user, source };
}

function subscribeInput(
  userId: string,
  sourceId: string,
  externalId: string,
  overrides: Partial<{ name: string; kind: "news" | "discussion" }> = {},
) {
  return {
    userId,
    sourceId,
    externalId,
    name: "Client-Supplied Name",
    kind: "news" as const,
    ...overrides,
  };
}

function activeFeedRows(database: Database, sourceId: string) {
  return database
    .select({ id: feeds.id, externalId: feeds.externalId })
    .from(feeds)
    .where(and(eq(feeds.sourceId, sourceId), isNull(feeds.deletedAt)))
    .all();
}

test("replaceDiscoveredFeedsForRevision stores exactly the returned targets bound to the revision and prunes prior rows", async () => {
  await withTestDb(async (database) => {
    const { user, source } = await createOwnedXSource(
      database,
      "x-catalog-replace@example.com",
    );

    replaceDiscoveredFeedsForRevision(database, source.id, 1, catalogedFeeds());
    assertEquals(listDiscoveredFeedsForSource(database, source.id), [
      {
        credentialRevision: 1,
        externalId: GROUP_FEED,
        name: "Group (5 participants) - group-42",
        kind: "discussion",
      },
      { credentialRevision: 1, externalId: LIST_FEED, name: "Curated List", kind: "news" },
    ]);

    // A later discovery replaces the set for the same revision exactly.
    replaceDiscoveredFeedsForRevision(database, source.id, 1, [
      { externalId: LIST_FEED, name: "Renamed List", kind: "news" },
    ]);
    assertEquals(listDiscoveredFeedsForSource(database, source.id), [
      { credentialRevision: 1, externalId: LIST_FEED, name: "Renamed List", kind: "news" },
    ]);

    // A new revision prunes rows of every prior revision.
    replaceDiscoveredFeedsForRevision(database, source.id, 2, [
      {
        externalId: GROUP_FEED,
        name: "Group (3 participants) - group-42",
        kind: "discussion",
      },
    ]);
    assertEquals(listDiscoveredFeedsForSource(database, source.id), [
      {
        credentialRevision: 2,
        externalId: GROUP_FEED,
        name: "Group (3 participants) - group-42",
        kind: "discussion",
      },
    ]);

    // An empty discovery revokes everything.
    replaceDiscoveredFeedsForRevision(database, source.id, 2, []);
    assertEquals(listDiscoveredFeedsForSource(database, source.id), []);
    assertEquals(user.id.length > 0, true);
  });
});

test("X subscription rejects malformed targets before any persistence", async () => {
  await withTestDb(async (database) => {
    const { user, source } = await createOwnedXSource(
      database,
      "x-catalog-malformed@example.com",
    );
    replaceDiscoveredFeedsForRevision(database, source.id, 1, catalogedFeeds());

    for (const externalId of [
      "x:following",
      "bogus",
      "x:list:not-a-number",
      "x:chat:",
      "list:42",
    ]) {
      assertThrows(
        () => createOrReviveFeed(database, subscribeInput(user.id, source.id, externalId)),
        ValidationError,
      );
    }
    assertEquals(activeFeedRows(database, source.id), []);
  });
});

test("X subscription rejects uncataloged targets including arbitrary direct-DM chats", async () => {
  await withTestDb(async (database) => {
    const { user, source } = await createOwnedXSource(
      database,
      "x-catalog-uncataloged@example.com",
    );
    replaceDiscoveredFeedsForRevision(database, source.id, 1, catalogedFeeds());

    // A well-formed but never-cataloged direct conversation ID must fail
    // closed; discovery only ever returns group chats and lists.
    for (const externalId of [
      "x:chat:direct-dm-1",
      "x:list:99999999",
      "x:chat:group-other",
    ]) {
      assertThrows(
        () => createOrReviveFeed(database, subscribeInput(user.id, source.id, externalId)),
        ConflictError,
        "not discovered for the current connection",
      );
    }
    assertEquals(activeFeedRows(database, source.id), []);
  });
});

test("X subscription uses server-canonical catalog name and kind, ignoring client metadata", async () => {
  await withTestDb(async (database) => {
    const { user, source } = await createOwnedXSource(
      database,
      "x-catalog-canonical@example.com",
    );
    replaceDiscoveredFeedsForRevision(database, source.id, 1, catalogedFeeds());

    // Kind spoof: the catalog says this list is news.
    const listFeed = createOrReviveFeed(database, subscribeInput(user.id, source.id, LIST_FEED, {
      name: "Spoofed List Name",
      kind: "discussion",
    }));
    assertEquals(listFeed.name, "Curated List");
    assertEquals(listFeed.kind, "news");

    // Kind spoof the other way: the catalog says this chat is discussion.
    const chatFeed = createOrReviveFeed(database, subscribeInput(user.id, source.id, GROUP_FEED, {
      name: "Spoofed Chat Name",
      kind: "news",
    }));
    assertEquals(chatFeed.name, "Group (5 participants) - group-42");
    assertEquals(chatFeed.kind, "discussion");

    // Re-subscribing an active feed is idempotent and still canonical.
    const again = createOrReviveFeed(database, subscribeInput(user.id, source.id, LIST_FEED, {
      name: "Even Spoofier",
    }));
    assertEquals(again.id, listFeed.id);
    assertEquals(again.name, "Curated List");

    // Revival also restores canonical metadata over client-supplied values.
    softDeleteFeed(database, listFeed.id, user.id);
    const revived = createOrReviveFeed(database, subscribeInput(user.id, source.id, LIST_FEED, {
      name: "Spoofed Revival",
      kind: "discussion",
    }));
    assertEquals(revived.id, listFeed.id);
    assertEquals(revived.deletedAt, null);
    assertEquals(revived.name, "Curated List");
    assertEquals(revived.kind, "news");
  });
});

test("X subscription requires the catalog entry for the source's current revision and rejects stale ones", async () => {
  await withTestDb(async (database) => {
    const { user, source } = await createOwnedXSource(
      database,
      "x-catalog-stale@example.com",
    );
    replaceDiscoveredFeedsForRevision(database, source.id, 1, catalogedFeeds());
    const first = createOrReviveFeed(database, subscribeInput(user.id, source.id, LIST_FEED));
    assertEquals(first.name, "Curated List");

    // Same-account reconnect bumps the revision but preserves committed
    // feeds; the old-revision catalog must NOT authorize new subscriptions.
    await upsertSourceCredentials(database, {
      userId: user.id,
      connectorId: ConnectorId.X,
      credentials: await encryptedXCredentials(user.id),
    });
    assertThrows(
      () => createOrReviveFeed(database, subscribeInput(user.id, source.id, GROUP_FEED)),
      ConflictError,
      "not discovered for the current connection",
    );
    // Re-subscribing a previously active target is equally refused: no write
    // happens at any point under a stale authorization.
    assertThrows(
      () => createOrReviveFeed(database, subscribeInput(user.id, source.id, LIST_FEED)),
      ConflictError,
      "not discovered for the current connection",
    );

    // Fresh discovery at the new revision authorizes the target again.
    replaceDiscoveredFeedsForRevision(database, source.id, 2, catalogedFeeds());
    const fresh = createOrReviveFeed(database, subscribeInput(user.id, source.id, GROUP_FEED));
    assertEquals(fresh.name, "Group (5 participants) - group-42");
    assertEquals(fresh.kind, "discussion");
  });
});

test("X subscription and discovery catalog work for connected-but-disabled sources", async () => {
  await withTestDb(async (database) => {
    const { user, source } = await createOwnedXSource(
      database,
      "x-catalog-disabled@example.com",
    );
    const disabled = updateSource(database, source.id, user.id, { enabled: false });
    assertEquals(disabled.enabled, false);
    assertEquals(disabled.connected, true);

    replaceDiscoveredFeedsForRevision(database, source.id, 1, catalogedFeeds());
    const feed = createOrReviveFeed(database, subscribeInput(user.id, source.id, LIST_FEED));
    assertEquals(feed.enabled, true);
    assertEquals(feed.name, "Curated List");
  });
});

test("X subscription enforces the 250 active feed cap transactionally", async () => {
  await withTestDb(async (database) => {
    const { user, source } = await createOwnedXSource(
      database,
      "x-catalog-cap@example.com",
    );
    const discovered: AvailableFeed[] = Array.from({ length: 251 }, (_, index) => ({
      externalId: `x:list:${index + 1}`,
      name: `List ${index + 1}`,
      kind: "news",
    }));
    replaceDiscoveredFeedsForRevision(database, source.id, 1, discovered);

    for (let index = 0; index < 250; index += 1) {
      const feed = createOrReviveFeed(database, subscribeInput(user.id, source.id, discovered[index].externalId));
      assertEquals(feed.name, discovered[index].name);
    }

    // The 251st subscription is rejected: persistence can never exceed the
    // connector's per-batch limit.
    assertThrows(
      () => createOrReviveFeed(database, subscribeInput(user.id, source.id, discovered[250].externalId)),
      ConflictError,
      "at most 250 active feeds",
    );

    // Re-subscribing an already-active feed stays idempotent at the cap.
    const all = activeFeedRows(database, source.id);
    const active = createOrReviveFeed(database, subscribeInput(user.id, source.id, all[1].externalId));
    assertEquals(active.externalId, all[1].externalId);

    // A soft-deleted row plus 250 active rows: reviving the deleted row would
    // exceed the cap, so it is rejected too (revival is a subscription).
    softDeleteFeed(database, all[0].id, user.id);
    createOrReviveFeed(database, subscribeInput(user.id, source.id, discovered[250].externalId));
    assertThrows(
      () => createOrReviveFeed(database, subscribeInput(user.id, source.id, all[0].externalId)),
      ConflictError,
      "at most 250 active feeds",
    );
    assertEquals(activeFeedRows(database, source.id).length, 250);
  });
});

test("resetFeedsForSourceConnection clears the catalog for every revision", async () => {
  await withTestDb(async (database) => {
    const { user, source } = await createOwnedXSource(
      database,
      "x-catalog-reset@example.com",
    );
    replaceDiscoveredFeedsForRevision(database, source.id, 1, catalogedFeeds());
    const feed = createOrReviveFeed(
      database,
      subscribeInput(user.id, source.id, LIST_FEED),
    );
    replaceDiscoveredFeedsForRevision(database, source.id, 2, [
      { externalId: LIST_FEED, name: "Next List", kind: "news" },
    ]);

    resetFeedsForSourceConnection(database, source.id);

    assertEquals(listDiscoveredFeedsForSource(database, source.id), []);
    const rows = database
      .select({ deletedAt: feeds.deletedAt, enabled: feeds.enabled })
      .from(feeds)
      .where(eq(feeds.id, feed.id))
      .get();
    assertExists(rows);
    assertEquals(rows.enabled, false);
    assertEquals(rows.deletedAt === null, false);
  });
});

test("deleteSourceCredentials clears the catalog for every revision", async () => {
  await withTestDb(async (database) => {
    const { user, source } = await createOwnedXSource(
      database,
      "x-catalog-disconnect@example.com",
    );
    replaceDiscoveredFeedsForRevision(database, source.id, 1, catalogedFeeds());
    replaceDiscoveredFeedsForRevision(database, source.id, 2, [
      { externalId: GROUP_FEED, name: "Next Group", kind: "discussion" },
    ]);

    const disconnected = deleteSourceCredentials(database, source.id, user.id);
    assertEquals(disconnected.connected, false);
    assertEquals(listDiscoveredFeedsForSource(database, source.id), []);
  });
});

test("catalog rows cascade when the source row is deleted", async () => {
  await withTestDb(async (database) => {
    const { user, source } = await createOwnedXSource(
      database,
      "x-catalog-cascade@example.com",
    );
    replaceDiscoveredFeedsForRevision(database, source.id, 1, catalogedFeeds());
    database.delete(sources).where(eq(sources.id, source.id)).run();
    assertEquals(listDiscoveredFeedsForSource(database, source.id), []);
    assertEquals(user.id.length > 0, true);
  });
});
