import { test } from "bun:test";
import { assertEquals, assertRejects } from "../assertions.ts";
import { ConnectorId } from "../../src/constants.ts";
import {
  type XApiClientFactory,
  type XContentCacheFactory,
} from "../../src/connectors/connector-factory.ts";
import type { XApiClient } from "../../src/connectors/x/twex-api-client.ts";
import type { XContentCache } from "../../src/repositories/x-content-cache-repository.ts";
import {
  listDiscoveredFeedsForSource,
  replaceDiscoveredFeedsForRevision,
} from "../../src/repositories/x-discovered-feed-repository.ts";
import {
  createSource,
  updateSource,
  upsertSourceCredentials,
} from "../../src/repositories/source-repository.ts";
import { createUser } from "../../src/repositories/user-repository.ts";
import { CredentialCipher } from "../../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../src/crypto/key-provider.ts";
import { withTestDb } from "../../src/db/testing.ts";
import type { Database } from "../../src/db/client.ts";
import {
  DefaultFeedDiscoveryFactory,
  discoverFeeds,
  subscribeFeed,
} from "../../src/services/feed-service.ts";
import { ConflictError } from "../../src/server/errors.ts";

const cipher = new CredentialCipher(
  new EnvMasterKeyProvider(new Uint8Array(32).fill(37)),
);

const LIST_FEED = "x:list:44196397";
const GROUP_FEED = "x:chat:group-42";
const DIRECT_FEED = "x:chat:direct-dm-1";

interface CallCounters {
  searchLists: number;
  getConversations: number;
  getListPosts: number;
  getChatMessages: number;
}

function fakeXApiClientFactory(
  counters: CallCounters,
  options: {
    lists?: Array<{ id: string; name: string }>;
    conversations?: Array<{
      conversation_id: string;
      type: string;
      participants: string[];
    }>;
    conversationsGate?: Promise<void>;
    onConversationsRequested?: () => void;
  } = {},
): XApiClientFactory {
  const lists = options.lists ?? [{ id: "44196397", name: "Curated List" }];
  const conversations = options.conversations ?? [
    {
      conversation_id: "group-42",
      type: "group",
      participants: ["a", "b", "c", "d", "e"],
    },
    { conversation_id: "direct-dm-1", type: "direct", participants: ["a", "b"] },
  ];
  return {
    createClient: () => ({
      getUserInfo: () => Promise.reject(new Error("unused")),
      searchLists: (_query: string, _targetCount: number) => {
        counters.searchLists += 1;
        return Promise.resolve(lists);
      },
      getConversations: () => {
        counters.getConversations += 1;
        options.onConversationsRequested?.();
        return options.conversationsGate === undefined
          ? Promise.resolve(conversations)
          : options.conversationsGate.then(() => conversations);
      },
      getListPosts: () => {
        counters.getListPosts += 1;
        return Promise.resolve([]);
      },
      getChatMessages: () => {
        counters.getChatMessages += 1;
        return Promise.resolve([]);
      },
    } as unknown as XApiClient),
  };
}

function fakeXContentCacheFactory(): XContentCacheFactory {
  return {
    createCache: () => ({
      missingRanges: () => [],
      read: () => [],
      record: () => {},
      clear: () => {},
    } as unknown as XContentCache),
  };
}

async function createOwnedXSource(database: Database, email: string) {
  const user = await createUser(database, {
    name: "X Discovery Catalog Owner",
    email,
    passwordHash: "$argon2id$fakehash",
    systemPrompt: "Summarize tersely.",
    defaultLanguage: "en",
  });
  const source = await createSource(database, {
    userId: user.id,
    connectorId: ConnectorId.X,
    credentials: await cipher.encrypt(
      JSON.stringify({
        apiKey: "twex-api-key",
        authToken: "auth-token-123",
        cookie: "auth_token=auth-token-123; ct0=csrf-token-456",
        pin: "1234",
        listQuery: "my-lists",
        xUserId: "x-user-1",
        xUsername: "alice",
      }),
      { userId: user.id, connectorId: ConnectorId.X },
    ),
  });
  return { user, source };
}

test("X discovery catalogs exactly the returned lists and group chats at the revalidated revision", async () => {
  await withTestDb(async (database) => {
    const { user, source } = await createOwnedXSource(
      database,
      "x-discovery-catalog@example.com",
    );
    const counters: CallCounters = {
      searchLists: 0,
      getConversations: 0,
      getListPosts: 0,
      getChatMessages: 0,
    };
    const factory = new DefaultFeedDiscoveryFactory(
      database,
      cipher,
      undefined,
      {
        xApiClientFactory: fakeXApiClientFactory(counters),
        xContentCacheFactory: fakeXContentCacheFactory(),
      },
    );

    const feeds = await discoverFeeds(database, user.id, source.id, factory);

    // Direct-DM conversations are excluded from the returned and cataloged set.
    assertEquals(feeds.map((feed) => feed.externalId), [LIST_FEED, GROUP_FEED]);
    assertEquals(counters.searchLists, 1);
    assertEquals(counters.getConversations, 1);
    assertEquals(counters.getListPosts, 0);
    assertEquals(counters.getChatMessages, 0);
    assertEquals(listDiscoveredFeedsForSource(database, source.id), [
      {
        credentialRevision: 1,
        externalId: GROUP_FEED,
        name: "Group (5 participants) - group-42",
        kind: "discussion",
      },
      {
        credentialRevision: 1,
        externalId: LIST_FEED,
        name: "Curated List",
        kind: "news",
      },
    ]);
  });
});

