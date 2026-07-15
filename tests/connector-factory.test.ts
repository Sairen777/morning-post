import { assertEquals, assertRejects } from "@std/assert";
import { ConnectorId } from "../src/constants.ts";
import { ConnectorFactory, type TelegramClientFactory, type TelegramClientHandle } from "../src/connectors/connector-factory.ts";
import { CredentialCipher, type EncryptedBlob } from "../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../src/crypto/key-provider.ts";
import type { Database } from "../src/db/client.ts";
import { withTestDb } from "../src/db/testing.ts";
import { createSource, deleteSourceCredentials } from "../src/repositories/source-repository.ts";
import { createUser, type CreateUserInput } from "../src/repositories/user-repository.ts";
import { ConflictError, NotFoundError } from "../src/server/errors.ts";

class FakeTelegramClientFactory implements TelegramClientFactory {
  readonly sessions: string[] = [];
  disconnectCount = 0;

  createClientFromSession(sessionString: string): Promise<TelegramClientHandle> {
    this.sessions.push(sessionString);
    const client = {
      disconnect: () => {
        this.disconnectCount += 1;
      },
    } as unknown as TelegramClientHandle;
    return Promise.resolve(client);
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
  return new CredentialCipher(new EnvMasterKeyProvider(new Uint8Array(32).fill(31)));
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

Deno.test("ConnectorFactory builds a Telegram connector from encrypted credentials and disposes it", async () => {
  await withTestDb(async (database) => {
    const { user, source } = await createUserAndSource(database, "connector-factory@example.com");
    const fakeTelegramClientFactory = new FakeTelegramClientFactory();
    const factory = new ConnectorFactory(database, {
      credentialCipher: credentialCipher(),
      telegramClientFactory: fakeTelegramClientFactory,
    });

    const handle = await factory.forSource(source, user.id);
    assertEquals(typeof handle.connector.getNormalizedData, "function");
    assertEquals(fakeTelegramClientFactory.sessions, ["telegram-session"]);

    await handle.dispose?.();
    assertEquals(fakeTelegramClientFactory.disconnectCount, 1);
  });
});

Deno.test("ConnectorFactory rejects non-owner and disconnected sources without exposing credentials", async () => {
  await withTestDb(async (database) => {
    const { source } = await createUserAndSource(database, "connector-owner@example.com");
    const otherUser = await createUser(database, userInput("connector-other@example.com"));
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

Deno.test("ConnectorFactory rejects unsupported connectors", async () => {
  await withTestDb(async (database) => {
    const { user, source } = await createUserAndSource(database, "connector-unsupported@example.com", ConnectorId.RSS);
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
