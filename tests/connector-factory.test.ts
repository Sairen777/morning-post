import { test } from "bun:test";
import { assertEquals, assertRejects } from "./assertions.ts";
import { ConnectorId } from "../src/constants.ts";
import {
  ConnectorFactory,
  type SubstackClientFactory,
  type TelegramClientFactory,
  type TelegramClientHandle,
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
