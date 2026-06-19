import { assertEquals, assertRejects } from "@std/assert";
import { ConnectorId } from "../../src/constants.ts";
import { CredentialCipher, type EncryptedBlob } from "../../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../src/crypto/key-provider.ts";
import type { Database } from "../../src/db/client.ts";
import { withTestDb } from "../../src/db/testing.ts";
import {
  findDigestById,
  findDigestForUserPeriod,
  listDigestsForUser,
  setDigestStatus,
  upsertDigestForPeriod,
} from "../../src/repositories/digest-repository.ts";
import { createSource } from "../../src/repositories/source-repository.ts";
import { digests } from "../../src/db/schema/digest.ts";
import { createUser, type CreateUserInput } from "../../src/repositories/user-repository.ts";

function userInput(email: string): CreateUserInput {
  return {
    name: "Digest Owner",
    email,
    passwordHash: "$argon2id$fakehash",
    systemPrompt: "Summarize tersely.",
    defaultLanguage: "en",
    defaultModel: "gpt-4o-mini",
  };
}

function credentialCipher(): CredentialCipher {
  return new CredentialCipher(new EnvMasterKeyProvider(new Uint8Array(32).fill(43)));
}

async function encryptedCredentials(userId: string): Promise<EncryptedBlob> {
  return await credentialCipher().encrypt(JSON.stringify({ sessionString: "telegram-session" }), {
    userId,
    connectorId: ConnectorId.Telegram,
  });
}

async function createUserWithSource(database: Database, email: string) {
  const user = await createUser(database, userInput(email));
  await createSource(database, {
    userId: user.id,
    connectorId: ConnectorId.Telegram,
    credentials: await encryptedCredentials(user.id),
  });
  return user;
}

const periodStartMs = 1_700_000_000_000;
const periodEndMs = 1_700_086_400_000;

Deno.test("digest repository creates and updates one digest per user period", async () => {
  await withTestDb(async (database) => {
    const user = await createUserWithSource(database, "digest-upsert@example.com");
    const pending = await upsertDigestForPeriod(database, {
      userId: user.id,
      periodStartMs,
      periodEndMs,
      status: "pending",
    }, 10);
    const complete = await setDigestStatus(database, pending.id, user.id, "complete", 20);
    const rerun = await upsertDigestForPeriod(database, {
      userId: user.id,
      periodStartMs,
      periodEndMs,
      status: "pending",
    }, 30);

    assertEquals(complete.status, "complete");
    assertEquals(complete.updatedAt, 20);
    assertEquals(rerun.id, pending.id);
    assertEquals(rerun.createdAt, pending.createdAt);
    assertEquals(rerun.status, "pending");
    assertEquals(rerun.updatedAt, 30);
  });
});

Deno.test("digest repository lists and finds digests only for the owner", async () => {
  await withTestDb(async (database) => {
    const firstUser = await createUserWithSource(database, "digest-first@example.com");
    const secondUser = await createUserWithSource(database, "digest-second@example.com");
    const firstDigest = await upsertDigestForPeriod(database, {
      userId: firstUser.id,
      periodStartMs,
      periodEndMs,
      status: "complete",
    }, 10);
    await upsertDigestForPeriod(database, {
      userId: secondUser.id,
      periodStartMs,
      periodEndMs,
      status: "failed",
    }, 20);

    const listed = await listDigestsForUser(database, firstUser.id);
    assertEquals(listed.map((digest) => digest.id), [firstDigest.id]);

    assertEquals(await findDigestById(database, firstDigest.id, secondUser.id), null);
    assertEquals((await findDigestForUserPeriod(database, secondUser.id, periodStartMs, periodEndMs))?.status, "failed");
  });
});

Deno.test("digest check constraint rejects invalid status at database level", async () => {
  await withTestDb(async (database) => {
    const user = await createUserWithSource(database, "digest-check-status@example.com");

    await assertRejects(
      () => upsertDigestForPeriod(database, {
        userId: user.id,
        periodStartMs,
        periodEndMs,
        status: "unknown" as typeof digests.$inferSelect["status"],
      }),
    );
  });
});

Deno.test("digest check constraint rejects reversed period order", async () => {
  await withTestDb(async (database) => {
    const user = await createUserWithSource(database, "digest-check-period@example.com");

    await assertRejects(
      () => upsertDigestForPeriod(database, {
        userId: user.id,
        periodStartMs: periodEndMs,
        periodEndMs: periodStartMs,
        status: "pending",
      }),
    );
  });
});
