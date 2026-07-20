import { assertEquals, assertRejects } from "@std/assert";
import { ConnectorId } from "../../src/constants.ts";
import {
  CredentialCipher,
  type EncryptedBlob,
} from "../../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../src/crypto/key-provider.ts";
import type { Database } from "../../src/db/client.ts";
import { withTestDb } from "../../src/db/testing.ts";
import type { NormalizedItem } from "../../src/connectors/connector.types.ts";
import { createOrReviveFeed } from "../../src/repositories/feed-repository.ts";
import {
  listFeedIdsWithPaidItems,
  listItemsForFeedInWindow,
  upsertItems,
} from "../../src/repositories/item-repository.ts";
import { createSource } from "../../src/repositories/source-repository.ts";
import {
  createUser,
  type CreateUserInput,
} from "../../src/repositories/user-repository.ts";

function userInput(email: string): CreateUserInput {
  return {
    name: "Item Owner",
    email,
    passwordHash: "$argon2id$fakehash",
    systemPrompt: "Summarize tersely.",
    defaultLanguage: "en",
  };
}

function credentialCipher(): CredentialCipher {
  return new CredentialCipher(
    new EnvMasterKeyProvider(new Uint8Array(32).fill(23)),
  );
}

async function encryptedCredentials(userId: string): Promise<EncryptedBlob> {
  return await credentialCipher().encrypt(
    JSON.stringify({ sessionString: "telegram-session" }),
    {
      userId,
      connectorId: ConnectorId.Telegram,
    },
  );
}

async function createFeed(database: Database, email: string) {
  const user = await createUser(database, userInput(email));
  const source = await createSource(database, {
    userId: user.id,
    connectorId: ConnectorId.Telegram,
    credentials: await encryptedCredentials(user.id),
  });
  const feed = await createOrReviveFeed(database, {
    userId: user.id,
    sourceId: source.id,
    externalId: "channel:1",
    name: "Channel",
    kind: "news",
  });
  return { user, source, feed };
}

function normalizedItem(
  overrides: Partial<NormalizedItem> = {},
): NormalizedItem {
  return {
    connectorId: ConnectorId.Telegram,
    feedExternalId: "channel:1",
    externalId: "message:1",
    date: 1_700_000_000_000,
    title: null,
    text: "First item",
    author: "Channel",
    url: "https://t.me/channel/1",
    ...overrides,
  };
}

Deno.test("item repository upserts and lists feed items in window", async () => {
  await withTestDb(async (database) => {
    const { feed } = await createFeed(database, "items-list@example.com");
    await upsertItems(database, feed.id, [
      normalizedItem({
        externalId: "message:2",
        date: 1_700_000_000_200,
        text: "Second",
      }),
      normalizedItem({
        externalId: "message:1",
        date: 1_700_000_000_100,
        text: "First",
      }),
    ], 1_700_000_001_000);

    const listed = await listItemsForFeedInWindow(
      database,
      feed.id,
      1_700_000_000_000,
      1_700_000_000_200,
    );
    assertEquals(listed.map((item) => item.externalId), [
      "message:1",
      "message:2",
    ]);
    assertEquals(listed[0].payload.text, "First");
    assertEquals(listed[0].fetchedAt, 1_700_000_001_000);
  });
});

Deno.test("item repository updates edited items without duplicating rows", async () => {
  await withTestDb(async (database) => {
    const { feed } = await createFeed(database, "items-upsert@example.com");
    await upsertItems(
      database,
      feed.id,
      [normalizedItem({ text: "Before" })],
      10,
    );
    await upsertItems(database, feed.id, [
      normalizedItem({ text: "After", date: 1_700_000_000_500 }),
    ], 20);

    const listed = await listItemsForFeedInWindow(
      database,
      feed.id,
      1_700_000_000_000,
      1_700_000_001_000,
    );
    assertEquals(listed.length, 1);
    assertEquals(listed[0].payload.text, "After");
    assertEquals(listed[0].date, 1_700_000_000_500);
    assertEquals(listed[0].fetchedAt, 20);
  });
});

Deno.test("item repository preserves fetchedAt when a refresh is unchanged", async () => {
  await withTestDb(async (database) => {
    const { feed } = await createFeed(
      database,
      "items-unchanged-refresh@example.com",
    );
    const item = normalizedItem({ text: "Unchanged" });
    await upsertItems(database, feed.id, [item], 10);
    await upsertItems(database, feed.id, [item], 20);

    const [storedItem] = await listItemsForFeedInWindow(
      database,
      feed.id,
      1_700_000_000_000,
      1_700_000_001_000,
    );
    assertEquals(storedItem.fetchedAt, 10);
  });
});

Deno.test("item repository rejects invalid normalized item payloads before writing", async () => {
  await withTestDb(async (database) => {
    const { feed } = await createFeed(database, "items-invalid@example.com");
    await assertRejects(
      () =>
        upsertItems(database, feed.id, [normalizedItem({ externalId: "" })]),
      Error,
    );
    assertEquals(
      await listItemsForFeedInWindow(database, feed.id, 0, 2_000_000_000_000),
      [],
    );
  });
});

Deno.test("paid item lookup is bounded by feed ownership and window", async () => {
  await withTestDb(async (database) => {
    const { feed } = await createFeed(
      database,
      "items-legacy-paid@example.com",
    );
    const { feed: otherFeed } = await createFeed(
      database,
      "items-legacy-paid-other@example.com",
    );
    const legacyPaid = (externalId: string, date: number): NormalizedItem =>
      normalizedItem({
        connectorId: ConnectorId.Substack,
        externalId,
        date,
        meta: { audience: "only_paid" },
      });
    await upsertItems(database, feed.id, [
      legacyPaid("legacy-in-window", 150),
      legacyPaid("legacy-before-window", 99),
      {
        ...legacyPaid("explicit-false", 160),
        meta: { audience: "only_paid", hasPaidSubscription: false },
      },
      {
        ...legacyPaid("explicit-true", 190),
        meta: { audience: "only_paid", hasPaidSubscription: true },
      },
      {
        ...legacyPaid("wrong-audience", 170),
        meta: { audience: "everyone" },
      },
      normalizedItem({
        externalId: "wrong-connector",
        date: 180,
        meta: { audience: "only_paid" },
      }),
    ]);
    await upsertItems(database, otherFeed.id, [
      legacyPaid("other-feed", 150),
    ]);

    assertEquals(
      await listFeedIdsWithPaidItems(database, [feed.id], 100, 200),
      [feed.id],
    );
    assertEquals(
      await listFeedIdsWithPaidItems(
        database,
        [otherFeed.id],
        100,
        200,
      ),
      [otherFeed.id],
    );
    assertEquals(
      await listFeedIdsWithPaidItems(
        database,
        [feed.id],
        151,
        200,
      ),
      [feed.id],
    );
    assertEquals(
      await listFeedIdsWithPaidItems(
        database,
        [feed.id],
        181,
        200,
      ),
      [feed.id],
    );
    assertEquals(
      await listFeedIdsWithPaidItems(database, [], 100, 200),
      [],
    );
  });
});
