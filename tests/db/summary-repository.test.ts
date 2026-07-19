import { assertEquals, assertRejects } from "@std/assert";
import { ConnectorId } from "../../src/constants.ts";
import {
  CredentialCipher,
  type EncryptedBlob,
} from "../../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../src/crypto/key-provider.ts";
import type { Database } from "../../src/db/client.ts";
import { withTestDb } from "../../src/db/testing.ts";
import {
  createOrReviveFeed,
  softDeleteFeed,
} from "../../src/repositories/feed-repository.ts";
import {
  findSummaryForFeedPeriod,
  listSummariesForUserPeriod,
  summaryPointSchema,
  upsertSummaryForPeriod,
} from "../../src/repositories/summary-repository.ts";
import {
  createSource,
  updateSource,
} from "../../src/repositories/source-repository.ts";
import {
  createUser,
  type CreateUserInput,
} from "../../src/repositories/user-repository.ts";
import { summaries } from "../../src/db/schema/summary.ts";
import { z } from "zod";

function userInput(email: string): CreateUserInput {
  return {
    name: "Summary Owner",
    email,
    passwordHash: "$argon2id$fakehash",
    systemPrompt: "Summarize tersely.",
    defaultLanguage: "en",
  };
}

function credentialCipher(): CredentialCipher {
  return new CredentialCipher(
    new EnvMasterKeyProvider(new Uint8Array(32).fill(37)),
  );
}

async function encryptedCredentials(
  userId: string,
  connectorId = ConnectorId.Telegram,
): Promise<EncryptedBlob> {
  return await credentialCipher().encrypt(
    JSON.stringify({ sessionString: "telegram-session" }),
    { userId, connectorId },
  );
}