test("stale X discovery fails closed, writes no catalog, and makes no extra upstream calls", async () => {
  await withTestDb(async (database) => {
    const { user, source } = await createOwnedXSource(
      database,
      "x-discovery-stale@example.com",
    );
    // A previous discovery's catalog must survive the failed replace.
    replaceDiscoveredFeedsForRevision(database, source.id, 1, [
      { externalId: LIST_FEED, name: "Curated List", kind: "news" },
    ]);

    const gate = Promise.withResolvers<void>();
    const conversationsRequested = Promise.withResolvers<void>();
    const counters: CallCounters = {
      searchLists: 0,
      getConversations: 0,
      getListPosts: 0,
      getChatMessages: 0,
    };
    const factory = new DefaultFeedDiscoveryFactory(
      database,
      cipher,
      undefined,
      {
        xApiClientFactory: fakeXApiClientFactory(counters, {
          conversationsGate: gate.promise,
          onConversationsRequested: () => conversationsRequested.resolve(),
        }),
        xContentCacheFactory: fakeXContentCacheFactory(),
      },
    );

    // The discovery holds the conversation fetch open while the account
    // reconnects: the revalidation must then fail and roll the replace back.
    const discovery = discoverFeeds(database, user.id, source.id, factory);
    await conversationsRequested.promise;
    await upsertSourceCredentials(database, {
      userId: user.id,
      connectorId: ConnectorId.X,
      credentials: await cipher.encrypt(
        JSON.stringify({
          apiKey: "twex-api-key",
          authToken: "auth-token-123",
          cookie: "auth_token=auth-token-123; ct0=csrf-token-456",
          pin: "1234",
          listQuery: "my-lists",
          xUserId: "x-user-1",
          xUsername: "alice",
        }),
        { userId: user.id, connectorId: ConnectorId.X },
      ),
    });
    gate.resolve();
    await assertRejects(
      () => discovery,
      ConflictError,
      "source connection changed",
    );

    // The reconnect bumped the revision; the stale discovery wrote nothing
    // and issued no calls beyond the one discovery attempt.
    assertEquals(listDiscoveredFeedsForSource(database, source.id), [
      {
        credentialRevision: 1,
        externalId: LIST_FEED,
        name: "Curated List",
        kind: "news",
      },
    ]);
    assertEquals(counters.searchLists, 1);
    assertEquals(counters.getConversations, 1);
  });
});

test("X discovery and catalog replacement work for connected-but-disabled sources", async () => {
  await withTestDb(async (database) => {
    const { user, source } = await createOwnedXSource(
      database,
      "x-discovery-disabled@example.com",
    );
    updateSource(database, source.id, user.id, { enabled: false });

    const counters: CallCounters = {
      searchLists: 0,
      getConversations: 0,
      getListPosts: 0,
      getChatMessages: 0,
    };
    const factory = new DefaultFeedDiscoveryFactory(
      database,
      cipher,
      undefined,
      {
        xApiClientFactory: fakeXApiClientFactory(counters),
        xContentCacheFactory: fakeXContentCacheFactory(),
      },
    );

    const feeds = await discoverFeeds(database, user.id, source.id, factory);
    assertEquals(feeds.map((feed) => feed.externalId), [LIST_FEED, GROUP_FEED]);
    assertEquals(listDiscoveredFeedsForSource(database, source.id).length, 2);

    // Subscription on the disabled-but-connected source is authorized.
    const feed = await subscribeFeed(database, {
      userId: user.id,
      sourceId: source.id,
      externalId: LIST_FEED,
      name: "Spoofed",
      kind: "discussion",
    });
    assertEquals(feed.name, "Curated List");
    assertEquals(feed.kind, "news");
  });
});

test("X subscription never triggers upstream discovery calls", async () => {
  await withTestDb(async (database) => {
    const { user, source } = await createOwnedXSource(
      database,
      "x-subscription-no-calls@example.com",
    );
    const counters: CallCounters = {
      searchLists: 0,
      getConversations: 0,
      getListPosts: 0,
      getChatMessages: 0,
    };
    const factory = new DefaultFeedDiscoveryFactory(
      database,
      cipher,
      undefined,
      {
        xApiClientFactory: fakeXApiClientFactory(counters),
        xContentCacheFactory: fakeXContentCacheFactory(),
      },
    );
    await discoverFeeds(database, user.id, source.id, factory);
    assertEquals(counters.searchLists, 1);
    assertEquals(counters.getConversations, 1);

    // A crafted subscription — accepted or rejected — must never trigger a
    // paid rediscovery; it is served entirely from the local catalog.
    const feed = await subscribeFeed(database, {
      userId: user.id,
      sourceId: source.id,
      externalId: GROUP_FEED,
      name: "Spoofed",
      kind: "news",
    });
    assertEquals(feed.kind, "discussion");
    await assertRejects(
      () =>
        subscribeFeed(database, {
          userId: user.id,
          sourceId: source.id,
          externalId: DIRECT_FEED,
          name: "Spoofed DM",
          kind: "discussion",
        }),
      ConflictError,
    );
    assertEquals(counters.searchLists, 1);
    assertEquals(counters.getConversations, 1);
    assertEquals(counters.getListPosts, 0);
    assertEquals(counters.getChatMessages, 0);
  });
});
