import { test } from "bun:test";
import { assertEquals, assertRejects } from "../assertions.ts"
import { ConnectorId } from "../../src/constants.ts";
import { CredentialCipher } from "../../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../src/crypto/key-provider.ts";
import { withTestDb } from "../../src/db/testing.ts";
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
