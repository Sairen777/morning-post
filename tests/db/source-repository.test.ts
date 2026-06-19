import { assert,
assertEquals,
assertExists,
assertRejects, } from "@std/assert"
import { eq } from "drizzle-orm";
import { ConnectorId } from "../../src/constants.ts";
import { CredentialCipher, type EncryptedBlob } from "../../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../src/crypto/key-provider.ts";
import { withTestDb } from "../../src/db/testing.ts";
import { sources } from "../../src/db/schema/source.ts";
import { credentialSchemaFor } from "../../src/connectors/credential-schemas.ts";
import { createUser, type CreateUserInput } from "../../src/repositories/user-repository.ts";
import {
  createSource,
  deleteSourceCredentials,
  findSourceById,
  getDecryptedCredentials,
  listSourcesForUser,
  updateSource,
} from "../../src/repositories/source-repository.ts";
import { ConflictError, NotFoundError, ValidationError } from "../../src/server/errors.ts";

const telegramCredentials = { sessionString: "telegram-session-secret-2.1" };

function userInput(email: string): CreateUserInput {
  return {
    name: "Source Owner",
    email,
    passwordHash: "$argon2id$fakehash",
    systemPrompt: "Summarize tersely.",
    defaultLanguage: "en",
    defaultModel: "gpt-4o-mini",
  };
}

function generateCipher(): CredentialCipher {
  return new CredentialCipher(new EnvMasterKeyProvider(crypto.getRandomValues(new Uint8Array(32))));
}

async function encryptedTelegramCredentials(
  cipher: CredentialCipher,
  userId: string,
  connectorId: ConnectorId = ConnectorId.Telegram,
): Promise<EncryptedBlob> {
  const parsed = credentialSchemaFor(ConnectorId.Telegram).parse(telegramCredentials);
  return await cipher.encrypt(JSON.stringify(parsed), { userId, connectorId });
}

Deno.test("source repository encrypts at rest and decrypts with owner-bound context", async () => {
  await withTestDb(async (database) => {
    const cipher = generateCipher();
    const user = await createUser(database, userInput("source-owner@example.com"));
    const encrypted = await encryptedTelegramCredentials(cipher, user.id);

    const created = await createSource(database, {
      userId: user.id,
      connectorId: ConnectorId.Telegram,
      credentials: encrypted,
      position: 2,
    });

    assertEquals(created.userId, user.id);
    assertEquals(created.connectorId, ConnectorId.Telegram);
    assertEquals(created.enabled, true);
    assert(!("credentials" in created));

    const rows = await database
      .select({ credentials: sources.credentials })
      .from(sources)
      .where(eq(sources.id, created.id))
      .limit(1);
    assertExists(rows[0]);
    assertEquals(typeof rows[0].credentials, "object");
    assert(!JSON.stringify(rows[0].credentials).includes(telegramCredentials.sessionString));

    const decrypted = await getDecryptedCredentials(database, created.id, user.id, cipher);
    assertEquals(decrypted, telegramCredentials);
  });
});

Deno.test("source repository enforces one connector source per user only", async () => {
  await withTestDb(async (database) => {
    const cipher = generateCipher();
    const firstUser = await createUser(database, userInput("first-source@example.com"));
    const secondUser = await createUser(database, userInput("second-source@example.com"));

    await createSource(database, {
      userId: firstUser.id,
      connectorId: ConnectorId.Telegram,
      credentials: await encryptedTelegramCredentials(cipher, firstUser.id),
    });

    const otherUserSource = await createSource(database, {
      userId: secondUser.id,
      connectorId: ConnectorId.Telegram,
      credentials: await encryptedTelegramCredentials(cipher, secondUser.id),
    });
    assertEquals(otherUserSource.userId, secondUser.id);

    await assertRejects(
      async () =>
        await createSource(database, {
          userId: firstUser.id,
          connectorId: ConnectorId.Telegram,
          credentials: await encryptedTelegramCredentials(cipher, firstUser.id),
        }),
      ConflictError,
      "source already exists for connector",
    );
  });
});

Deno.test("source repository hides credentials in public list shape", async () => {
  await withTestDb(async (database) => {
    const cipher = generateCipher();
    const user = await createUser(database, userInput("list-source@example.com"));

    await createSource(database, {
      userId: user.id,
      connectorId: ConnectorId.Telegram,
      credentials: await encryptedTelegramCredentials(cipher, user.id),
      position: 1,
    });

    const listed = await listSourcesForUser(database, user.id);
    assertEquals(listed.length, 1);
    assert(!("credentials" in listed[0]));
    assertEquals(Object.keys(listed[0]).includes("credentials"), false);
  });
});

