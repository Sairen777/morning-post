import { test } from "bun:test";
import { assertEquals, assertRejects } from "./assertions.ts";
import { ConnectorId } from "../src/constants.ts";
import {
  ConnectorFactory,
  type SubstackClientFactory,
  type TelegramClientFactory,
  type TelegramClientHandle,
  type XApiClientFactory,
  type XContentCacheFactory,
} from "../src/connectors/connector-factory.ts";
import {
  CredentialCipher,
  type EncryptedBlob,
} from "../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../src/crypto/key-provider.ts";
import type { Database } from "../src/db/client.ts";
import { withTestDb } from "../src/db/testing.ts";
import {
  createSource,
  deleteSourceCredentials,
} from "../src/repositories/source-repository.ts";
import {
  createUser,
  type CreateUserInput,
} from "../src/repositories/user-repository.ts";
import { ConflictError, NotFoundError } from "../src/server/errors.ts";
import type { SubstackPostReader } from "../src/connectors/substack/substack-connector.ts";
import type { XApiClient, TwexFetch } from "../src/connectors/x/twex-api-client.ts";
import type { XContentCache, XTimeRange } from "../src/repositories/x-content-cache-repository.ts";

class FakeTelegramClientFactory implements TelegramClientFactory {
  readonly sessions: string[] = [];
  destroyCount = 0;
  disconnectCount = 0;

  createClientFromSession(
    sessionString: string,
  ): Promise<TelegramClientHandle> {
    this.sessions.push(sessionString);
    const client = {
      destroy: () => {
        this.destroyCount += 1;
      },
      disconnect: () => {
        this.disconnectCount += 1;
      },
    } as unknown as TelegramClientHandle;
    return Promise.resolve(client);
  }
}

class FakeXApiClientFactory implements XApiClientFactory {
  readonly created: Array<{
    credentials: Parameters<XApiClientFactory["createClient"]>[0];
    options?: { baseUrl?: string; fetch?: TwexFetch };
  }> = [];
  createdClients = 0;
  readonly pageCalls: Array<{
    op: "list" | "chat";
    listId?: string;
    conversationId?: string;
    from: number;
    to: number;
    cursor: string | null;
  }> = [];

  createClient(
    credentials: Parameters<XApiClientFactory["createClient"]>[0],
    options?: { baseUrl?: string; fetch?: TwexFetch },
  ): XApiClient {
    this.createdClients += 1;
    this.created.push({ credentials, options });
    return {
      getUserInfo: () => Promise.reject(new Error("unused")),
      searchLists: () => Promise.resolve([]),
      getConversations: () => Promise.resolve([]),
      getListPostsPage: (
        listId: string,
        from: number,
        to: number,
        cursor: string | null,
      ) => {
        this.pageCalls.push({ op: "list", listId, from, to, cursor });
        return Promise.resolve({
          items: [],
          nextCursor: null,
          complete: true,
        });
      },
      getChatMessagesPage: (
        conversationId: string,
        from: number,
        to: number,
        cursor: string | null,
      ) => {
        this.pageCalls.push({ op: "chat", conversationId, from, to, cursor });
        return Promise.resolve({
          items: [],
          nextCursor: null,
          complete: true,
        });
      },
    } as unknown as XApiClient;
  }
}

class FakeXContentCacheFactory implements XContentCacheFactory {
  readonly created: Array<{
    database: Database;
    sourceId: string;
    expectedCredentialRevision?: number;
  }> = [];
  readonly gaps = new Map<string, XTimeRange[]>();

  createCache(
    database: Database,
    sourceId: string,
    expectedCredentialRevision?: number,
  ): XContentCache {
    this.created.push({ database, sourceId, expectedCredentialRevision });
    return {
      missingRanges: (feedExternalId: string) => this.gaps.get(feedExternalId) ?? [],
      read: () => [],
      pendingRanges: () => [],
      recordPage: () => {},
      record: () => {},
      clear: () => {},
    } as unknown as XContentCache;
  }
}

class FakeSubstackClientFactory implements SubstackClientFactory {
  readonly credentials: Array<
    { substackSessionId: string; connectSessionId?: string }
  > = [];

  createClient(
    credentials: { substackSessionId: string; connectSessionId?: string },
  ): Promise<SubstackPostReader> {
    this.credentials.push(credentials);
    return Promise.resolve({ getPostById: () => Promise.resolve(null) });
  }
}

