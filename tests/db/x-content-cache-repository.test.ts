import { test } from "bun:test";
import { assertEquals, assertExists, assertThrows } from "../assertions.ts";
import { eq } from "drizzle-orm";
import { ConnectorId } from "../../src/constants.ts";
import { CredentialCipher } from "../../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../src/crypto/key-provider.ts";
import { withTestDb } from "../../src/db/testing.ts";
import { sources } from "../../src/db/schema/source.ts";
import {
  xContentCacheItems,
  xContentCacheRanges,
} from "../../src/db/schema/x-content-cache.ts";
import type { XRawChatMessage, XRawPost } from "../../src/connectors/x/x.types.ts";
import {
  DatabaseXContentCache,
  type XContentCache,
} from "../../src/repositories/x-content-cache-repository.ts";
import {
  createSource,
  deleteSourceCredentials,
  type PublicSource,
  upsertSourceCredentials,
} from "../../src/repositories/source-repository.ts";
import { createUser } from "../../src/repositories/user-repository.ts";
import { ConflictError } from "../../src/server/errors.ts";

const LIST_FEED = "x:list:123";
const CHAT_FEED = "x:chat:abc-456";

function post(
  externalId: string,
  date: number,
  overrides: Partial<XRawPost> = {},
): XRawPost {
  return {
    kind: "post",
    externalId,
    platformId: externalId,
    date,
    text: `post ${externalId}`,
    author: "Post Author",
    url: `https://x.com/post-author/status/${externalId}`,
    replyCount: null,
    repostCount: null,
    likeCount: null,
    viewCount: null,
    ...overrides,
  };
}

function chatMessage(
  externalId: string,
  date: number,
  overrides: Partial<XRawChatMessage> = {},
): XRawChatMessage {
  return {
    kind: "chat_message",
    externalId,
    platformId: externalId,
    date,
    text: `chat ${externalId}`,
    author: "Chat Author",
    url: "https://x.com/i/chat/team-chat",
    reactions: [],
    ...overrides,
  };
}

function cipher(): CredentialCipher {
  return new CredentialCipher(new EnvMasterKeyProvider(new Uint8Array(32).fill(11)));
}

async function createXSource(
  database: Parameters<typeof createSource>[0],
  email: string,
): Promise<PublicSource> {
  const user = await createUser(database, {
    name: "X Reader",
    email,
    passwordHash: "$argon2id$fakehash",
    systemPrompt: "Summarize tersely.",
    defaultLanguage: "en",
  });
  const credentials = await cipher().encrypt(JSON.stringify({ fixture: true }), {
    userId: user.id,
    connectorId: ConnectorId.X,
  });
  return await createSource(database, {
    userId: user.id,
    connectorId: ConnectorId.X,
    credentials,
  });
}

async function countRows(
  database: Parameters<typeof createSource>[0],
  sourceId: string,
): Promise<{ items: number; ranges: number }> {
  const itemRows = database
    .select({ id: xContentCacheItems.id })
    .from(xContentCacheItems)
    .where(eq(xContentCacheItems.sourceId, sourceId))
    .all();
  const rangeRows = database
    .select({ id: xContentCacheRanges.id })
    .from(xContentCacheRanges)
    .where(eq(xContentCacheRanges.sourceId, sourceId))
    .all();
  return { items: itemRows.length, ranges: rangeRows.length };
}

test("missingRanges returns inclusive gaps between coverage and window bounds", async () => {
  await withTestDb(async (database) => {
    const source = await createXSource(database, "cache-gaps@example.com");
    const cache = new DatabaseXContentCache(database, source.id);

    // No coverage at all: the full window is one gap, inclusive on both ends.
    assertEquals(cache.missingRanges(LIST_FEED, 1_000, 2_000), [{
      from: 1_000,
      to: 2_000,
    }]);

    cache.record(LIST_FEED, { from: 1_000, to: 2_000 }, []);

    // Covered window reports no gaps, including single-millisecond windows.
    assertEquals(cache.missingRanges(LIST_FEED, 1_000, 2_000), []);
    assertEquals(cache.missingRanges(LIST_FEED, 1_500, 1_500), []);

    // Window edges are inclusive: one millisecond before/after is still a gap.
    assertEquals(cache.missingRanges(LIST_FEED, 999, 2_001), [
      { from: 999, to: 999 },
      { from: 2_001, to: 2_001 },
    ]);

    // Larger requested window splits into head and tail gaps.
    assertEquals(cache.missingRanges(LIST_FEED, 500, 2_500), [
      { from: 500, to: 999 },
      { from: 2_001, to: 2_500 },
    ]);
  });
});

