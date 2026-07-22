import { test } from "bun:test";
import { assertEquals, assertRejects } from "../assertions.ts"
import { ConnectorId } from "../../src/constants.ts";
import { CredentialCipher, type EncryptedBlob } from "../../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../src/crypto/key-provider.ts";
import type { Database } from "../../src/db/client.ts";
import { withTestDb } from "../../src/db/testing.ts";
import {
  deleteDigestForUser,
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

test("digest repository creates and updates one digest per user period", async () => {
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

test("digest repository lists and finds digests only for the owner", async () => {
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

test("digest repository lists digests latest-first by periodEndMs then createdAt", async () => {
  await withTestDb(async (database) => {
    const user = await createUserWithSource(database, "digest-order@example.com");

    // Create three digests with varying periodEndMs and createdAt.
    // periodEndMs descending should be the primary sort key,
    // createdAt descending the tiebreaker.
    const digestA = await upsertDigestForPeriod(database, {
      userId: user.id,
      periodStartMs: 1_701_000_000_000,
      periodEndMs: 1_701_086_400_000,
      status: "complete",
    }, 1_701_100_000_000);

    const digestB = await upsertDigestForPeriod(database, {
      userId: user.id,
      periodStartMs: 1_700_000_000_000,
      periodEndMs: 1_700_086_400_000,
      status: "failed",
    }, 1_700_100_000_000);

    // Same periodEndMs as digestB, but later createdAt — should sort before B.
    const digestC = await upsertDigestForPeriod(database, {
      userId: user.id,
      periodStartMs: 1_699_900_000_000,
      periodEndMs: 1_700_086_400_000,
      status: "pending",
    }, 1_700_200_000_000);

    const listed = await listDigestsForUser(database, user.id);
    const ids = listed.map((d) => d.id);

    // Latest periodEndMs first: digestA (#1).
    // Same periodEndMs: digestC (later createdAt) before digestB.
    assertEquals(ids, [digestA.id, digestC.id, digestB.id]);
    assertEquals(listed.length, 3);
  });
});

test("digest check constraint rejects invalid status at database level", async () => {
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

test("digest check constraint rejects reversed period order", async () => {
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

test("deleteDigestForUser deletes an owned digest and returns it", async () => {
  await withTestDb(async (database) => {
    const user = await createUserWithSource(database, "digest-delete@example.com");
    const digest = await upsertDigestForPeriod(database, {
      userId: user.id,
      periodStartMs,
      periodEndMs,
      status: "complete",
    }, 100);

    const result = await deleteDigestForUser(database, digest.id, user.id);
    assertEquals(result.id, digest.id);

    // Verify it's gone for the owner
    assertEquals(await findDigestById(database, digest.id, user.id), null);
  });
});

test("deleteDigestForUser throws NotFoundError for non-owner", async () => {
  await withTestDb(async (database) => {
    const firstUser = await createUserWithSource(database, "digest-delete-first@example.com");
    const secondUser = await createUserWithSource(database, "digest-delete-second@example.com");
    const digest = await upsertDigestForPeriod(database, {
      userId: firstUser.id,
      periodStartMs,
      periodEndMs,
      status: "complete",
    }, 100);

    await assertRejects(
      () => deleteDigestForUser(database, digest.id, secondUser.id),
      "digest not found",
    );

    // Verify it still exists for the owner
    const stillExists = await findDigestById(database, digest.id, firstUser.id);
    assertEquals(stillExists?.id, digest.id);
  });
});