function userInput(email: string): CreateUserInput {
  return {
    name: "Connector Owner",
    email,
    passwordHash: "$argon2id$fakehash",
    systemPrompt: "Summarize tersely.",
    defaultLanguage: "en",
  };
}

function credentialCipher(): CredentialCipher {
  return new CredentialCipher(
    new EnvMasterKeyProvider(new Uint8Array(32).fill(31)),
  );
}

async function encryptedCredentials(
  userId: string,
  connectorId: ConnectorId,
  sessionString = "telegram-session",
): Promise<EncryptedBlob> {
  return await credentialCipher().encrypt(JSON.stringify({ sessionString }), {
    userId,
    connectorId,
  });
}

async function encryptedXCredentials(userId: string): Promise<EncryptedBlob> {
  return await credentialCipher().encrypt(
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

async function encryptedSubstackCredentials(
  userId: string,
  connectorId = ConnectorId.Substack,
): Promise<EncryptedBlob> {
  return await credentialCipher().encrypt(
    JSON.stringify({
      substackSessionId: "s%3Asubstack.signature",
      connectSessionId: "s%3Aconnect.signature",
    }),
    { userId, connectorId },
  );
}

async function createUserAndSource(
  database: Database,
  email: string,
  connectorId = ConnectorId.Telegram,
) {
  const user = await createUser(database, userInput(email));
  const source = await createSource(database, {
    userId: user.id,
    connectorId,
    credentials: await encryptedCredentials(user.id, connectorId),
  });
  return { user, source };
}

test("ConnectorFactory builds a Telegram connector from encrypted credentials and disposes it", async () => {
  await withTestDb(async (database) => {
    const { user, source } = await createUserAndSource(
      database,
      "connector-factory@example.com",
    );
    const fakeTelegramClientFactory = new FakeTelegramClientFactory();
    const factory = new ConnectorFactory(database, {
      credentialCipher: credentialCipher(),
      telegramClientFactory: fakeTelegramClientFactory,
    });

    const handle = await factory.forSource(source, user.id);
    assertEquals(typeof handle.connector.getNormalizedData, "function");
    assertEquals(fakeTelegramClientFactory.sessions, ["telegram-session"]);
    assertEquals(handle.ingestionMode, "batch");

    await handle.dispose?.();
    assertEquals(fakeTelegramClientFactory.destroyCount, 1);
    assertEquals(fakeTelegramClientFactory.disconnectCount, 0);
  });
});

test("ConnectorFactory builds an individual Substack connector from encrypted credentials", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("substack-factory@example.com"),
    );
    const source = await createSource(database, {
      userId: user.id,
      connectorId: ConnectorId.Substack,
      credentials: await encryptedSubstackCredentials(user.id),
    });
    const substackClientFactory = new FakeSubstackClientFactory();
    const factory = new ConnectorFactory(database, {
      credentialCipher: credentialCipher(),
      telegramClientFactory: new FakeTelegramClientFactory(),
      substackClientFactory,
      substackPublicationReader: () =>
        Promise.resolve({ origin: "https://example.com", items: [] }),
    });

    const handle = await factory.forSource(source, user.id);
    assertEquals(handle.ingestionMode, "individual");
    assertEquals(handle.dispose, undefined);
    assertEquals(substackClientFactory.credentials, [{
      substackSessionId: "s%3Asubstack.signature",
      connectSessionId: "s%3Aconnect.signature",
    }]);
  });
});

test("ConnectorFactory builds an X connector from encrypted credentials with client and cache factories", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("x-factory@example.com"),
    );
    const source = await createSource(database, {
      userId: user.id,
      connectorId: ConnectorId.X,
      credentials: await encryptedXCredentials(user.id),
    });
    const xApiClientFactory = new FakeXApiClientFactory();
    const xContentCacheFactory = new FakeXContentCacheFactory();
    const factory = new ConnectorFactory(database, {
      credentialCipher: credentialCipher(),
      telegramClientFactory: new FakeTelegramClientFactory(),
      xApiClientFactory,
      xContentCacheFactory,
    });

    const handle = await factory.forSource(source, user.id);
    assertEquals(handle.ingestionMode, "batch");
    assertEquals(typeof handle.connector.getNormalizedData, "function");
    assertEquals(xApiClientFactory.createdClients, 1);
    assertEquals(xApiClientFactory.created[0].credentials, {
      apiKey: "twex-api-key",
      authToken: "auth-token-123",
      cookie: "auth_token=auth-token-123; ct0=csrf-token-456",
      pin: "1234",
    });
    // The handle and the cache are bound to the same credential revision.
    assertEquals(handle.sourceCredentialRevision, 1);
    assertEquals(xContentCacheFactory.created, [{
      database,
      sourceId: source.id,
      expectedCredentialRevision: 1,
    }]);

    await handle.dispose?.();
    await assertRejects(
      () => handle.connector.getRawData(0, 1),
      Error,
      "X connector has been disposed",
    );
  });
});