Deno.test("source repository finds, updates, and orders public source rows", async () => {
  await withTestDb(async (database) => {
    const cipher = generateCipher();
    const user = await createUser(database, userInput("update-source@example.com"));
    const telegram = await createSource(database, {
      userId: user.id,
      connectorId: ConnectorId.Telegram,
      credentials: await encryptedTelegramCredentials(cipher, user.id),
      position: 2,
    });
    const rss = await createSource(database, {
      userId: user.id,
      connectorId: ConnectorId.RSS,
      credentials: await encryptedTelegramCredentials(cipher, user.id, ConnectorId.RSS),
      position: 3,
    });

    const updated = await updateSource(database, rss.id, user.id, {
      enabled: false,
      position: 1,
    });
    assertEquals(updated.enabled, false);
    assertEquals(updated.position, 1);
    assert(!("credentials" in updated));

    const found = await findSourceById(database, rss.id, user.id);
    assertExists(found);
    assertEquals(found.id, rss.id);
    assertEquals(found.enabled, false);

    const listed = await listSourcesForUser(database, user.id);
    assertEquals(listed.map((source) => source.id), [rss.id, telegram.id]);
  });
});

Deno.test("getDecryptedCredentials rejects non-owners as not found", async () => {
  await withTestDb(async (database) => {
    const cipher = generateCipher();
    const owner = await createUser(database, userInput("credential-owner@example.com"));
    const otherUser = await createUser(database, userInput("credential-other@example.com"));
    const source = await createSource(database, {
      userId: owner.id,
      connectorId: ConnectorId.Telegram,
      credentials: await encryptedTelegramCredentials(cipher, owner.id),
    });

    await assertRejects(
      () => getDecryptedCredentials(database, source.id, otherUser.id, cipher),
      NotFoundError,
      "source not found",
    );
  });
});

Deno.test("deleteSourceCredentials disconnects by wiping credentials and disabling source", async () => {
  await withTestDb(async (database) => {
    const cipher = generateCipher();
    const user = await createUser(database, userInput("disconnect-source@example.com"));
    const source = await createSource(database, {
      userId: user.id,
      connectorId: ConnectorId.Telegram,
      credentials: await encryptedTelegramCredentials(cipher, user.id),
    });

    const disconnected = await deleteSourceCredentials(database, source.id, user.id);
    assertEquals(disconnected.enabled, false);
    assert(!("credentials" in disconnected));

    const rows = await database
      .select({ credentials: sources.credentials, enabled: sources.enabled })
      .from(sources)
      .where(eq(sources.id, source.id))
      .limit(1);
    assertExists(rows[0]);
    assertEquals(rows[0].credentials, null);
    assertEquals(rows[0].enabled, false);

    await assertRejects(
      () => getDecryptedCredentials(database, source.id, user.id, cipher),
      ConflictError,
      "source is disconnected",
    );
  });
});

Deno.test("getDecryptedCredentials surfaces invalid encrypted blob shape clearly", async () => {
  await withTestDb(async (database) => {
    const cipher = generateCipher();
    const user = await createUser(database, userInput("invalid-blob@example.com"));
    const source = await createSource(database, {
      userId: user.id,
      connectorId: ConnectorId.Telegram,
      credentials: await encryptedTelegramCredentials(cipher, user.id),
    });

    await database
      .update(sources)
      .set({ credentials: { notAnEncryptedBlob: true } as unknown as EncryptedBlob })
      .where(eq(sources.id, source.id));

    await assertRejects(
      () => getDecryptedCredentials(database, source.id, user.id, cipher),
      ValidationError,
      "invalid encrypted source credentials",
    );
  });
});

Deno.test("getDecryptedCredentials fails when blob was encrypted for a different owner context", async () => {
  await withTestDb(async (database) => {
    const cipher = generateCipher();
    const user = await createUser(database, userInput("wrong-owner@example.com"));
    const wrongOwnerBlob = await encryptedTelegramCredentials(cipher, user.id, ConnectorId.RSS);
    const source = await createSource(database, {
      userId: user.id,
      connectorId: ConnectorId.Telegram,
      credentials: wrongOwnerBlob,
    });

    await assertRejects(
      () => getDecryptedCredentials(database, source.id, user.id, cipher),
      ValidationError,
      "source credentials could not be decrypted",
    );
  });
});

Deno.test("source check constraint rejects enabled source with null credentials", async () => {
  await withTestDb(async (database) => {
    const cipher = generateCipher();
    const user = await createUser(database, userInput("source-check@example.com"));
    const source = await createSource(database, {
      userId: user.id,
      connectorId: ConnectorId.Telegram,
      credentials: await encryptedTelegramCredentials(cipher, user.id),
    });

    await assertRejects(
      () => database.update(sources).set({ credentials: null, enabled: true }).where(eq(sources.id, source.id)),
    );
  });
});
