import { test } from "bun:test";
import { assertEquals, assertExists, assertThrows } from "../assertions.ts";
import { and, eq } from "drizzle-orm";
import { ConnectorId } from "../../src/constants.ts";
import { CredentialCipher } from "../../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../src/crypto/key-provider.ts";
import { withTestDb } from "../../src/db/testing.ts";
import { feeds } from "../../src/db/schema/feed.ts";
import { sources } from "../../src/db/schema/source.ts";
import {
  xContentCacheItems,
  xContentCacheRanges,
  xContentFetchProgress,
} from "../../src/db/schema/x-content-cache.ts";
import type { XRawChatMessage, XRawPost } from "../../src/connectors/x/x.types.ts";
import {
  DatabaseXContentCache,
  type XContentCache,
  type XContentProgressBlockReason,
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

async function countProgressRows(
  database: Parameters<typeof createSource>[0],
  sourceId: string,
): Promise<number> {
  return database
    .select({ id: xContentFetchProgress.id })
    .from(xContentFetchProgress)
    .where(eq(xContentFetchProgress.sourceId, sourceId))
    .all().length;
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
      () => cache.recordPage("", { from: 1_000, to: 2_000 }, [], "cursor-1"),
      Error,
      "feedExternalId must be a non-empty string",
    );
    assertThrows(
      () =>
        cache.recordPage(
          LIST_FEED,
          { from: 2_000, to: 1_000 },
          [],
          "cursor-1",
        ),
      Error,
      "invalid window",
    );
    assertThrows(
      () =>
        cache.recordPage(
          LIST_FEED,
          { from: 1_000, to: 2_000 },
          [],
          42 as unknown as string,
        ),
      Error,
      "nextCursor must be a string or null",
    );
    assertThrows(
      () =>
        cache.recordPage(
          LIST_FEED,
          { from: 1_000, to: 2_000 },
          [],
          "cursor-1",
          { blockedReason: "bogus" as unknown as XContentProgressBlockReason },
        ),
      Error,
      "unsupported blockedReason",
    );
    assertThrows(
      () =>
        cache.recordPage(LIST_FEED, { from: 1_000, to: 2_000 }, [
          { externalId: "broken", date: 1_500 } as unknown as XRawPost,
        ], "cursor-1"),
      Error,
    );
    assertThrows(
      () => cache.pendingRanges(LIST_FEED, 2_000, 1_000),
      Error,
      "invalid window",
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
    const now = Date.now();
    database.insert(feeds).values({
      sourceId: source.id,
      externalId: LIST_FEED,
      name: "List Feed",
      kind: "news",
      createdAt: now,
      updatedAt: now,
    }).run();

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
    // recordPage rejects the same way and leaves neither items nor progress.
    assertThrows(
      () =>
        cache.recordPage(
          LIST_FEED,
          { from: 3_000, to: 4_000 },
          [post("t-3", 3_500)],
          "cursor-1",
        ),
      ConflictError,
      "source connection changed; retry ingestion",
    );
    assertThrows(
      () => cache.pendingRanges(LIST_FEED, 1_000, 2_000),
      ConflictError,
      "source connection changed; retry ingestion",
    );
    assertEquals(await countRows(database, source.id), {
      items: 1,
      ranges: 1,
    });
    assertEquals(await countProgressRows(database, source.id), 0);

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

test("revision-bound cache rejects page and final writes after the feed is disabled, writing nothing", async () => {
  await withTestDb(async (database) => {
    const source = await createXSource(database, "cache-feed-disabled@example.com");
    const now = Date.now();
    database.insert(feeds).values({
      sourceId: source.id,
      externalId: LIST_FEED,
      name: "List Feed",
      kind: "news",
      createdAt: now,
      updatedAt: now,
    }).run();

    // While the feed is active, a revision-bound cache plans and writes normally.
    const cache = new DatabaseXContentCache(database, source.id, 1);
    assertEquals(cache.missingRanges(LIST_FEED, 1_000, 2_000), [{
      from: 1_000,
      to: 2_000,
    }]);
    cache.record(LIST_FEED, { from: 1_000, to: 2_000 }, [post("t-1", 1_500)]);
    assertEquals(cache.pendingRanges(LIST_FEED, 1_000, 2_000), []);

    // Disable the feed. Fetch planning and both write paths now reject with
    // the fixed conflict error, before any connector work or persistence.
    database.update(feeds)
      .set({ enabled: false, updatedAt: Date.now() })
      .where(and(eq(feeds.sourceId, source.id), eq(feeds.externalId, LIST_FEED)))
      .run();
    assertThrows(
      () => cache.missingRanges(LIST_FEED, 3_000, 4_000),
      ConflictError,
      "feed became inactive",
    );
    assertThrows(
      () => cache.pendingRanges(LIST_FEED, 3_000, 4_000),
      ConflictError,
      "feed became inactive",
    );
    assertThrows(
      () =>
        cache.recordPage(
          LIST_FEED,
          { from: 3_000, to: 4_000 },
          [post("t-2", 3_500)],
          "cursor-1",
        ),
      ConflictError,
      "feed became inactive",
    );
    assertThrows(
      () =>
        cache.record(
          LIST_FEED,
          { from: 3_000, to: 4_000 },
          [post("t-3", 3_500)],
        ),
      ConflictError,
      "feed became inactive",
    );

    // Atomic no-write: an unrestricted cache sees the exact pre-disable state.
    const unbound = new DatabaseXContentCache(database, source.id);
    assertEquals(await countRows(database, source.id), { items: 1, ranges: 1 });
    assertEquals(await countProgressRows(database, source.id), 0);
    assertEquals(unbound.missingRanges(LIST_FEED, 3_000, 4_000), [{
      from: 3_000,
      to: 4_000,
    }]);
    assertEquals(unbound.pendingRanges(LIST_FEED, 3_000, 4_000), []);
    assertEquals(unbound.read(LIST_FEED, 3_000, 4_000), []);
    // Reads stay source-revision-fenced: already cached content still serves.
    assertEquals(unbound.read(LIST_FEED, 1_000, 2_000).length, 1);

    // An unrestricted legacy cache has no expected revision, so it keeps its
    // pre-existing behavior: planning and writes still work for the disabled
    // feed (demonstrated by `unbound` above and a legacy commit below).
    unbound.record(LIST_FEED, { from: 3_000, to: 4_000 }, [post("t-4", 3_500)]);
    assertEquals(await countRows(database, source.id), { items: 2, ranges: 2 });
  });
});

test("revision-bound cache rejects page and final writes after the feed is soft-deleted, writing nothing", async () => {
  await withTestDb(async (database) => {
    const source = await createXSource(database, "cache-feed-deleted@example.com");
    const now = Date.now();
    database.insert(feeds).values({
      sourceId: source.id,
      externalId: CHAT_FEED,
      name: "Chat Feed",
      kind: "discussion",
      createdAt: now,
      updatedAt: now,
    }).run();

    const cache = new DatabaseXContentCache(database, source.id, 1);
    cache.recordPage(
      CHAT_FEED,
      { from: 1_000, to: 2_000 },
      [chatMessage("m-1", 1_500)],
      "cursor-1",
      { fetchedAt: now },
    );

    // Soft-delete: deletedAt set and enabled flipped off, as reset does.
    database.update(feeds)
      .set({ deletedAt: Date.now(), enabled: false, updatedAt: Date.now() })
      .where(and(
        eq(feeds.sourceId, source.id),
        eq(feeds.externalId, CHAT_FEED),
      ))
      .run();
    assertThrows(
      () => cache.missingRanges(CHAT_FEED, 3_000, 4_000),
      ConflictError,
      "feed became inactive",
    );
    assertThrows(
      () => cache.pendingRanges(CHAT_FEED, 3_000, 4_000),
      ConflictError,
      "feed became inactive",
    );
    assertThrows(
      () =>
        cache.recordPage(
          CHAT_FEED,
          { from: 3_000, to: 4_000 },
          [chatMessage("m-2", 3_500)],
          "cursor-2",
        ),
      ConflictError,
      "feed became inactive",
    );
    assertThrows(
      () =>
        cache.record(
          CHAT_FEED,
          { from: 3_000, to: 4_000 },
          [chatMessage("m-3", 3_500)],
        ),
      ConflictError,
      "feed became inactive",
    );

    // Atomic no-write: the pre-delete page survives untouched; the rejected
    // planning and writes added no items, no progress, and no coverage.
    // An unrestricted cache keeps its pre-existing behavior and still plans
    // for the soft-deleted feed.
    const unbound = new DatabaseXContentCache(database, source.id);
    assertEquals(await countRows(database, source.id), { items: 1, ranges: 0 });
    assertEquals(await countProgressRows(database, source.id), 1);
    assertEquals(unbound.pendingRanges(CHAT_FEED, 1_000, 2_000), [{
      range: { from: 1_000, to: 2_000 },
      nextCursor: "cursor-1",
      pageCount: 1,
      updatedAt: now,
      blockedReason: null,
      seenCursors: ["cursor-1"],
    }]);
    assertEquals(unbound.missingRanges(CHAT_FEED, 3_000, 4_000), [{
      from: 3_000,
      to: 4_000,
    }]);
    assertEquals(unbound.read(CHAT_FEED, 3_000, 4_000), []);
    // Read paths remain source-revision-fenced but not feed-activity-fenced:
    // they still serve the pre-delete data for the soft-deleted feed.
    assertEquals(cache.read(CHAT_FEED, 1_000, 2_000).length, 1);
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

test("recordPage persists items and cursor without adding coverage", async () => {
  await withTestDb(async (database) => {
    const source = await createXSource(
      database,
      "cache-page-no-coverage@example.com",
    );
    const cache = new DatabaseXContentCache(database, source.id);

    cache.recordPage(
      LIST_FEED,
      { from: 1_000, to: 2_000 },
      [post("t-1", 1_500), post("t-2", 1_600)],
      "cursor-1",
      { fetchedAt: 111 },
    );

    // Items are visible immediately...
    assertEquals(
      cache.read(LIST_FEED, 1_000, 2_000).map((item) => item.externalId),
      ["t-1", "t-2"],
    );
    // ...but the range is NOT covered: gap computation still reports the
    // whole window and no coverage row exists.
    assertEquals(cache.missingRanges(LIST_FEED, 1_000, 2_000), [{
      from: 1_000,
      to: 2_000,
    }]);
    assertEquals((await countRows(database, source.id)).ranges, 0);

    // Progress carries the cursor, page count, timestamps, and the empty
    // cursor history; a normal page is never blocked.
    assertEquals(cache.pendingRanges(LIST_FEED, 1_000, 2_000), [{
      range: { from: 1_000, to: 2_000 },
      nextCursor: "cursor-1",
      pageCount: 1,
      updatedAt: 111,
      blockedReason: null,
      seenCursors: ["cursor-1"],
    }]);
  });
});

test("recordPage replaces the cursor and bumps the page count per recorded page", async () => {
  await withTestDb(async (database) => {
    const source = await createXSource(
      database,
      "cache-page-cursor@example.com",
    );
    const cache = new DatabaseXContentCache(database, source.id);

    cache.recordPage(
      LIST_FEED,
      { from: 1_000, to: 2_000 },
      [post("t-1", 1_500)],
      "cursor-1",
      { fetchedAt: 100 },
    );
    cache.recordPage(
      LIST_FEED,
      { from: 1_000, to: 2_000 },
      [post("t-2", 1_600)],
      "cursor-2",
      { fetchedAt: 200 },
    );
    // A page that yields no items still advances the cursor and count.
    cache.recordPage(
      LIST_FEED,
      { from: 1_000, to: 2_000 },
      [],
      "cursor-3",
      { fetchedAt: 300 },
    );

    assertEquals(cache.pendingRanges(LIST_FEED, 1_000, 2_000), [{
      range: { from: 1_000, to: 2_000 },
      nextCursor: "cursor-3",
      pageCount: 3,
      updatedAt: 300,
      blockedReason: null,
      seenCursors: ["cursor-1", "cursor-2", "cursor-3"],
    }]);
    assertEquals(await countProgressRows(database, source.id), 1);
    // Only the newest cursor is stored; items keep accumulating.
    assertEquals(cache.read(LIST_FEED, 1_000, 2_000).length, 2);
  });
});

test("record commits coverage and deletes the exact pending progress", async () => {
  await withTestDb(async (database) => {
    const source = await createXSource(
      database,
      "cache-page-commit@example.com",
    );
    const cache = new DatabaseXContentCache(database, source.id);

    cache.recordPage(
      LIST_FEED,
      { from: 1_000, to: 2_000 },
      [post("t-1", 1_500), post("t-2", 1_600)],
      "cursor-2",
    );
    // Last page reports completion, then the range is committed.
    cache.recordPage(
      LIST_FEED,
      { from: 1_000, to: 2_000 },
      [post("t-3", 1_700)],
      null,
    );
    cache.record(LIST_FEED, { from: 1_000, to: 2_000 }, []);

    assertEquals(cache.missingRanges(LIST_FEED, 1_000, 2_000), []);
    assertEquals(cache.pendingRanges(LIST_FEED, 1_000, 2_000), []);
    assertEquals(await countProgressRows(database, source.id), 0);
    assertEquals(cache.read(LIST_FEED, 1_000, 2_000).length, 3);

    // A commit of a different range does not touch other pending progress.
    cache.recordPage(
      LIST_FEED,
      { from: 3_000, to: 4_000 },
      [post("t-4", 3_500)],
      "cursor-4",
    );
    cache.record(LIST_FEED, { from: 3_000, to: 4_000 }, []);
    assertEquals(cache.pendingRanges(LIST_FEED, 3_000, 4_000), []);

    // A *wider* commit does not delete the narrower pending row: only the
    // exact range counts as finished. The pending row stays resumable and
    // its items remain readable.
    cache.recordPage(
      LIST_FEED,
      { from: 5_000, to: 6_000 },
      [post("t-5", 5_500)],
      "cursor-5",
      { fetchedAt: 500 },
    );
    cache.record(LIST_FEED, { from: 4_500, to: 6_500 }, []);
    assertEquals(cache.missingRanges(LIST_FEED, 4_500, 6_500), []);
    assertEquals(cache.pendingRanges(LIST_FEED, 5_000, 6_000), [{
      range: { from: 5_000, to: 6_000 },
      nextCursor: "cursor-5",
      pageCount: 1,
      updatedAt: 500,
      blockedReason: null,
      seenCursors: ["cursor-5"],
    }]);
  });
});

test("pendingRanges returns only overlapping progress for the feed, ordered by start", async () => {
  await withTestDb(async (database) => {
    const source = await createXSource(
      database,
      "cache-pending-overlap@example.com",
    );
    const cache = new DatabaseXContentCache(database, source.id);

    cache.recordPage(LIST_FEED, { from: 1_000, to: 2_000 }, [], "c1", { fetchedAt: 1 });
    cache.recordPage(LIST_FEED, { from: 5_000, to: 6_000 }, [], "c2", { fetchedAt: 2 });
    cache.recordPage(LIST_FEED, { from: 3_000, to: 4_000 }, [], "c3", { fetchedAt: 3 });
    cache.recordPage(CHAT_FEED, { from: 1_000, to: 2_000 }, [], "c4", { fetchedAt: 4 });

    // [2_500, 5_500] partially overlaps both 3_000-4_000 and 5_000-6_000,
    // misses 1_000-2_000 entirely, and never crosses feeds.
    assertEquals(
      cache.pendingRanges(LIST_FEED, 2_500, 5_500).map((progress) => ({
        range: progress.range,
        nextCursor: progress.nextCursor,
        pageCount: progress.pageCount,
      })),
      [
        { range: { from: 3_000, to: 4_000 }, nextCursor: "c3", pageCount: 1 },
        { range: { from: 5_000, to: 6_000 }, nextCursor: "c2", pageCount: 1 },
      ],
    );
    // Touching an edge counts as overlap.
    assertEquals(
      cache.pendingRanges(LIST_FEED, 2_000, 3_000).map((p) => p.range),
      [{ from: 1_000, to: 2_000 }, { from: 3_000, to: 4_000 }],
    );
    assertEquals(
      cache.pendingRanges(CHAT_FEED, 1_000, 6_000).map((p) => p.range),
      [{ from: 1_000, to: 2_000 }],
    );
  });
});

test("clear removes pending progress for the source only", async () => {
  await withTestDb(async (database) => {
    const first = await createXSource(database, "cache-clear-progress-a@example.com");
    const second = await createXSource(
      database,
      "cache-clear-progress-b@example.com",
    );
    const firstCache = new DatabaseXContentCache(database, first.id);
    const secondCache = new DatabaseXContentCache(database, second.id);

    firstCache.recordPage(
      LIST_FEED,
      { from: 1_000, to: 2_000 },
      [post("t-1", 1_500)],
      "c1",
    );
    secondCache.recordPage(
      LIST_FEED,
      { from: 1_000, to: 2_000 },
      [post("s2-t-1", 1_500)],
      "c2",
    );

    firstCache.clear();

    assertEquals(await countProgressRows(database, first.id), 0);
    assertEquals(firstCache.pendingRanges(LIST_FEED, 1_000, 2_000), []);
    assertEquals(await countRows(database, first.id), { items: 0, ranges: 0 });
    // Unrelated source keeps its progress and items.
    assertEquals(await countProgressRows(database, second.id), 1);
    assertEquals(secondCache.pendingRanges(LIST_FEED, 1_000, 2_000).length, 1);
    assertEquals(secondCache.read(LIST_FEED, 1_000, 2_000).length, 1);
  });
});

test("deleting a source cascades its pending progress", async () => {
  await withTestDb(async (database) => {
    const source = await createXSource(
      database,
      "cache-cascade-progress@example.com",
    );
    const cache = new DatabaseXContentCache(database, source.id);
    cache.recordPage(
      LIST_FEED,
      { from: 1_000, to: 2_000 },
      [post("t-1", 1_500)],
      "c1",
    );
    assertEquals(await countProgressRows(database, source.id), 1);
    assertEquals(await countRows(database, source.id), { items: 1, ranges: 0 });

    database.delete(sources).where(eq(sources.id, source.id)).run();

    assertEquals(await countProgressRows(database, source.id), 0);
    assertEquals(await countRows(database, source.id), { items: 0, ranges: 0 });
  });
});

test("page-N failure leaves the range resumable from the saved cursor", async () => {
  await withTestDb(async (database) => {
    const source = await createXSource(
      database,
      "cache-page-resume@example.com",
    );

    // Run 1: two pages persisted, then the process dies before finishing.
    const firstCache = new DatabaseXContentCache(database, source.id);
    firstCache.recordPage(
      LIST_FEED,
      { from: 1_000, to: 2_000 },
      [post("t-1", 1_500)],
      "cursor-1",
      { fetchedAt: 100 },
    );
    firstCache.recordPage(
      LIST_FEED,
      { from: 1_000, to: 2_000 },
      [post("t-2", 1_600)],
      "cursor-2",
      { fetchedAt: 200 },
    );

    // Run 2: a fresh cache sees exactly what survived — items, cursor, page
    // count — and no coverage, so page 1 is never repurchased.
    const resumed = new DatabaseXContentCache(database, source.id);
    assertEquals(resumed.pendingRanges(LIST_FEED, 1_000, 2_000), [{
      range: { from: 1_000, to: 2_000 },
      nextCursor: "cursor-2",
      pageCount: 2,
      updatedAt: 200,
      blockedReason: null,
      seenCursors: ["cursor-1", "cursor-2"],
    }]);
    assertEquals(
      resumed.read(LIST_FEED, 1_000, 2_000).map((item) => item.externalId),
      ["t-1", "t-2"],
    );
    assertEquals(resumed.missingRanges(LIST_FEED, 1_000, 2_000), [{
      from: 1_000,
      to: 2_000,
    }]);

    // Resume from the saved cursor, finish, and commit.
    resumed.recordPage(
      LIST_FEED,
      { from: 1_000, to: 2_000 },
      [post("t-3", 1_700)],
      null,
      { fetchedAt: 300 },
    );
    resumed.record(LIST_FEED, { from: 1_000, to: 2_000 }, []);

    assertEquals(resumed.pendingRanges(LIST_FEED, 1_000, 2_000), []);
    assertEquals(resumed.missingRanges(LIST_FEED, 1_000, 2_000), []);
    assertEquals(resumed.read(LIST_FEED, 1_000, 2_000).length, 3);
    assertEquals(await countProgressRows(database, source.id), 0);
  });
});

test("recordPage returns the persisted state and normal progress reports no block", async () => {
  await withTestDb(async (database) => {
    const source = await createXSource(database, "cache-return@example.com");
    const cache = new DatabaseXContentCache(database, source.id);
    const range = { from: 1_000, to: 2_000 };

    const first = cache.recordPage(
      LIST_FEED,
      range,
      [post("t-1", 1_500)],
      "c1",
      { fetchedAt: 111 },
    );
    assertEquals(first, {
      range,
      nextCursor: "c1",
      pageCount: 1,
      updatedAt: 111,
      blockedReason: null,
      seenCursors: ["c1"],
    });

    const second = cache.recordPage(
      LIST_FEED,
      range,
      [],
      "c2",
      { fetchedAt: 222 },
    );
    assertEquals(second.pageCount, 2);
    assertEquals(second.blockedReason, null);
    assertEquals(second.seenCursors, ["c1", "c2"]);

    // A fresh instance sees the same durable state: normal progress stays
    // resumable, with no terminal reason.
    const fresh = new DatabaseXContentCache(database, source.id);
    assertEquals(fresh.pendingRanges(LIST_FEED, 1_000, 2_000), [{
      range,
      nextCursor: "c2",
      pageCount: 2,
      updatedAt: 222,
      blockedReason: null,
      seenCursors: ["c1", "c2"],
    }]);
  });
});

test("a cursor cycle across fresh cache instances blocks the range durably", async () => {
  await withTestDb(async (database) => {
    const source = await createXSource(database, "cache-cycle@example.com");
    const range = { from: 1_000, to: 2_000 };

    // Page 1 through instance A: cursor "a" saved with history ["a"].
    const first = new DatabaseXContentCache(database, source.id).recordPage(
      LIST_FEED,
      range,
      [post("t-1", 1_500)],
      "a",
      { fetchedAt: 100 },
    );
    assertEquals(first.blockedReason, null);
    assertEquals(first.seenCursors, ["a"]);

    // Page 2 through a fresh instance B: history ["a", "b"].
    const second = new DatabaseXContentCache(database, source.id).recordPage(
      LIST_FEED,
      range,
      [post("t-2", 1_600)],
      "b",
      { fetchedAt: 200 },
    );
    assertEquals(second.blockedReason, null);
    assertEquals(second.seenCursors, ["a", "b"]);

    // The provider cycles back to "a": the page and its items are still
    // persisted, and the terminal reason is set atomically.
    const cycle = new DatabaseXContentCache(database, source.id).recordPage(
      LIST_FEED,
      range,
      [post("t-3", 1_700)],
      "a",
      { fetchedAt: 300 },
    );
    assertEquals(cycle.blockedReason, "repeated_cursor");
    assertEquals(cycle.pageCount, 3);
    assertEquals(cycle.seenCursors, ["a", "b"]);
    assertEquals(cycle.nextCursor, "a");
    assertEquals(cycle.updatedAt, 300);

    const afterCycle = new DatabaseXContentCache(database, source.id);
    assertEquals(afterCycle.read(LIST_FEED, 1_000, 2_000).length, 3);
    // Still no coverage: the blocked range was never committed.
    assertEquals(afterCycle.missingRanges(LIST_FEED, 1_000, 2_000), [range]);

    // A fourth fresh instance sees the terminal block, not resumable
    // progress.
    const final = new DatabaseXContentCache(database, source.id);
    assertEquals(final.pendingRanges(LIST_FEED, 1_000, 2_000), [{
      range,
      nextCursor: "a",
      pageCount: 3,
      updatedAt: 300,
      blockedReason: "repeated_cursor",
      seenCursors: ["a", "b"],
    }]);
  });
});

test("missing-cursor and mismatched-conversation pages persist atomically", async () => {
  await withTestDb(async (database) => {
    const source = await createXSource(database, "cache-block-reasons@example.com");
    const cache = new DatabaseXContentCache(database, source.id);

    const missing = cache.recordPage(
      LIST_FEED,
      { from: 1_000, to: 2_000 },
      [],
      null,
      { blockedReason: "missing_cursor", fetchedAt: 10 },
    );
    const mismatched = cache.recordPage(
      LIST_FEED,
      { from: 3_000, to: 4_000 },
      [],
      null,
      { blockedReason: "mismatched_conversation", fetchedAt: 20 },
    );
    assertEquals(missing, {
      range: { from: 1_000, to: 2_000 },
      nextCursor: null,
      pageCount: 1,
      updatedAt: 10,
      blockedReason: "missing_cursor",
      seenCursors: [],
    });
    assertEquals(mismatched.blockedReason, "mismatched_conversation");
    assertEquals(mismatched.pageCount, 1);
    assertEquals(mismatched.seenCursors, []);

    // A fresh instance sees both terminal reasons; no items were stored and
    // no coverage was added.
    const fresh = new DatabaseXContentCache(database, source.id);
    assertEquals(fresh.pendingRanges(LIST_FEED, 1_000, 4_000), [
      {
        range: { from: 1_000, to: 2_000 },
        nextCursor: null,
        pageCount: 1,
        updatedAt: 10,
        blockedReason: "missing_cursor",
        seenCursors: [],
      },
      {
        range: { from: 3_000, to: 4_000 },
        nextCursor: null,
        pageCount: 1,
        updatedAt: 20,
        blockedReason: "mismatched_conversation",
        seenCursors: [],
      },
    ]);
    assertEquals(fresh.read(LIST_FEED, 1_000, 4_000), []);
    assertEquals(fresh.missingRanges(LIST_FEED, 1_000, 4_000), [{
      from: 1_000,
      to: 4_000,
    }]);
  });
});

test("a later normal page cannot clear a terminal block", async () => {
  await withTestDb(async (database) => {
    const source = await createXSource(database, "cache-block-sticky@example.com");
    const cache = new DatabaseXContentCache(database, source.id);
    const range = { from: 1_000, to: 2_000 };

    cache.recordPage(LIST_FEED, range, [post("t-1", 1_500)], "c1", {
      fetchedAt: 100,
    });
    cache.recordPage(LIST_FEED, range, [post("t-2", 1_600)], "c2", {
      fetchedAt: 200,
    });
    const blocked = cache.recordPage(LIST_FEED, range, [], null, {
      blockedReason: "missing_cursor",
      fetchedAt: 300,
    });
    assertEquals(blocked.blockedReason, "missing_cursor");

    // A normal page afterwards still bumps count, replaces the cursor, and
    // grows the history, but the terminal reason survives.
    const later = cache.recordPage(LIST_FEED, range, [post("t-3", 1_700)], "c3", {
      fetchedAt: 400,
    });
    assertEquals(later.blockedReason, "missing_cursor");
    assertEquals(later.pageCount, 4);
    assertEquals(later.nextCursor, "c3");
    assertEquals(later.seenCursors, ["c1", "c2", "c3"]);

    const fresh = new DatabaseXContentCache(database, source.id);
    assertEquals(fresh.pendingRanges(LIST_FEED, 1_000, 2_000), [{
      range,
      nextCursor: "c3",
      pageCount: 4,
      updatedAt: 400,
      blockedReason: "missing_cursor",
      seenCursors: ["c1", "c2", "c3"],
    }]);
    // The durable reason is stored in the row itself.
    const row = database
      .select({ blockedReason: xContentFetchProgress.blockedReason })
      .from(xContentFetchProgress)
      .where(eq(xContentFetchProgress.sourceId, source.id))
      .get();
    assertEquals(row, { blockedReason: "missing_cursor" });
  });
});

test("record, clear, and source deletion remove blocked progress", async () => {
  await withTestDb(async (database) => {
    // A final record() commits the range and deletes its blocked progress.
    const committed = await createXSource(
      database,
      "cache-block-commit@example.com",
    );
    const commitCache = new DatabaseXContentCache(database, committed.id);
    commitCache.recordPage(
      LIST_FEED,
      { from: 1_000, to: 2_000 },
      [post("t-1", 1_500)],
      "c1",
    );
    // The provider hands the same cursor back: the range blocks.
    commitCache.recordPage(
      LIST_FEED,
      { from: 1_000, to: 2_000 },
      [post("t-2", 1_600)],
      "c1",
      { fetchedAt: 1 },
    );
    assertEquals(await countProgressRows(database, committed.id), 1);
    commitCache.record(LIST_FEED, { from: 1_000, to: 2_000 }, []);
    assertEquals(await countProgressRows(database, committed.id), 0);
    assertEquals(commitCache.pendingRanges(LIST_FEED, 1_000, 2_000), []);
    assertEquals(commitCache.missingRanges(LIST_FEED, 1_000, 2_000), []);

    // clear() wipes blocked progress with everything else.
    const cleared = await createXSource(
      database,
      "cache-block-clear@example.com",
    );
    const clearCache = new DatabaseXContentCache(database, cleared.id);
    clearCache.recordPage(
      LIST_FEED,
      { from: 1_000, to: 2_000 },
      [post("t-3", 1_500)],
      "c1",
    );
    clearCache.recordPage(
      LIST_FEED,
      { from: 1_000, to: 2_000 },
      [],
      "c1",
      { blockedReason: "missing_cursor" },
    );
    assertEquals(await countProgressRows(database, cleared.id), 1);
    clearCache.clear();
    assertEquals(await countProgressRows(database, cleared.id), 0);
    assertEquals(await countRows(database, cleared.id), { items: 0, ranges: 0 });

    // Deleting the source cascades blocked progress away.
    const cascaded = await createXSource(
      database,
      "cache-block-cascade@example.com",
    );
    const cascadeCache = new DatabaseXContentCache(database, cascaded.id);
    cascadeCache.recordPage(
      LIST_FEED,
      { from: 1_000, to: 2_000 },
      [post("t-4", 1_500)],
      "c1",
    );
    cascadeCache.recordPage(
      LIST_FEED,
      { from: 1_000, to: 2_000 },
      [],
      "c1",
      { blockedReason: "mismatched_conversation" },
    );
    assertEquals(await countProgressRows(database, cascaded.id), 1);
    database.delete(sources).where(eq(sources.id, cascaded.id)).run();
    assertEquals(await countProgressRows(database, cascaded.id), 0);
    assertEquals(await countRows(database, cascaded.id), { items: 0, ranges: 0 });
  });
});

test("revision and feed-activity guards reject blocked pages writing nothing", async () => {
  await withTestDb(async (database) => {
    // Reconnect bumps the revision: a blocked page rejects inside its
    // immediate transaction and writes neither items nor progress.
    const source = await createXSource(
      database,
      "cache-block-revision@example.com",
    );
    const userId = database
      .select({ userId: sources.userId })
      .from(sources)
      .where(eq(sources.id, source.id))
      .get()?.userId;
    assertExists(userId);
    const now = Date.now();
    database.insert(feeds).values({
      sourceId: source.id,
      externalId: LIST_FEED,
      name: "List Feed",
      kind: "news",
      createdAt: now,
      updatedAt: now,
    }).run();

    const cache = new DatabaseXContentCache(database, source.id, 1);
    await upsertSourceCredentials(database, {
      userId,
      connectorId: ConnectorId.X,
      credentials: await cipher().encrypt(JSON.stringify({ fixture: true }), {
        userId,
        connectorId: ConnectorId.X,
      }),
    });
    assertThrows(
      () =>
        cache.recordPage(
          LIST_FEED,
          { from: 1_000, to: 2_000 },
          [post("t-1", 1_500)],
          "c1",
          { blockedReason: "missing_cursor" },
        ),
      ConflictError,
      "source connection changed",
    );
    assertEquals(await countProgressRows(database, source.id), 0);
    assertEquals(await countRows(database, source.id), { items: 0, ranges: 0 });

    // Disabling the feed makes a revision-bound cache reject a blocked page
    // the same way, leaving the pre-disable page untouched.
    const disabled = await createXSource(
      database,
      "cache-block-disabled@example.com",
    );
    const disabledUserId = database
      .select({ userId: sources.userId })
      .from(sources)
      .where(eq(sources.id, disabled.id))
      .get()?.userId;
    assertExists(disabledUserId);
    database.insert(feeds).values({
      sourceId: disabled.id,
      externalId: LIST_FEED,
      name: "List Feed",
      kind: "news",
      createdAt: now,
      updatedAt: now,
    }).run();
    const disabledCache = new DatabaseXContentCache(database, disabled.id, 1);
    disabledCache.recordPage(
      LIST_FEED,
      { from: 1_000, to: 2_000 },
      [post("t-2", 1_500)],
      "c1",
    );
    database.update(feeds)
      .set({ enabled: false, updatedAt: Date.now() })
      .where(and(
        eq(feeds.sourceId, disabled.id),
        eq(feeds.externalId, LIST_FEED),
      ))
      .run();
    assertThrows(
      () =>
        disabledCache.recordPage(
          LIST_FEED,
          { from: 3_000, to: 4_000 },
          [post("t-3", 3_500)],
          "c2",
          { blockedReason: "repeated_cursor" },
        ),
      ConflictError,
      "feed became inactive",
    );
    assertEquals(await countProgressRows(database, disabled.id), 1);
    assertEquals(await countRows(database, disabled.id), { items: 1, ranges: 0 });
  });
});

test("cursor history stays distinct and bounded at 500 entries", async () => {
  await withTestDb(async (database) => {
    const source = await createXSource(database, "cache-cursor-bound@example.com");
    const cache = new DatabaseXContentCache(database, source.id);
    const range = { from: 1_000, to: 2_000 };

    for (let i = 0; i < 550; i++) {
      cache.recordPage(
        LIST_FEED,
        range,
        [],
        `c${String(i).padStart(3, "0")}`,
        { fetchedAt: i },
      );
    }

    const saved = cache.pendingRanges(LIST_FEED, 1_000, 2_000)[0];
    assertExists(saved);
    // The window keeps the most recent 500 distinct cursors, dropping the
    // oldest entries.
    assertEquals(saved.seenCursors.length, 500);
    assertEquals(saved.seenCursors[0], "c050");
    assertEquals(saved.seenCursors[499], "c549");
    assertEquals(saved.pageCount, 550);
    assertEquals(saved.blockedReason, null);

    // A cursor still inside the window is detected as a repeat.
    const repeat = cache.recordPage(LIST_FEED, range, [], "c500", {
      fetchedAt: 550,
    });
    assertEquals(repeat.blockedReason, "repeated_cursor");
    assertEquals(repeat.seenCursors.length, 500);
    assertEquals(repeat.seenCursors[499], "c549");
  });
});

test("the database check rejects unknown blocked reasons", async () => {
  await withTestDb(async (database) => {
    const source = await createXSource(database, "cache-block-check@example.com");

    // A value outside the union fails the migration's CHECK constraint.
    assertThrows(
      () =>
        database.insert(xContentFetchProgress).values({
          sourceId: source.id,
          feedExternalId: LIST_FEED,
          startMs: 1_000,
          endMs: 2_000,
          nextCursor: null,
          blockedReason: "bogus" as unknown as XContentProgressBlockReason,
          pageCount: 1,
          seenCursors: [],
          createdAt: 1,
          updatedAt: 1,
        }).run(),
      Error,
    );
    assertEquals(await countProgressRows(database, source.id), 0);

    // Every allowed value passes the check.
    const reasons: XContentProgressBlockReason[] = [
      "repeated_cursor",
      "missing_cursor",
      "mismatched_conversation",
    ];
    reasons.forEach((reason, index) => {
      database.insert(xContentFetchProgress).values({
        sourceId: source.id,
        feedExternalId: LIST_FEED,
        startMs: 10_000 + index * 2_000,
        endMs: 11_000 + index * 2_000,
        nextCursor: null,
        blockedReason: reason,
        pageCount: 1,
        seenCursors: [],
        createdAt: 1,
        updatedAt: 1,
      }).run();
    });
    assertEquals(await countProgressRows(database, source.id), 3);
  });
});