test("record merges overlapping and adjacent ranges into continuous coverage", async () => {
  await withTestDb(async (database) => {
    const source = await createXSource(database, "cache-merge@example.com");
    const cache = new DatabaseXContentCache(database, source.id);

    // Overlap merges into one persisted row.
    cache.record(LIST_FEED, { from: 1_000, to: 2_000 }, []);
    cache.record(LIST_FEED, { from: 1_500, to: 2_500 }, []);
    assertEquals((await countRows(database, source.id)).ranges, 1);
    assertEquals(cache.missingRanges(LIST_FEED, 1_000, 2_500), []);

    // Adjacent ranges (end + 1 === start) count as continuous too.
    cache.record(LIST_FEED, { from: 2_501, to: 3_000 }, []);
    assertEquals((await countRows(database, source.id)).ranges, 1);
    assertEquals(cache.missingRanges(LIST_FEED, 1_000, 3_000), []);

    // A separated range creates a second row and keeps the exact gap.
    cache.record(LIST_FEED, { from: 4_000, to: 5_000 }, []);
    assertEquals((await countRows(database, source.id)).ranges, 2);
    assertEquals(cache.missingRanges(LIST_FEED, 1_000, 5_000), [
      { from: 3_001, to: 3_999 },
    ]);

    // Defensive merge: even directly persisted overlapping rows are treated
    // as continuous when computing gaps.
    database.insert(xContentCacheRanges).values({
      sourceId: source.id,
      feedExternalId: LIST_FEED,
      startMs: 1_500,
      endMs: 2_500,
      fetchedAt: Date.now(),
    }).run();
    assertEquals(cache.missingRanges(LIST_FEED, 1_000, 4_000), [{
      from: 3_001,
      to: 3_999,
    }]);
  });
});

test("record with empty items still establishes coverage", async () => {
  await withTestDb(async (database) => {
    const source = await createXSource(database, "cache-empty@example.com");
    const cache = new DatabaseXContentCache(database, source.id);
    cache.record(LIST_FEED, { from: 10_000, to: 11_000 }, []);
    assertEquals(cache.missingRanges(LIST_FEED, 10_000, 11_000), []);
    assertEquals(cache.read(LIST_FEED, 10_000, 11_000), []);
  });
});

test("record upserts items by source, feed, and external id", async () => {
  await withTestDb(async (database) => {
    const source = await createXSource(database, "cache-upsert@example.com");
    const cache = new DatabaseXContentCache(database, source.id);

    cache.record(
      LIST_FEED,
      { from: 1_000, to: 2_000 },
      [post("t-1", 1_200), post("t-2", 1_300)],
    );
    // Same external id with a newer payload and date replaces the stored row.
    cache.record(
      LIST_FEED,
      { from: 1_000, to: 2_000 },
      [post("t-1", 1_250, { text: "updated" })],
    );

    const rows = cache.read(LIST_FEED, 1_000, 2_000);
    assertEquals(rows.length, 2);
    const first = rows.find((row) => row.externalId === "t-1");
    assertExists(first);
    assertEquals(first.date, 1_250);
    assertEquals(first.text, "updated");
    assertEquals((await countRows(database, source.id)).items, 2);
  });
});

test("read returns items ordered by date then external id within inclusive bounds", async () => {
  await withTestDb(async (database) => {
    const source = await createXSource(database, "cache-order@example.com");
    const cache = new DatabaseXContentCache(database, source.id);

    cache.record(
      LIST_FEED,
      { from: 1_000, to: 4_000 },
      [
        chatMessage("msg-late", 4_000),
        chatMessage("msg-early", 1_000),
        chatMessage("msg-tie-b", 2_000),
        chatMessage("msg-tie-a", 2_000),
        chatMessage("msg-outside-low", 999),
        chatMessage("msg-outside-high", 4_001),
      ],
    );

    assertEquals(
      cache.read(LIST_FEED, 1_000, 4_000).map((item) => item.externalId),
      ["msg-early", "msg-tie-a", "msg-tie-b", "msg-late"],
    );
  });
});

