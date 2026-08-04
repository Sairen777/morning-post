import { test } from "bun:test";
import { assertEquals, assertRejects } from "../assertions.ts"
import { ConnectorId } from "../../src/constants.ts";
import {
  type XApiClientFactory,
  type XContentCacheFactory,
} from "../../src/connectors/connector-factory.ts";
import type { XApiClient } from "../../src/connectors/x/twex-api-client.ts";
import { CredentialCipher } from "../../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../src/crypto/key-provider.ts";
import { withTestDb } from "../../src/db/testing.ts";
import type { XContentCache } from "../../src/repositories/x-content-cache-repository.ts";
import { createSource } from "../../src/repositories/source-repository.ts";
import { createUser } from "../../src/repositories/user-repository.ts";
import {
  DefaultFeedDiscoveryFactory,
  discoverFeeds,
  type TelegramFeedDiscoveryRuntime,
} from "../../src/services/feed-service.ts";

const cipher = new CredentialCipher(
  new EnvMasterKeyProvider(new Uint8Array(32).fill(37)),
);

test("default Telegram feed discovery destroys its client when connector work throws", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, {
      name: "Feed Discovery Owner",
      email: "feed-discovery-lifecycle@example.com",
      passwordHash: "$argon2id$fakehash",
      systemPrompt: "Summarize tersely.",
      defaultLanguage: "en",
    });
    const source = await createSource(database, {
      userId: user.id,
      connectorId: ConnectorId.Telegram,
      credentials: await cipher.encrypt(
        JSON.stringify({ sessionString: "telegram-session" }),
        {
          userId: user.id,
          connectorId: ConnectorId.Telegram,
        },
      ),
    });

    let destroyCount = 0;
    let disconnectCount = 0;
    const client = {
      destroy: () => {
        destroyCount += 1;
      },
      disconnect: () => {
        disconnectCount += 1;
      },
    };
    const runtimeLoader = () =>
      Promise.resolve({
        createClientFromSession: () => Promise.resolve(client),
        TelegramConnector: class {
          listAvailableFeeds(): Promise<never> {
            return Promise.reject(new Error("discovery failed"));
          }
        },
      } as unknown as TelegramFeedDiscoveryRuntime);
    const factory = new DefaultFeedDiscoveryFactory(
      database,
      cipher,
      runtimeLoader,
    );

    await assertRejects(
      () => discoverFeeds(database, user.id, source.id, factory),
      Error,
      "discovery failed",
    );
    assertEquals(destroyCount, 1);
    assertEquals(disconnectCount, 0);
  });
});

test("default X feed discovery disposes its connector when discovery throws", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, {
      name: "X Feed Discovery Owner",
      email: "x-feed-discovery-lifecycle@example.com",
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

    const observedSignals: Array<AbortSignal | undefined> = [];
    let createdClients = 0;
    const xApiClientFactory: XApiClientFactory = {
      createClient: () => {
        createdClients += 1;
        const failing = createdClients === 1;
        return {
          getUserInfo: () => Promise.reject(new Error("unused")),
          searchLists: (
            _query: string,
            _targetCount: number,
            signal?: AbortSignal,
          ) => {
            observedSignals.push(signal);
            return failing
              ? Promise.reject(new Error("discovery failed"))
              : Promise.resolve([]);
          },
          getConversations: () => Promise.resolve([]),
          getListPostsPage: () => Promise.resolve({
            items: [],
            nextCursor: null,
            complete: true,
          }),
          getChatMessagesPage: () => Promise.resolve({
            items: [],
            nextCursor: null,
            complete: true,
          }),
        } as unknown as XApiClient;
      },
    };
    const createdCaches: Array<{ sourceId: string }> = [];
    const xContentCacheFactory: XContentCacheFactory = {
      createCache: (_database, sourceId) => {
        createdCaches.push({ sourceId });
        return {
          missingRanges: () => [],
          read: () => [],
          pendingRanges: () => [],
          recordPage: () => {},
          record: () => {},
          clear: () => {},
        } as unknown as XContentCache;
      },
    };
    const factory = new DefaultFeedDiscoveryFactory(
      database,
      cipher,
      undefined,
      { xApiClientFactory, xContentCacheFactory },
    );

    await assertRejects(
      () => discoverFeeds(database, user.id, source.id, factory),
      Error,
      "discovery failed",
    );
    assertEquals(createdCaches, [{ sourceId: source.id }]);
    assertEquals(observedSignals.length, 1);
    assertEquals(observedSignals[0]?.aborted, true);

    assertEquals(
      await discoverFeeds(database, user.id, source.id, factory),
      [],
    );
    assertEquals(createdClients, 2);
  });
});