test("ConnectorFactory threads cache coverage tolerance into the X connector", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("x-tolerance@example.com"),
    );
    const source = await createSource(database, {
      userId: user.id,
      connectorId: ConnectorId.X,
      credentials: await encryptedXCredentials(user.id),
    });
    const windowFrom = 1_700_000_000_000;
    const windowTo = windowFrom + 10_000;

    const toleratedApiClientFactory = new FakeXApiClientFactory();
    const toleratedCacheFactory = new FakeXContentCacheFactory();
    const toleratedFactory = new ConnectorFactory(database, {
      credentialCipher: credentialCipher(),
      telegramClientFactory: new FakeTelegramClientFactory(),
      xApiClientFactory: toleratedApiClientFactory,
      xContentCacheFactory: toleratedCacheFactory,
      cacheCoverageToleranceMs: 600_000,
    });
    const toleratedHandle = await toleratedFactory.forSource(source, user.id);
    // A head sliver under the tolerance with real coverage behind it is
    // suppressed only when the configured tolerance reaches the connector.
    toleratedCacheFactory.gaps.set("x:list:1001", [
      { from: windowFrom, to: windowFrom + 500 },
    ]);
    await toleratedHandle.connector.getRawData(windowFrom, windowTo, [
      "x:list:1001",
    ]);
    assertEquals(
      toleratedApiClientFactory.pageCalls,
      [],
      "a threaded tolerance must suppress the head sliver",
    );
    await toleratedHandle.dispose?.();

    const exactApiClientFactory = new FakeXApiClientFactory();
    const exactCacheFactory = new FakeXContentCacheFactory();
    const exactFactory = new ConnectorFactory(database, {
      credentialCipher: credentialCipher(),
      telegramClientFactory: new FakeTelegramClientFactory(),
      xApiClientFactory: exactApiClientFactory,
      xContentCacheFactory: exactCacheFactory,
      cacheCoverageToleranceMs: 0,
    });
    const exactHandle = await exactFactory.forSource(source, user.id);
    exactCacheFactory.gaps.set("x:list:1001", [
      { from: windowFrom, to: windowFrom + 500 },
    ]);
    await exactHandle.connector.getRawData(windowFrom, windowTo, [
      "x:list:1001",
    ]);
    assertEquals(exactApiClientFactory.pageCalls, [
      {
        op: "list",
        listId: "1001",
        from: windowFrom,
        to: windowFrom + 500,
        cursor: null,
      },
    ]);
    await exactHandle.dispose?.();
  });
});

test("ConnectorFactory rejects non-owner and disconnected sources without exposing credentials", async () => {
  await withTestDb(async (database) => {
    const { source } = await createUserAndSource(
      database,
      "connector-owner@example.com",
    );
    const otherUser = await createUser(
      database,
      userInput("connector-other@example.com"),
    );
    const factory = new ConnectorFactory(database, {
      credentialCipher: credentialCipher(),
      telegramClientFactory: new FakeTelegramClientFactory(),
    });

    await assertRejects(
      () => factory.forSource(source, otherUser.id),
      NotFoundError,
      "source not found",
    );

    await deleteSourceCredentials(database, source.id, source.userId);
    await assertRejects(
      () => factory.forSource(source, source.userId),
      ConflictError,
      "source is disconnected",
    );
  });
});

test("ConnectorFactory rejects unsupported connectors", async () => {
  await withTestDb(async (database) => {
    const { user, source } = await createUserAndSource(
      database,
      "connector-unsupported@example.com",
      ConnectorId.RSS,
    );
    const factory = new ConnectorFactory(database, {
      credentialCipher: credentialCipher(),
      telegramClientFactory: new FakeTelegramClientFactory(),
    });

    await assertRejects(
      () => factory.forSource(source, user.id),
      ConflictError,
      "connector is not supported",
    );
  });
});