async function createFeed(
  database: Database,
  email: string,
  position = 1,
  connectorId = ConnectorId.Telegram,
) {
  const user = await createUser(database, userInput(email));
  const source = await createSource(database, {
    userId: user.id,
    connectorId,
    credentials: await encryptedCredentials(user.id, connectorId),
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
const aggregateContent = {
  kind: "aggregate" as const,
  points: [{ text: "summary", sourceUrl: "https://t.me/channel/1" }],
};
const articlesContent = {
  kind: "articles" as const,
  articles: [{
    sourceExternalId: "post-1",
    title: "A title",
    sourceUrl: "https://example.com/p/post-1",
    publishedAt: 1_700_000_100_000,
    contentAccess: "preview" as const,
    points: [{
      text: "article summary",
      sourceUrl: "https://example.com/p/post-1",
    }],
  }],
};

Deno.test("summary repository round-trips aggregate content", async () => {
  await withTestDb(async (database) => {
    const { feed } = await createFeed(database, "summary-find@example.com");
    const summary = await upsertSummaryForPeriod(database, {
      feedId: feed.id,
      periodStartMs,
      periodEndMs,
      content: aggregateContent,
      feedNameSnapshot: feed.name,
    }, 123);

    assertEquals(summary.feedNameSnapshot, feed.name);
    assertEquals(summary.generatedAt, 123);
    assertEquals(summary.content, aggregateContent);
    assertEquals(
      await findSummaryForFeedPeriod(
        database,
        feed.id,
        periodStartMs,
        periodEndMs,
      ),
      summary,
    );
  });
});

Deno.test("summary repository round-trips article content", async () => {
  await withTestDb(async (database) => {
    const { feed } = await createFeed(database, "summary-articles@example.com");
    const summary = await upsertSummaryForPeriod(database, {
      feedId: feed.id,
      periodStartMs,
      periodEndMs,
      content: articlesContent,
      feedNameSnapshot: feed.name,
    });

    assertEquals(summary.content, articlesContent);
    assertEquals(
      (await findSummaryForFeedPeriod(
        database,
        feed.id,
        periodStartMs,
        periodEndMs,
      ))?.content,
      articlesContent,
    );
  });
});

Deno.test("summary repository round-trips paid articles and projects the source title preference", async () => {
  await withTestDb(async (database) => {
    const { user, source, feed } = await createFeed(
      database,
      "summary-paid-articles@example.com",
      1,
      ConnectorId.Substack,
    );
    await updateSource(database, source.id, user.id, {
      showPaidPostTitles: true,
    });
    const paidContent = {
      kind: "articles" as const,
      articles: [{
        sourceExternalId: "paid-post-1",
        title: "Paid title",
        sourceUrl: "https://example.substack.com/p/paid-post-1",
        publishedAt: 1_700_000_200_000,
        contentAccess: "paid" as const,
        points: [],
      }],
    };

    const stored = await upsertSummaryForPeriod(database, {
      feedId: feed.id,
      periodStartMs,
      periodEndMs,
      content: paidContent,
      feedNameSnapshot: feed.name,
    });

    assertEquals(stored.content, paidContent);
    assertEquals(
      (await findSummaryForFeedPeriod(
        database,
        feed.id,
        periodStartMs,
        periodEndMs,
      ))?.content,
      paidContent,
    );
    const listed = await listSummariesForUserPeriod(
      database,
      user.id,
      periodStartMs,
      periodEndMs,
    );
    assertEquals(listed.length, 1);
    assertEquals(listed[0].showPaidPostTitles, true);
    assertEquals(listed[0].content, paidContent);
  });
});

Deno.test("summary repository overwrites repeated feed periods without duplicating rows", async () => {
  await withTestDb(async (database) => {
    const { feed } = await createFeed(
      database,
      "summary-overwrite@example.com",
    );
    await upsertSummaryForPeriod(database, {
      feedId: feed.id,
      periodStartMs,
      periodEndMs,
      content: aggregateContent,
      feedNameSnapshot: feed.name,
    }, 10);
    const overwritten = await upsertSummaryForPeriod(database, {
      feedId: feed.id,
      periodStartMs,
      periodEndMs,
      content: {
        kind: "aggregate",
        points: [{ text: "updated", sourceUrl: null }],
      },
      feedNameSnapshot: "Snapshot",
    }, 20);

    assertEquals(overwritten.content, {
      kind: "aggregate",
      points: [{ text: "updated", sourceUrl: null }],
    });
    assertEquals(overwritten.feedNameSnapshot, "Snapshot");
    assertEquals(overwritten.generatedAt, 20);

    const listed = await listSummariesForUserPeriod(
      database,
      (await createFeed(database, "another-user@example.com")).user.id,
      periodStartMs,
      periodEndMs,
    );
    assertEquals(listed, []);
    const found = await findSummaryForFeedPeriod(
      database,
      feed.id,
      periodStartMs,
      periodEndMs,
    );
    assertEquals(found?.content, {
      kind: "aggregate",
      points: [{ text: "updated", sourceUrl: null }],
    });
  });
});

Deno.test("listSummariesForUserPeriod orders feeds by configured position", async () => {
  await withTestDb(async (database) => {
    const { user, source, feed: secondFeed } = await createFeed(
      database,
      "summary-order@example.com",
      2,
    );
    const firstFeed = await createOrReviveFeed(database, {
      userId: user.id,
      sourceId: source.id,
      externalId: "channel:first",
      name: "Channel first",
      kind: "news",
      position: 1,
    });
    await upsertSummaryForPeriod(database, {
      feedId: secondFeed.id,
      periodStartMs,
      periodEndMs,
      content: articlesContent,
      feedNameSnapshot: secondFeed.name,
    });
    await upsertSummaryForPeriod(database, {
      feedId: firstFeed.id,
      periodStartMs,
      periodEndMs,
      content: aggregateContent,
      feedNameSnapshot: firstFeed.name,
    });

    const listed = await listSummariesForUserPeriod(
      database,
      user.id,
      periodStartMs,
      periodEndMs,
    );
    assertEquals(listed.map((summary) => summary.feedId), [
      firstFeed.id,
      secondFeed.id,
    ]);
    assertEquals(listed.map((summary) => summary.content.kind), [
      "aggregate",
      "articles",
    ]);
  });
});

Deno.test("listSummariesForUserPeriod includes soft-deleted feeds for history and scopes to owner", async () => {
  await withTestDb(async (database) => {
    const first = await createFeed(
      database,
      "summary-list-first@example.com",
      2,
    );
    const second = await createFeed(
      database,
      "summary-list-second@example.com",
      1,
    );
    await upsertSummaryForPeriod(database, {
      feedId: first.feed.id,
      periodStartMs,
      periodEndMs,
      content: aggregateContent,
      feedNameSnapshot: first.feed.name,
    });
    await upsertSummaryForPeriod(database, {
      feedId: second.feed.id,
      periodStartMs,
      periodEndMs,
      content: articlesContent,
      feedNameSnapshot: second.feed.name,
    });
    await softDeleteFeed(database, second.feed.id, second.user.id);

    const secondUserSummaries = await listSummariesForUserPeriod(
      database,
      second.user.id,
      periodStartMs,
      periodEndMs,
    );
    assertEquals(secondUserSummaries.length, 1);
    assertEquals(secondUserSummaries[0].feedDeletedAt !== null, true);

    const firstUserSummaries = await listSummariesForUserPeriod(
      database,
      first.user.id,
      periodStartMs,
      periodEndMs,
    );
    assertEquals(firstUserSummaries.length, 1);
    assertEquals(firstUserSummaries[0].feedDeletedAt, null);
  });
});

Deno.test("summary repository rejects invalid tagged content at the boundary", async () => {
  await withTestDb(async (database) => {
    const { feed, user } = await createFeed(
      database,
      "summary-invalid@example.com",
    );
    for (
      const content of [
        { kind: "unknown", points: [] },
        {
          kind: "aggregate",
          points: [{ text: "Summary", sourceUrl: null, unexpected: true }],
        },
        {
          kind: "articles",
          articles: [{
            sourceExternalId: "post-1",
            title: "Title",
            sourceUrl: null,
            publishedAt: 1,
            contentAccess: "full",
            points: [{ text: "Summary", sourceUrl: null, unexpected: true }],
          }],
        },
        {
          kind: "articles",
          articles: [{
            sourceExternalId: "post-1",
            title: "Title",
            sourceUrl: null,
            publishedAt: "not-a-timestamp",
            contentAccess: "full",
            points: [],
          }],
        },
        {
          kind: "articles",
          articles: [{
            sourceExternalId: "post-1",
            title: "Title",
            sourceUrl: null,
            publishedAt: 1,
            contentAccess: "unknown",
            points: [],
          }],
        },
      ]
    ) {
      await database.insert(summaries).values({
        feedId: feed.id,
        periodStartMs,
        periodEndMs,
        content: content as unknown as typeof summaries.$inferInsert["content"],
        feedNameSnapshot: feed.name,
        generatedAt: 1,
      }).onConflictDoUpdate({
        target: [
          summaries.feedId,
          summaries.periodStartMs,
          summaries.periodEndMs,
        ],
        set: {
          content:
            content as unknown as typeof summaries.$inferInsert["content"],
        },
      });

      await assertRejects(
        () =>
          listSummariesForUserPeriod(
            database,
            user.id,
            periodStartMs,
            periodEndMs,
          ),
        z.ZodError,
      );
    }
    await assertRejects(
      () =>
        Promise.resolve().then(() =>
          summaryPointSchema.parse({ broken: true })
        ),
      z.ZodError,
    );
  });
});

Deno.test("summary check constraint rejects reversed period order", async () => {
  await withTestDb(async (database) => {
    const { feed } = await createFeed(
      database,
      "summary-check-period@example.com",
    );

    await assertRejects(
      () =>
        upsertSummaryForPeriod(database, {
          feedId: feed.id,
          periodStartMs: periodEndMs,
          periodEndMs: periodStartMs,
          content: { kind: "aggregate", points: [] },
          feedNameSnapshot: feed.name,
        }),
    );
  });
});
