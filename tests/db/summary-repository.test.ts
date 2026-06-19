import { assertEquals, assertRejects } from "@std/assert";
import { ConnectorId } from "../../src/constants.ts";
import { CredentialCipher, type EncryptedBlob } from "../../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../src/crypto/key-provider.ts";
import type { Database } from "../../src/db/client.ts";
import { withTestDb } from "../../src/db/testing.ts";
import { createOrReviveFeed, softDeleteFeed } from "../../src/repositories/feed-repository.ts";
import {
  findSummaryForFeedPeriod,
  listSummariesForUserPeriod,
  summaryPointSchema,
  upsertSummaryForPeriod,
} from "../../src/repositories/summary-repository.ts";
import { createSource } from "../../src/repositories/source-repository.ts";
import { createUser, type CreateUserInput } from "../../src/repositories/user-repository.ts";
import { summaries } from "../../src/db/schema/summary.ts";
import { z } from "zod";

function userInput(email: string): CreateUserInput {
  return {
    name: "Summary Owner",
    email,
    passwordHash: "$argon2id$fakehash",
    systemPrompt: "Summarize tersely.",
    defaultLanguage: "en",
    defaultModel: "gpt-4o-mini",
  };
}

function credentialCipher(): CredentialCipher {
  return new CredentialCipher(new EnvMasterKeyProvider(new Uint8Array(32).fill(37)));
}

async function encryptedCredentials(userId: string): Promise<EncryptedBlob> {
  return await credentialCipher().encrypt(JSON.stringify({ sessionString: "telegram-session" }), {
    userId,
    connectorId: ConnectorId.Telegram,
  });
}

async function createFeed(database: Database, email: string, position = 1) {
  const user = await createUser(database, userInput(email));
  const source = await createSource(database, {
    userId: user.id,
    connectorId: ConnectorId.Telegram,
    credentials: await encryptedCredentials(user.id),
    position,
  });
  const feed = await createOrReviveFeed(database, {
    userId: user.id,
    sourceId: source.id,
    externalId: `channel:${position}`,
    name: `Channel ${position}`,
    kind: "news",
    position,
  });
  return { user, source, feed };
}

const periodStartMs = 1_700_000_000_000;
const periodEndMs = 1_700_086_400_000;
const points = [{ text: "summary", sourceUrl: "https://t.me/channel/1" }];

Deno.test("summary repository inserts and finds summaries for a feed period", async () => {
  await withTestDb(async (database) => {
    const { feed } = await createFeed(database, "summary-find@example.com");
    const summary = await upsertSummaryForPeriod(database, {
      feedId: feed.id,
      periodStartMs,
      periodEndMs,
      points,
      feedNameSnapshot: feed.name,
    }, 123);

    assertEquals(summary.feedNameSnapshot, feed.name);
    assertEquals(summary.generatedAt, 123);
    assertEquals(summary.points, points);

    const found = await findSummaryForFeedPeriod(database, feed.id, periodStartMs, periodEndMs);
    assertEquals(found, summary);
  });
});

Deno.test("summary repository overwrites repeated feed periods without duplicating rows", async () => {
  await withTestDb(async (database) => {
    const { feed } = await createFeed(database, "summary-overwrite@example.com");
    await upsertSummaryForPeriod(database, {
      feedId: feed.id,
      periodStartMs,
      periodEndMs,
      points,
      feedNameSnapshot: feed.name,
    }, 10);
    const overwritten = await upsertSummaryForPeriod(database, {
      feedId: feed.id,
      periodStartMs,
      periodEndMs,
      points: [{ text: "updated", sourceUrl: null }],
      feedNameSnapshot: "Snapshot",
    }, 20);

    assertEquals(overwritten.points, [{ text: "updated", sourceUrl: null }]);
    assertEquals(overwritten.feedNameSnapshot, "Snapshot");
    assertEquals(overwritten.generatedAt, 20);

    const listed = await listSummariesForUserPeriod(database, (await createFeed(database, "another-user@example.com")).user.id, periodStartMs, periodEndMs);
    assertEquals(listed, []);
    const found = await findSummaryForFeedPeriod(database, feed.id, periodStartMs, periodEndMs);
    assertEquals(found?.points, [{ text: "updated", sourceUrl: null }]);
  });
});

Deno.test("listSummariesForUserPeriod includes soft-deleted feeds for history and scopes to owner", async () => {
  await withTestDb(async (database) => {
    const first = await createFeed(database, "summary-list-first@example.com", 2);
    const second = await createFeed(database, "summary-list-second@example.com", 1);
    await upsertSummaryForPeriod(database, {
      feedId: first.feed.id,
      periodStartMs,
      periodEndMs,
      points,
      feedNameSnapshot: first.feed.name,
    });
    await upsertSummaryForPeriod(database, {
      feedId: second.feed.id,
      periodStartMs,
      periodEndMs,
      points,
      feedNameSnapshot: second.feed.name,
    });
    await softDeleteFeed(database, second.feed.id, second.user.id);

    const secondUserSummaries = await listSummariesForUserPeriod(database, second.user.id, periodStartMs, periodEndMs);
    assertEquals(secondUserSummaries.length, 1);
    assertEquals(secondUserSummaries[0].feedDeletedAt !== null, true);

    const firstUserSummaries = await listSummariesForUserPeriod(database, first.user.id, periodStartMs, periodEndMs);
    assertEquals(firstUserSummaries.length, 1);
    assertEquals(firstUserSummaries[0].feedDeletedAt, null);
  });
});

Deno.test("summary repository rejects invalid stored points at the boundary", async () => {
  await withTestDb(async (database) => {
    const { feed, user } = await createFeed(database, "summary-invalid@example.com");
    await database.insert(summaries).values({
      feedId: feed.id,
      periodStartMs,
      periodEndMs,
      points: [{ broken: true }] as unknown as typeof summaries.$inferInsert["points"],
      feedNameSnapshot: feed.name,
      generatedAt: 1,
    });

    await assertRejects(
      () => listSummariesForUserPeriod(database, user.id, periodStartMs, periodEndMs),
      z.ZodError,
    );
    await assertRejects(() => Promise.resolve().then(() => summaryPointSchema.parse({ broken: true })), z.ZodError);
  });
});

Deno.test("summary check constraint rejects reversed period order", async () => {
  await withTestDb(async (database) => {
    const { feed } = await createFeed(database, "summary-check-period@example.com");

    await assertRejects(
      () => upsertSummaryForPeriod(database, {
        feedId: feed.id,
        periodStartMs: periodEndMs,
        periodEndMs: periodStartMs,
        points: [],
        feedNameSnapshot: feed.name,
      }),
    );
  });
});