test("cache operations are isolated per feed within a source", async () => {
  await withTestDb(async (database) => {
    const source = await createXSource(database, "cache-feed-isolation@example.com");
    const cache = new DatabaseXContentCache(database, source.id);

    cache.record(
      LIST_FEED,
      { from: 1_000, to: 2_000 },
      [post("t-1", 1_500)],
    );

    // The other feed sees no coverage and no items.
    assertEquals(cache.missingRanges(CHAT_FEED, 1_000, 2_000), [{
      from: 1_000,
      to: 2_000,
    }]);
    assertEquals(cache.read(CHAT_FEED, 1_000, 2_000), []);

    // Recording on the other feed does not touch the first feed.
    cache.record(CHAT_FEED, { from: 1_000, to: 2_000 }, []);
    assertEquals(cache.read(LIST_FEED, 1_000, 2_000).length, 1);
    assertEquals(
      cache.read(CHAT_FEED, 1_000, 2_000),
      [],
    );
  });
});

test("cache operations are isolated per source", async () => {
  await withTestDb(async (database) => {
    const first = await createXSource(database, "cache-source-a@example.com");
    const second = await createXSource(database, "cache-source-b@example.com");
    const firstCache = new DatabaseXContentCache(database, first.id);
    const secondCache = new DatabaseXContentCache(database, second.id);

    firstCache.record(
      LIST_FEED,
      { from: 1_000, to: 2_000 },
      [post("t-1", 1_500)],
    );
    assertEquals(secondCache.missingRanges(LIST_FEED, 1_000, 2_000), [{
      from: 1_000,
      to: 2_000,
    }]);
    assertEquals(secondCache.read(LIST_FEED, 1_000, 2_000), []);
    assertEquals(firstCache.read(LIST_FEED, 1_000, 2_000).length, 1);
  });
});

test("clear removes every item and range for the source only", async () => {
  await withTestDb(async (database) => {
    const first = await createXSource(database, "cache-clear-a@example.com");
    const second = await createXSource(database, "cache-clear-b@example.com");
    const firstCache = new DatabaseXContentCache(database, first.id);
    const secondCache = new DatabaseXContentCache(database, second.id);

    firstCache.record(
      LIST_FEED,
      { from: 1_000, to: 2_000 },
      [post("t-1", 1_500)],
    );
    firstCache.record(CHAT_FEED, { from: 1_000, to: 2_000 }, []);
    secondCache.record(
      LIST_FEED,
      { from: 1_000, to: 2_000 },
      [post("s2-t-1", 1_500)],
    );

    firstCache.clear();

    assertEquals(await countRows(database, first.id), { items: 0, ranges: 0 });
    assertEquals(firstCache.read(LIST_FEED, 1_000, 2_000), []);
    assertEquals(firstCache.missingRanges(LIST_FEED, 1_000, 2_000), [{
      from: 1_000,
      to: 2_000,
    }]);
    // Unrelated source is untouched.
    assertEquals(await countRows(database, second.id), { items: 1, ranges: 1 });
    assertEquals(secondCache.read(LIST_FEED, 1_000, 2_000).length, 1);
  });
});

test("deleting a source cascades its cached items and ranges", async () => {
  await withTestDb(async (database) => {
    const source = await createXSource(database, "cache-cascade@example.com");
    const cache = new DatabaseXContentCache(database, source.id);
    cache.record(
      LIST_FEED,
      { from: 1_000, to: 2_000 },
      [post("t-1", 1_500)],
    );
    assertEquals(await countRows(database, source.id), { items: 1, ranges: 1 });

    database.delete(sources).where(eq(sources.id, source.id)).run();

    assertEquals(await countRows(database, source.id), { items: 0, ranges: 0 });
  });
});

