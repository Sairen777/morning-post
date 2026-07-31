import { test } from "bun:test";
import { assertEquals, assertThrows } from "../assertions.ts"
import { ConnectorId } from "../../src/constants.ts";
import { CredentialCipher, type EncryptedBlob } from "../../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../src/crypto/key-provider.ts";
import type { Database } from "../../src/db/client.ts";
import { withTestDb } from "../../src/db/testing.ts";
import {
  deleteDigestForUser,
  findDigestById,
  findDigestForUserPeriod,
  listDigestPageForUser,
  listDigestsForUser,
  setDigestStatus,
  upsertDigestForPeriod,
  type PublicDigest,
} from "../../src/repositories/digest-repository.ts";
import { ValidationError } from "../../src/server/errors.ts";
import { createSource } from "../../src/repositories/source-repository.ts";
import { digests } from "../../src/db/schema/digest.ts";
import { createUser, type CreateUserInput } from "../../src/repositories/user-repository.ts";
import {
  createDigestRun,
  finishDigestRun,
} from "../../src/repositories/digest-run-repository.ts";

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

    const olderRun = await createDigestRun(database, {
      userId: firstUser.id,
      trigger: "manual",
      periodStartMs,
      periodEndMs,
      status: "running",
    }, 100);
    await finishDigestRun(database, olderRun.id, {
      digestId: firstDigest.id,
      status: "complete",
    }, 200);
    const latestRun = await createDigestRun(database, {
      userId: firstUser.id,
      trigger: "manual",
      periodStartMs,
      periodEndMs,
      status: "running",
    }, 300);
    await finishDigestRun(database, latestRun.id, {
      digestId: firstDigest.id,
      status: "complete",
    }, 425);

    const listed = await listDigestsForUser(database, firstUser.id);
    assertEquals(listed.map((digest) => digest.id), [firstDigest.id]);
    assertEquals(listed[0].latestRunStartedAt, 300);
    assertEquals(listed[0].latestRunFinishedAt, 425);

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

    assertThrows(() => upsertDigestForPeriod(database, {
      userId: user.id,
      periodStartMs,
      periodEndMs,
      status: "unknown" as typeof digests.$inferSelect["status"],
    }), );
  });
});

test("digest check constraint rejects reversed period order", async () => {
  await withTestDb(async (database) => {
    const user = await createUserWithSource(database, "digest-check-period@example.com");

    assertThrows(() => upsertDigestForPeriod(database, {
      userId: user.id,
      periodStartMs: periodEndMs,
      periodEndMs: periodStartMs,
      status: "pending",
    }), );
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

interface DigestOrderFixture {
  digestA: PublicDigest;
  digestB: PublicDigest;
  digestC: PublicDigest;
  digestD: PublicDigest;
  digestE: PublicDigest;
  tieFirst: PublicDigest;
  tieSecond: PublicDigest;
}

/**
 * Seven digests whose request order (createdAt) differs from their coverage
 * order (periodEndMs). The tie pair shares both createdAt and periodEndMs so
 * the digest-id tie-break is observable for every sort.
 */
async function createDigestOrderFixture(
  database: Database,
  userId: string,
): Promise<DigestOrderFixture> {
  const digestA = await upsertDigestForPeriod(database, {
    userId,
    periodStartMs: 1_700_000_000_000,
    periodEndMs: 1_700_086_400_000,
    status: "complete",
  }, 10);
  const digestB = await upsertDigestForPeriod(database, {
    userId,
    periodStartMs: 1_700_086_400_000,
    periodEndMs: 1_700_172_800_000,
    status: "complete",
  }, 30);
  const digestC = await upsertDigestForPeriod(database, {
    userId,
    periodStartMs: 1_700_172_800_000,
    periodEndMs: 1_700_259_200_000,
    status: "complete",
  }, 20);
  const digestD = await upsertDigestForPeriod(database, {
    userId,
    periodStartMs: 1_700_259_200_000,
    periodEndMs: 1_700_345_600_000,
    status: "complete",
  }, 40);
  const digestE = await upsertDigestForPeriod(database, {
    userId,
    periodStartMs: 1_700_345_600_000,
    periodEndMs: 1_700_432_000_000,
    status: "complete",
  }, 50);
  const tieFirst = await upsertDigestForPeriod(database, {
    userId,
    periodStartMs: 1_700_400_000_000,
    periodEndMs: 1_700_500_000_000,
    status: "complete",
  }, 60);
  const tieSecond = await upsertDigestForPeriod(database, {
    userId,
    periodStartMs: 1_700_450_000_000,
    periodEndMs: 1_700_500_000_000,
    status: "complete",
  }, 60);
  return { digestA, digestB, digestC, digestD, digestE, tieFirst, tieSecond };
}

/** Cursor-shaped like the pre-redesign v1 payloads, which must stay rejected. */
function legacyDigestCursor(): string {
  const payload = {
    v: 1,
    k: "digest",
    p: 1_700_086_400_000,
    c: 10,
    i: "00000000-0000-0000-0000-000000000001",
  };
  return btoa(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

test("digest repository pages by request order by default with a deterministic id tie-break", async () => {
  await withTestDb(async (database) => {
    const user = await createUserWithSource(database, "digest-page-request@example.com");
    const fixture = await createDigestOrderFixture(database, user.id);
    const tieAsc = [fixture.tieFirst.id, fixture.tieSecond.id].sort();
    const tieDesc = [...tieAsc].reverse();

    // No sort option: newest request first, then digest id descending.
    const defaultPage = listDigestPageForUser(database, user.id);
    assertEquals(
      defaultPage.data.map((digest) => digest.id),
      [
        tieDesc[0],
        tieDesc[1],
        fixture.digestE.id,
        fixture.digestD.id,
        fixture.digestB.id,
        fixture.digestC.id,
        fixture.digestA.id,
      ],
    );

    const ascendingPage = listDigestPageForUser(database, user.id, {
      sort: "requested_asc",
    });
    assertEquals(
      ascendingPage.data.map((digest) => digest.id),
      [
        fixture.digestA.id,
        fixture.digestC.id,
        fixture.digestB.id,
        fixture.digestD.id,
        fixture.digestE.id,
        tieAsc[0],
        tieAsc[1],
      ],
    );
  });
});

test("digest repository pages by period end for period sorts with a deterministic id tie-break", async () => {
  await withTestDb(async (database) => {
    const user = await createUserWithSource(database, "digest-page-period@example.com");
    const fixture = await createDigestOrderFixture(database, user.id);
    const tieAsc = [fixture.tieFirst.id, fixture.tieSecond.id].sort();
    const tieDesc = [...tieAsc].reverse();

    const descendingPage = listDigestPageForUser(database, user.id, {
      sort: "period_desc",
    });
    assertEquals(
      descendingPage.data.map((digest) => digest.id),
      [
        tieDesc[0],
        tieDesc[1],
        fixture.digestE.id,
        fixture.digestD.id,
        fixture.digestC.id,
        fixture.digestB.id,
        fixture.digestA.id,
      ],
    );

    const ascendingPage = listDigestPageForUser(database, user.id, {
      sort: "period_asc",
    });
    assertEquals(
      ascendingPage.data.map((digest) => digest.id),
      [
        fixture.digestA.id,
        fixture.digestB.id,
        fixture.digestC.id,
        fixture.digestD.id,
        fixture.digestE.id,
        tieAsc[0],
        tieAsc[1],
      ],
    );
  });
});

test("digest repository paginates without duplicates or skips and closes the cursor trail", async () => {
  await withTestDb(async (database) => {
    const user = await createUserWithSource(database, "digest-page-walk@example.com");
    const fixture = await createDigestOrderFixture(database, user.id);
    const tieAsc = [fixture.tieFirst.id, fixture.tieSecond.id].sort();
    const tieDesc = [...tieAsc].reverse();
    const expectedOrder = [
      tieDesc[0],
      tieDesc[1],
      fixture.digestE.id,
      fixture.digestD.id,
      fixture.digestB.id,
      fixture.digestC.id,
      fixture.digestA.id,
    ];

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const page = listDigestPageForUser(database, user.id, {
        cursor: cursor ?? undefined,
        limit: 2,
      });
      assertEquals(page.data.length <= 2, true);
      seen.push(...page.data.map((digest) => digest.id));
      pages += 1;
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }

    assertEquals(pages, 4);
    assertEquals(seen, expectedOrder);
    assertEquals(new Set(seen).size, seen.length);
  });
});

test("digest repository rejects cross-sort, legacy, and malformed cursors", async () => {
  await withTestDb(async (database) => {
    const user = await createUserWithSource(database, "digest-page-cursor@example.com");
    const fixture = await createDigestOrderFixture(database, user.id);
    const firstPage = listDigestPageForUser(database, user.id, { limit: 2 });
    assertEquals(firstPage.nextCursor !== null, true);
    const cursor = firstPage.nextCursor!;

    // Positive control: the same cursor resumes the same sort.
    const resumed = listDigestPageForUser(database, user.id, {
      cursor,
      limit: 2,
      sort: "requested_desc",
    });
    assertEquals(
      resumed.data.map((digest) => digest.id),
      [fixture.digestE.id, fixture.digestD.id],
    );

    // A cursor minted under one sort must never resume another sort.
    for (const sort of ["requested_asc", "period_desc", "period_asc"] as const) {
      assertThrows(
        () => listDigestPageForUser(database, user.id, { cursor, sort }),
        ValidationError,
        "Invalid cursor",
      );
    }

    // Pre-redesign v1 payloads stay rejected.
    assertThrows(
      () => listDigestPageForUser(database, user.id, { cursor: legacyDigestCursor() }),
      ValidationError,
      "Invalid cursor",
    );

    // Malformed payloads stay rejected.
    for (const malformed of ["%%%not-base64%%%", "not-a-cursor"]) {
      assertThrows(
        () => listDigestPageForUser(database, user.id, { cursor: malformed }),
        ValidationError,
        "Invalid cursor",
      );
    }
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

    assertThrows(() => deleteDigestForUser(database, digest.id, secondUser.id), "digest not found",);

    // Verify it still exists for the owner
    const stillExists = await findDigestById(database, digest.id, firstUser.id);
    assertEquals(stillExists?.id, digest.id);
  });
});