test("cache rejects invalid windows, feed ids, and item shapes", async () => {
  await withTestDb(async (database) => {
    const source = await createXSource(database, "cache-validation@example.com");
    const cache: XContentCache = new DatabaseXContentCache(database, source.id);

    assertThrows(
      () => cache.missingRanges("", 1_000, 2_000),
      Error,
      "feedExternalId must be a non-empty string",
    );
    assertThrows(
      () => cache.read(LIST_FEED, 2_000, 1_000),
      Error,
      "invalid window",
    );
    assertThrows(
      () => cache.record(LIST_FEED, { from: -1, to: 2_000 }, []),
      Error,
      "non-negative",
    );
    assertThrows(
      () => cache.record(LIST_FEED, { from: 1_000, to: 2_000 }, [
        { externalId: "broken", date: 1_500 } as unknown as XRawPost,
      ]),
      Error,
    );
    assertThrows(
      () => new DatabaseXContentCache(database, ""),
      Error,
      "sourceId must be a non-empty string",
    );
  });
});

test("revision-bound cache rejects reads and writes after reconnect or disconnect, and record writes nothing", async () => {
  await withTestDb(async (database) => {
    const source = await createXSource(database, "cache-revision@example.com");
    const userId = database
      .select({ userId: sources.userId })
      .from(sources)
      .where(eq(sources.id, source.id))
      .get()?.userId;
    assertExists(userId);

    // Bound to the freshly created source's revision: everything works.
    const cache = new DatabaseXContentCache(database, source.id, 1);
    cache.record(
      LIST_FEED,
      { from: 1_000, to: 2_000 },
      [post("t-1", 1_500)],
    );
    assertEquals(cache.read(LIST_FEED, 1_000, 2_000).length, 1);
    assertEquals(cache.missingRanges(LIST_FEED, 1_000, 2_000), []);

    // Reconnect bumps the revision: every read path now rejects.
    await upsertSourceCredentials(database, {
      userId,
      connectorId: ConnectorId.X,
      credentials: await cipher().encrypt(JSON.stringify({ fixture: true }), {
        userId,
        connectorId: ConnectorId.X,
      }),
    });
    assertThrows(
      () => cache.missingRanges(LIST_FEED, 1_000, 2_000),
      ConflictError,
      "source connection changed; retry ingestion",
    );
    assertThrows(
      () => cache.read(LIST_FEED, 1_000, 2_000),
      ConflictError,
      "source connection changed; retry ingestion",
    );
    // record rejects inside its immediate transaction and writes nothing.
    assertThrows(
      () =>
        cache.record(
          LIST_FEED,
          { from: 3_000, to: 4_000 },
          [post("t-2", 3_500)],
        ),
      ConflictError,
      "source connection changed; retry ingestion",
    );
    assertEquals(await countRows(database, source.id), {
      items: 1,
      ranges: 1,
    });

    // Disconnect bumps the revision again: the bound cache still rejects.
    await deleteSourceCredentials(database, source.id, userId);
    assertThrows(
      () => cache.read(LIST_FEED, 1_000, 2_000),
      ConflictError,
      "source connection changed; retry ingestion",
    );

    // Prior committed data survives; the failed record attempt left nothing.
    const fresh = new DatabaseXContentCache(database, source.id);
    assertEquals(fresh.read(LIST_FEED, 1_000, 2_000).length, 1);
    assertEquals(fresh.read(LIST_FEED, 3_000, 4_000), []);
    assertEquals(fresh.missingRanges(LIST_FEED, 3_000, 4_000), [{
      from: 3_000,
      to: 4_000,
    }]);

    // A cache bound to a revision that never existed is rejected up front.
    const neverCurrent = new DatabaseXContentCache(database, source.id, 99);
    assertThrows(
      () => neverCurrent.missingRanges(LIST_FEED, 1_000, 2_000),
      ConflictError,
      "source connection changed; retry ingestion",
    );

    // Admin clear keeps working on an unbound cache even after disconnect.
    fresh.clear();
    assertEquals(await countRows(database, source.id), { items: 0, ranges: 0 });
  });
});

test("fetchedAt is recorded per upsert", async () => {
  await withTestDb(async (database) => {
    const source = await createXSource(database, "cache-fetched-at@example.com");
    const cache = new DatabaseXContentCache(database, source.id);

    cache.record(LIST_FEED, { from: 1_000, to: 2_000 }, [], 111);
    cache.record(LIST_FEED, { from: 1_000, to: 2_000 }, [], 222);

    const rows = database
      .select({ fetchedAt: xContentCacheRanges.fetchedAt })
      .from(xContentCacheRanges)
      .where(eq(xContentCacheRanges.sourceId, source.id))
      .all();
    assertEquals(rows, [{ fetchedAt: 222 }]);
  });
});
