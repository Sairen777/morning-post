import { test } from "bun:test";

import {
  abortReason,
  throwIfAborted,
} from "../src/connectors/x/abort.ts";
import type {
  XApiClient,
  XContentPage,
} from "../src/connectors/x/twex-api-client.ts";
import { XConnector } from "../src/connectors/x/x-connector.ts";
import type {
  TwexConversation,
  TwexList,
  TwexUserInfo,
  XRawChatMessage,
  XRawItem,
  XRawPost,
} from "../src/connectors/x/x.types.ts";
import type {
  XContentCache,
  XContentPageProgress,
  XContentProgressBlockReason,
  XContentRecordPageOptions,
  XTimeRange,
} from "../src/repositories/x-content-cache-repository.ts";
import { ConnectorId } from "../src/constants.ts";
import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
} from "./assertions.ts";

const FROM = 1_700_000_000_000;
const TO = FROM + 10_000;
const MID = FROM + 5_000;

// The request is 12:50-19:10 and coverage is 13:00-19:00, leaving exactly
// ten-minute head and tail slivers on both edges.
const TOLERANCE_MS = 600_000;
const TOL_BASE = 1_700_000_000_000;
const TOL_FROM = TOL_BASE;
const TOL_COVER_FROM = TOL_BASE + TOLERANCE_MS;
const TOL_COVER_TO = TOL_BASE + 37 * TOLERANCE_MS;
const TOL_TO = TOL_BASE + 38 * TOLERANCE_MS;
const WIDE_PENDING_FROM = TOL_BASE - 5 * TOLERANCE_MS;
const WIDE_PENDING_TO = TOL_BASE + 43 * TOLERANCE_MS;

function chatMessage(
  externalId: string,
  date: number,
  reactions: XRawChatMessage["reactions"] = [],
): XRawChatMessage {
  return {
    kind: "chat_message",
    externalId,
    platformId: externalId,
    date,
    text: `chat ${externalId}`,
    author: "Chat Author",
    url: "https://x.com/i/chat/team-chat",
    reactions,
  };
}

function post(
  externalId: string,
  date: number,
  metrics: Pick<
    XRawPost,
    "replyCount" | "repostCount" | "likeCount" | "viewCount"
  > = {
    replyCount: null,
    repostCount: null,
    likeCount: null,
    viewCount: null,
  },
): XRawPost {
  return {
    kind: "post",
    externalId,
    platformId: externalId,
    date,
    text: `post ${externalId}`,
    author: "Post Author",
    url: `https://x.com/post-author/status/${externalId}`,
    ...metrics,
  };
}

function listData(id: string, name: string): TwexList {
  return {
    id,
    name,
    description: "fixture list",
    is_private: false,
    member_count: 1,
    subscriber_count: 0,
  };
}

function conversationData(
  conversationId: string,
  type: TwexConversation["type"],
  participants: string[],
): TwexConversation {
  return { conversation_id: conversationId, type, is_muted: false, participants };
}

/** In-memory {@link XContentCache} with the same gap math as the SQLite one:
 * merged coverage within the window, complement as gaps, reads filtered to
 * the window and ordered by date then external id. */
class FakeXContentCache implements XContentCache {
  private static readonly MAX_SEEN_CURSORS = 500;

  public readonly coverage = new Map<string, XTimeRange[]>();
  public readonly storedItems = new Map<string, XRawItem[]>();
  public readonly progress = new Map<string, XContentPageProgress[]>();
  /** Durable per-range seen cursors, mirroring the SQLite cache's bounded set. */
  private readonly seenCursors = new Map<string, string[]>();
  public readonly records: Array<{ feed: string; range: XTimeRange; items: XRawItem[] }> = [];
  public readonly pageRecords: Array<{
    feed: string;
    range: XTimeRange;
    items: XRawItem[];
    nextCursor: string | null;
    pageCount: number;
    blockedReason: XContentProgressBlockReason | null;
  }> = [];
  public clearCount = 0;
  public recordPageFailure: Error | undefined;
  public recordFailure: Error | undefined;

  public seedCoverage(feed: string, range: XTimeRange): void {
    const ranges = this.coverage.get(feed) ?? [];
    ranges.push({ ...range });
    this.coverage.set(feed, ranges);
  }

  public seedItems(feed: string, items: XRawItem[]): void {
    const byExternalId = new Map(
      (this.storedItems.get(feed) ?? []).map((item) => [item.externalId, item]),
    );
    for (const item of items) byExternalId.set(item.externalId, item);
    this.storedItems.set(feed, [...byExternalId.values()]);
  }

  private seenKey(feed: string, range: XTimeRange): string {
    return `${feed}::${range.from}:${range.to}`;
  }

  private seenFor(feed: string, range: XTimeRange): string[] {
    const key = this.seenKey(feed, range);
    let seen = this.seenCursors.get(key);
    if (seen === undefined) {
      seen = [];
      this.seenCursors.set(key, seen);
    }
    return seen;
  }

  public seedProgress(
    feed: string,
    progress: Omit<XContentPageProgress, "seenCursors"> & {
      seenCursors?: string[];
    },
  ): void {
    const entries = this.progress.get(feed) ?? [];
    const index = entries.findIndex((entry) =>
      entry.range.from === progress.range.from && entry.range.to === progress.range.to
    );
    const seenCursors = progress.seenCursors !== undefined
      ? [...progress.seenCursors]
      : progress.nextCursor === null
        ? []
        : [progress.nextCursor];
    const copy: XContentPageProgress = {
      range: { ...progress.range },
      nextCursor: progress.nextCursor,
      pageCount: progress.pageCount,
      updatedAt: progress.updatedAt,
      blockedReason: progress.blockedReason,
      seenCursors,
    };
    if (index < 0) entries.push(copy);
    else entries[index] = copy;
    this.progress.set(feed, entries);
    this.seenCursors.set(this.seenKey(feed, progress.range), [...seenCursors]);
  }

  public missingRanges(feed: string, from: number, to: number): XTimeRange[] {
    const merged: XTimeRange[] = [];
    for (const range of [...(this.coverage.get(feed) ?? [])].sort(
      (left, right) => left.from - right.from,
    )) {
      const last = merged[merged.length - 1];
      if (last !== undefined && range.from <= last.to + 1) {
        if (range.to > last.to) last.to = range.to;
      } else {
        merged.push({ ...range });
      }
    }
    const gaps: XTimeRange[] = [];
    let cursor = from;
    for (const range of merged) {
      if (range.to < cursor) continue;
      if (range.from > cursor) {
        gaps.push({ from: cursor, to: Math.min(range.from - 1, to) });
      }
      cursor = Math.max(cursor, range.to + 1);
      if (cursor > to) break;
    }
    if (cursor <= to) gaps.push({ from: cursor, to });
    return gaps;
  }

  public read(feed: string, from: number, to: number): XRawItem[] {
    return [...(this.storedItems.get(feed) ?? [])]
      .filter((item) => item.date >= from && item.date <= to)
      .sort(
        (left, right) => left.date - right.date
          || left.externalId.localeCompare(right.externalId),
      );
  }

  public pendingRanges(
    feed: string,
    from: number,
    to: number,
  ): XContentPageProgress[] {
    return [...(this.progress.get(feed) ?? [])]
      .filter((entry) => entry.range.from <= to && entry.range.to >= from)
      .sort((left, right) => left.range.from - right.range.from)
      .map((entry) => ({
        range: { ...entry.range },
        nextCursor: entry.nextCursor,
        pageCount: entry.pageCount,
        updatedAt: entry.updatedAt,
        blockedReason: entry.blockedReason,
        seenCursors: [...entry.seenCursors],
      }));
  }

  public recordPage(
    feed: string,
    range: XTimeRange,
    items: XRawItem[],
    nextCursor: string | null,
    options: XContentRecordPageOptions = {},
  ): XContentPageProgress {
    if (this.recordPageFailure !== undefined) throw this.recordPageFailure;
    const existing = (this.progress.get(feed) ?? []).find((entry) =>
      entry.range.from === range.from && entry.range.to === range.to
    );
    const pageCount = (existing?.pageCount ?? 0) + 1;
    const seen = this.seenFor(feed, range);
    // Mirrors the SQLite upsert: the page, its cursor, and the durable
    // seen-cursor set are updated in one atomic write, so a cycle is detected
    // here (not by the connector) and survives connector restarts. A caller
    // supplied reason wins over auto-detection, and an existing terminal
    // reason is sticky: a later normal page never clears it.
    const repeated =
      nextCursor !== null && seen.includes(nextCursor);
    const blockedReason =
      existing?.blockedReason ??
      options.blockedReason ??
      (repeated ? "repeated_cursor" : null);
    if (nextCursor !== null && !repeated) {
      seen.push(nextCursor);
      if (seen.length > FakeXContentCache.MAX_SEEN_CURSORS) seen.shift();
    }
    const updatedAt = options.fetchedAt ?? Date.now();
    this.seedItems(feed, items);
    this.seedProgress(feed, {
      range,
      nextCursor,
      pageCount,
      updatedAt,
      blockedReason,
      seenCursors: [...seen],
    });
    this.pageRecords.push({
      feed,
      range: { ...range },
      items: [...items],
      nextCursor,
      pageCount,
      blockedReason,
    });
    return {
      range: { ...range },
      nextCursor,
      pageCount,
      updatedAt,
      blockedReason,
      seenCursors: [...seen],
    };
  }

  public record(feed: string, range: XTimeRange, items: XRawItem[]): void {
    if (this.recordFailure !== undefined) throw this.recordFailure;
    this.records.push({ feed, range: { ...range }, items: [...items] });
    this.seedCoverage(feed, range);
    this.seedItems(feed, items);
    const entries = this.progress.get(feed) ?? [];
    this.progress.set(
      feed,
      entries.filter((entry) =>
        entry.range.from !== range.from || entry.range.to !== range.to
      ),
    );
  }

  public clear(): void {
    this.clearCount += 1;
    this.coverage.clear();
    this.storedItems.clear();
    this.progress.clear();
  }
}

type FakePageResult<T> = XContentPage<T> | Error;

type FakeClientCall = {
  op: "searchLists" | "getConversations" | "getListPostsPage" | "getChatMessagesPage";
  query?: string;
  targetCount?: number;
  listId?: string;
  conversationId?: string;
  from?: number;
  to?: number;
  cursor?: string | null;
};

/** Deterministic {@link XApiClient} that honors abort signals and records
 * every call; content is seeded per list/conversation id. */
class FakeXApiClient implements XApiClient {
  public lists: TwexList[] = [];
  public conversations: TwexConversation[] = [];
  public readonly listPosts = new Map<string, XRawPost[]>();
  public readonly chatMessages = new Map<string, XRawChatMessage[]>();
  public readonly listPageResults = new Map<
    string,
    Map<string | null, FakePageResult<XRawPost>>
  >();
  public readonly chatPageResults = new Map<
    string,
    Map<string | null, FakePageResult<XRawChatMessage>>
  >();
  public readonly calls: FakeClientCall[] = [];
  public listPostsFailure: Error | undefined;
  public chatMessagesFailure: Error | undefined;
  public holdListPosts = false;
  /** Resolve list pages even when the operation signal aborted mid-flight. */
  public resolveListPagesDespiteAbort = false;
  /** Resolve chat pages even when the operation signal aborted mid-flight. */
  public resolveChatPagesDespiteAbort = false;
  public searchListsFailure: Error | undefined;
  public conversationsFailure: Error | undefined;
  public holdSearchLists = false;
  public searchListsSettled = false;
  public searchListsAbortReason: unknown;
  public holdConversations = false;
  public conversationsSettled = false;
  public conversationsAbortReason: unknown;
  /** Fires synchronously when a held discovery call settles. */
  public onDiscoverySettled: (() => void) | undefined;

  public getUserInfo(): Promise<TwexUserInfo> {
    return Promise.resolve({
      userId: "111",
      username: "tester",
      name: "Test",
      description: "",
      location: "",
      followersCount: 0,
      followingCount: 0,
      statusesCount: 0,
      mediaCount: 0,
      profileImageUrlHttps: "",
      createdAt: "",
      verified: false,
      protected: false,
    });
  }

  public searchLists(
    query: string,
    targetCount: number,
    signal?: AbortSignal,
  ): Promise<TwexList[]> {
    this.calls.push({ op: "searchLists", query, targetCount });
    throwIfAborted(signal);
    if (this.searchListsFailure !== undefined) {
      return Promise.reject(this.searchListsFailure);
    }
    if (this.holdSearchLists) {
      return new Promise<TwexList[]>((resolve, reject) => {
        const settle = () => {
          this.searchListsSettled = true;
          if (signal?.aborted) {
            this.searchListsAbortReason = abortReason(signal);
            reject(this.searchListsAbortReason);
          } else {
            resolve(this.lists);
          }
          this.onDiscoverySettled?.();
        };
        if (signal?.aborted) {
          settle();
          return;
        }
        signal?.addEventListener("abort", settle, { once: true });
      });
    }
    return Promise.resolve(this.lists);
  }

  public getConversations(signal?: AbortSignal): Promise<TwexConversation[]> {
    this.calls.push({ op: "getConversations" });
    throwIfAborted(signal);
    if (this.conversationsFailure !== undefined) {
      return Promise.reject(this.conversationsFailure);
    }
    if (this.holdConversations) {
      return new Promise<TwexConversation[]>((resolve, reject) => {
        const settle = () => {
          this.conversationsSettled = true;
          if (signal?.aborted) {
            this.conversationsAbortReason = abortReason(signal);
            reject(this.conversationsAbortReason);
          } else {
            resolve(this.conversations);
          }
          this.onDiscoverySettled?.();
        };
        if (signal?.aborted) {
          settle();
          return;
        }
        signal?.addEventListener("abort", settle, { once: true });
      });
    }
    return Promise.resolve(this.conversations);
  }

  public getListPostsPage(
    listId: string,
    from: number,
    to: number,
    cursor: string | null,
    signal?: AbortSignal,
  ): Promise<XContentPage<XRawPost>> {
    this.calls.push({ op: "getListPostsPage", listId, from, to, cursor });
    throwIfAborted(signal);
    const configured = this.listPageResults.get(listId)?.get(cursor);
    if (configured instanceof Error) return Promise.reject(configured);
    if (this.listPostsFailure !== undefined) {
      return Promise.reject(this.listPostsFailure);
    }
    const page = configured ?? {
      items: this.listPosts.get(listId) ?? [],
      nextCursor: null,
      complete: true,
    };
    return new Promise<XContentPage<XRawPost>>((resolve, reject) => {
      const release = () => {
        if (!signal?.aborted || this.resolveListPagesDespiteAbort) {
          resolve(page);
        }
      };
      if (signal?.aborted) {
        if (this.resolveListPagesDespiteAbort) resolve(page);
        else reject(abortReason(signal));
        return;
      }
      signal?.addEventListener(
        "abort",
        () => {
          if (this.resolveListPagesDespiteAbort) resolve(page);
          else reject(abortReason(signal));
        },
        { once: true },
      );
      if (!this.holdListPosts) queueMicrotask(release);
    });
  }

  public getChatMessagesPage(
    conversationId: string,
    from: number,
    to: number,
    cursor: string | null,
    signal?: AbortSignal,
  ): Promise<XContentPage<XRawChatMessage>> {
    this.calls.push({
      op: "getChatMessagesPage",
      conversationId,
      from,
      to,
      cursor,
    });
    throwIfAborted(signal);
    if (this.chatMessagesFailure !== undefined) {
      return Promise.reject(this.chatMessagesFailure);
    }
    const configured = this.chatPageResults.get(conversationId)?.get(cursor);
    if (configured instanceof Error) return Promise.reject(configured);
    const page = configured ?? {
      items: this.chatMessages.get(conversationId) ?? [],
      nextCursor: null,
      complete: true,
    };
    return new Promise<XContentPage<XRawChatMessage>>((resolve, reject) => {
      const release = () => {
        if (!signal?.aborted || this.resolveChatPagesDespiteAbort) {
          resolve(page);
        }
      };
      if (signal?.aborted) {
        if (this.resolveChatPagesDespiteAbort) resolve(page);
        else reject(abortReason(signal));
        return;
      }
      signal?.addEventListener(
        "abort",
        () => {
          if (this.resolveChatPagesDespiteAbort) resolve(page);
          else reject(abortReason(signal));
        },
        { once: true },
      );
      queueMicrotask(release);
    });
  }
}

test("listAvailableFeeds emits only lists and group chats with participant labels", async () => {
  const client = new FakeXApiClient();
  client.lists = [listData("1001", "Alpha"), listData("2002", "Beta")];
  client.conversations = [
    conversationData("conv-g1", "group", ["u1", "u2", "u3"]),
    conversationData("conv-d1", "direct", ["u1"]),
    conversationData("conv-g0", "group", ["u1", "u2"]),
  ];
  const connector = new XConnector(client, new FakeXContentCache(), "space", 0);

  const feeds = await connector.listAvailableFeeds();

  assertEquals(client.calls, [
    { op: "searchLists", query: "space", targetCount: 100 },
    { op: "getConversations" },
  ]);
  assertEquals(feeds, [
    { externalId: "x:list:1001", name: "Alpha", kind: "news" },
    { externalId: "x:list:2002", name: "Beta", kind: "news" },
    {
      externalId: "x:chat:conv-g0",
      name: "Group (2 participants) - conv-g0",
      kind: "discussion",
    },
    {
      externalId: "x:chat:conv-g1",
      name: "Group (3 participants) - conv-g1",
      kind: "discussion",
    },
  ]);
});

test("getRawData without explicit feeds discovers then collects every feed", async () => {
  const client = new FakeXApiClient();
  client.lists = [listData("1001", "Alpha")];
  client.conversations = [
    conversationData("conv-g1", "group", ["u1", "u2", "u3"]),
  ];
  client.listPosts.set("1001", [post("p1", FROM)]);
  client.chatMessages.set("conv-g1", [chatMessage("c1", FROM)]);
  const cache = new FakeXContentCache();
  const connector = new XConnector(client, cache, "space", 0);

  const raw = await connector.getRawData(FROM, TO);

  assertEquals(client.calls, [
    { op: "searchLists", query: "space", targetCount: 100 },
    { op: "getConversations" },
    { op: "getListPostsPage", listId: "1001", from: FROM, to: TO, cursor: null },
    {
      op: "getChatMessagesPage",
      conversationId: "conv-g1",
      from: FROM,
      to: TO,
      cursor: null,
    },
  ]);
  assertEquals(Object.keys(raw).sort(), ["x:chat:conv-g1", "x:list:1001"]);
  assertEquals(raw["x:list:1001"], {
    feed: { externalId: "x:list:1001", name: "Alpha", kind: "news" },
    target: { kind: "list", listId: "1001" },
    items: [post("p1", FROM)],
  });
  assertEquals(raw["x:chat:conv-g1"], {
    feed: {
      externalId: "x:chat:conv-g1",
      name: "Group (3 participants) - conv-g1",
      kind: "discussion",
    },
    target: { kind: "chat", conversationId: "conv-g1" },
    items: [chatMessage("c1", FROM)],
  });
  assertEquals(cache.records, [
    { feed: "x:list:1001", range: { from: FROM, to: TO }, items: [post("p1", FROM)] },
    {
      feed: "x:chat:conv-g1",
      range: { from: FROM, to: TO },
      items: [chatMessage("c1", FROM)],
    },
  ]);
});

test("getRawData with explicit feeds fetches only uncovered cache gaps", async () => {
  const client = new FakeXApiClient();
  client.listPosts.set("1001", [post("fresh", TO)]);
  const cache = new FakeXContentCache();
  cache.seedCoverage("x:list:1001", { from: FROM, to: MID });
  cache.seedItems("x:list:1001", [post("cached", FROM)]);
  const connector = new XConnector(client, cache, "space", 0);

  const raw = await connector.getRawData(FROM, TO, ["x:list:1001"]);

  assertEquals(client.calls, [
    {
      op: "getListPostsPage",
      listId: "1001",
      from: MID + 1,
      to: TO,
      cursor: null,
    },
  ]);

  assertEquals(cache.records, [
    { feed: "x:list:1001", range: { from: MID + 1, to: TO }, items: [post("fresh", TO)] },
  ]);
  assertEquals(raw["x:list:1001"].feed, {
    externalId: "x:list:1001",
    name: "List 1001",
    kind: "news",
  });
  assertEquals(raw["x:list:1001"].target, { kind: "list", listId: "1001" });
  assertEquals(raw["x:list:1001"].items, [post("cached", FROM), post("fresh", TO)]);
});

test("list page progress resumes after a later page failure without repurchasing earlier pages", async () => {
  const client = new FakeXApiClient();
  const pages = new Map<string | null, FakePageResult<XRawPost>>([
    [null, {
      items: [post("p1", FROM)],
      nextCursor: "cursor-1",
      complete: false,
    }],
    ["cursor-1", new Error("list page 2 exploded")],
    ["cursor-2", {
      items: [post("p3", FROM + 2)],
      nextCursor: null,
      complete: true,
    }],
  ]);
  client.listPageResults.set("1001", pages);
  const cache = new FakeXContentCache();
  const connector = new XConnector(client, cache, "space", 0);

  const firstError = await assertRejects(() =>
    connector.getRawData(FROM, TO, ["x:list:1001"])
  );
  assertStringIncludes(firstError.message, "list page 2 exploded");
  assertEquals(client.calls, [
    { op: "getListPostsPage", listId: "1001", from: FROM, to: TO, cursor: null },
    {
      op: "getListPostsPage",
      listId: "1001",
      from: FROM,
      to: TO,
      cursor: "cursor-1",
    },
  ]);
  const saved = cache.pendingRanges("x:list:1001", FROM, TO)[0];
  assertExists(saved);
  assertEquals(saved.nextCursor, "cursor-1");
  assertEquals(saved.pageCount, 1);

  pages.set("cursor-1", {
    items: [post("p2", FROM + 1)],
    nextCursor: "cursor-2",
    complete: false,
  });
  const raw = await connector.getRawData(FROM, TO, ["x:list:1001"]);

  assertEquals(client.calls, [
    { op: "getListPostsPage", listId: "1001", from: FROM, to: TO, cursor: null },
    {
      op: "getListPostsPage",
      listId: "1001",
      from: FROM,
      to: TO,
      cursor: "cursor-1",
    },
    {
      op: "getListPostsPage",
      listId: "1001",
      from: FROM,
      to: TO,
      cursor: "cursor-1",
    },
    {
      op: "getListPostsPage",
      listId: "1001",
      from: FROM,
      to: TO,
      cursor: "cursor-2",
    },
  ]);
  assertEquals(
    raw["x:list:1001"].items.map((item) => item.externalId),
    ["p1", "p2", "p3"],
  );
  assertEquals(cache.missingRanges("x:list:1001", FROM, TO), []);
});

test("incomplete chat page persists progress and the next operation resumes its cursor", async () => {
  const client = new FakeXApiClient();
  const pages = new Map<string | null, FakePageResult<XRawChatMessage>>([
    [null, {
      items: [chatMessage("c1", FROM)],
      nextCursor: "before-1",
      complete: false,
    }],
    ["before-1", {
      items: [chatMessage("c2", FROM + 1)],
      nextCursor: null,
      complete: true,
    }],
  ]);
  client.chatPageResults.set("g1", pages);
  const cache = new FakeXContentCache();
  const connector = new XConnector(client, cache, "space", 0);

  const firstError = await assertRejects(() =>
    connector.getRawData(FROM, TO, ["x:chat:g1"])
  );
  assertStringIncludes(firstError.message, "saved progress");
  assertEquals(client.calls, [
    {
      op: "getChatMessagesPage",
      conversationId: "g1",
      from: FROM,
      to: TO,
      cursor: null,
    },
  ]);
  const saved = cache.pendingRanges("x:chat:g1", FROM, TO)[0];
  assertExists(saved);
  assertEquals(saved.nextCursor, "before-1");
  assertEquals(saved.pageCount, 1);

  const raw = await connector.getRawData(FROM, TO, ["x:chat:g1"]);

  assertEquals(client.calls, [
    {
      op: "getChatMessagesPage",
      conversationId: "g1",
      from: FROM,
      to: TO,
      cursor: null,
    },
    {
      op: "getChatMessagesPage",
      conversationId: "g1",
      from: FROM,
      to: TO,
      cursor: "before-1",
    },
  ]);
  assertEquals(
    raw["x:chat:g1"].items.map((item) => item.externalId),
    ["c1", "c2"],
  );
  assertEquals(cache.pendingRanges("x:chat:g1", FROM, TO), []);
  assertEquals(cache.missingRanges("x:chat:g1", FROM, TO), []);
});

test("a cache page-write failure prevents the next provider request", async () => {
  const client = new FakeXApiClient();
  client.listPageResults.set("1001", new Map([
    [null, {
      items: [post("p1", FROM)],
      nextCursor: "cursor-1",
      complete: false,
    }],
    ["cursor-1", {
      items: [post("p2", FROM + 1)],
      nextCursor: null,
      complete: true,
    }],
  ]));
  const cache = new FakeXContentCache();
  cache.recordPageFailure = new Error("cache page write exploded");
  const connector = new XConnector(client, cache, "space", 0);

  const error = await assertRejects(() =>
    connector.getRawData(FROM, TO, ["x:list:1001"])
  );

  assertStringIncludes(error.message, "cache page write exploded");
  assertEquals(client.calls, [
    { op: "getListPostsPage", listId: "1001", from: FROM, to: TO, cursor: null },
  ]);
  assertEquals(cache.pendingRanges("x:list:1001", FROM, TO), []);
});

test("completed ranges stay covered across repeated calls", async () => {
  const client = new FakeXApiClient();
  client.listPosts.set("1001", [post("cached", FROM)]);
  const cache = new FakeXContentCache();
  const connector = new XConnector(client, cache, "space", 0);

  await connector.getRawData(FROM, TO, ["x:list:1001"]);
  await connector.getRawData(FROM, TO, ["x:list:1001"]);
  await connector.getRawData(FROM, TO, ["x:list:1001"]);

  assertEquals(client.calls, [
    { op: "getListPostsPage", listId: "1001", from: FROM, to: TO, cursor: null },
  ]);
  assertEquals(cache.missingRanges("x:list:1001", FROM, TO), []);
});

test("list safety limits use durable page counts before another request", async () => {
  const client = new FakeXApiClient();
  const cache = new FakeXContentCache();
  cache.seedProgress("x:list:1001", {
    range: { from: FROM, to: TO },
    nextCursor: "cursor-500",
    pageCount: 500,
    updatedAt: 1,
    blockedReason: null,
  });
  const connector = new XConnector(client, cache, "space", 0);

  await assertRejects(
    () => connector.getRawData(FROM, TO, ["x:list:1001"]),
    "safety page limit",
  );
  assertEquals(client.calls, []);
});

test("stale pending progress under wider coverage makes zero provider calls", async () => {
  const client = new FakeXApiClient();
  const cache = new FakeXContentCache();
  cache.seedProgress("x:list:1001", {
    range: { from: FROM, to: MID },
    nextCursor: "stale-1",
    pageCount: 4,
    updatedAt: 1,
    blockedReason: null,
  });
  cache.seedProgress("x:chat:g1", {
    range: { from: FROM, to: MID },
    nextCursor: "stale-2",
    pageCount: 2,
    updatedAt: 1,
    blockedReason: null,
  });
  cache.seedCoverage("x:list:1001", { from: FROM - 1_000, to: TO + 1_000 });
  cache.seedCoverage("x:chat:g1", { from: FROM - 1_000, to: TO + 1_000 });
  cache.seedItems("x:list:1001", [post("cached", FROM)]);
  cache.seedItems("x:chat:g1", [chatMessage("cached", FROM)]);
  const connector = new XConnector(client, cache, "space", 0);

  const raw = await connector.getRawData(FROM, TO, ["x:list:1001", "x:chat:g1"]);

  assertEquals(client.calls, []);
  assertEquals(raw["x:list:1001"].items, [post("cached", FROM)]);
  assertEquals(raw["x:chat:g1"].items, [chatMessage("cached", FROM)]);
});

test("chat issues one request for pending completion and fails before a second for the leftover gap", async () => {
  const client = new FakeXApiClient();
  client.chatPageResults.set("g1", new Map([
    ["before-1", {
      items: [chatMessage("c1", FROM)],
      nextCursor: null,
      complete: true,
    }],
  ]));
  const cache = new FakeXContentCache();
  cache.seedProgress("x:chat:g1", {
    range: { from: FROM, to: MID },
    nextCursor: "before-1",
    pageCount: 1,
    updatedAt: 1,
    blockedReason: null,
  });
  const connector = new XConnector(client, cache, "space", 0);

  const error = await assertRejects(() =>
    connector.getRawData(FROM, TO, ["x:chat:g1"])
  );

  assertStringIncludes(error.message, "second DM-history request");
  assertEquals(client.calls, [
    {
      op: "getChatMessagesPage",
      conversationId: "g1",
      from: FROM,
      to: MID,
      cursor: "before-1",
    },
  ]);
  assertEquals(cache.missingRanges("x:chat:g1", FROM, MID), []);
});

test("multiple fresh chat gaps are coalesced into one all-mode request", async () => {
  const client = new FakeXApiClient();
  client.chatMessages.set("g1", [chatMessage("c1", FROM)]);
  const cache = new FakeXContentCache();
  cache.seedCoverage("x:chat:g1", { from: MID, to: MID });
  cache.seedItems("x:chat:g1", [chatMessage("c-middle", MID)]);
  const connector = new XConnector(client, cache, "space", 0);

  const raw = await connector.getRawData(FROM, TO, ["x:chat:g1"]);

  assertEquals(client.calls, [
    {
      op: "getChatMessagesPage",
      conversationId: "g1",
      from: FROM,
      to: TO,
      cursor: null,
    },
  ]);
  assertEquals(
    raw["x:chat:g1"].items.map((item) => item.externalId),
    ["c1", "c-middle"],
  );
  assertEquals(cache.missingRanges("x:chat:g1", FROM, TO), []);
});

test("list pagination rejects a repeated cursor after persisting the page", async () => {
  const client = new FakeXApiClient();
  client.listPageResults.set("1001", new Map([
    [null, {
      items: [post("p1", FROM)],
      nextCursor: "cursor-1",
      complete: false,
    }],
    ["cursor-1", {
      items: [post("p2", FROM + 1)],
      nextCursor: "cursor-1",
      complete: false,
    }],
  ]));
  const cache = new FakeXContentCache();
  const connector = new XConnector(client, cache, "space", 0);

  const error = await assertRejects(() =>
    connector.getRawData(FROM, TO, ["x:list:1001"])
  );

  assertStringIncludes(error.message, "repeated cursor");
  assertEquals(client.calls, [
    { op: "getListPostsPage", listId: "1001", from: FROM, to: TO, cursor: null },
    {
      op: "getListPostsPage",
      listId: "1001",
      from: FROM,
      to: TO,
      cursor: "cursor-1",
    },
  ]);
  const saved = cache.pendingRanges("x:list:1001", FROM, TO)[0];
  assertExists(saved);
  assertEquals(saved.nextCursor, "cursor-1");
  assertEquals(saved.pageCount, 2);
  assertEquals(saved.blockedReason, "repeated_cursor");
  assertEquals(
    cache.pageRecords.map((record) => record.blockedReason),
    [null, "repeated_cursor"],
    "the repeating page is recorded exactly once with its terminal reason",
  );
  assertEquals(
    cache.read("x:list:1001", FROM, TO).map((item) => item.externalId),
    ["p1", "p2"],
    "both paid pages stay durable",
  );
});

test("list pagination rejects cursor cycles after persisting each distinct page", async () => {
  const client = new FakeXApiClient();
  client.listPageResults.set("1001", new Map([
    [null, {
      items: [post("p1", FROM)],
      nextCursor: "a",
      complete: false,
    }],
    ["a", {
      items: [post("p2", FROM + 1)],
      nextCursor: "b",
      complete: false,
    }],
    ["b", {
      items: [post("p3", FROM + 2)],
      nextCursor: "a",
      complete: false,
    }],
  ]));
  const cache = new FakeXContentCache();
  const connector = new XConnector(client, cache, "space", 0);

  const error = await assertRejects(() =>
    connector.getRawData(FROM, TO, ["x:list:1001"])
  );

  assertStringIncludes(error.message, "repeated cursor");
  assertEquals(client.calls, [
    { op: "getListPostsPage", listId: "1001", from: FROM, to: TO, cursor: null },
    { op: "getListPostsPage", listId: "1001", from: FROM, to: TO, cursor: "a" },
    { op: "getListPostsPage", listId: "1001", from: FROM, to: TO, cursor: "b" },
  ]);
  const saved = cache.pendingRanges("x:list:1001", FROM, TO)[0];
  assertExists(saved);
  assertEquals(saved.nextCursor, "a");
  assertEquals(saved.pageCount, 3);
  assertEquals(saved.blockedReason, "repeated_cursor");
  assertEquals(
    cache.pageRecords.map((record) => record.blockedReason),
    [null, null, "repeated_cursor"],
    "the cycling page is recorded exactly once with its terminal reason",
  );
  assertEquals(
    cache.read("x:list:1001", FROM, TO).map((item) => item.externalId),
    ["p1", "p2", "p3"],
    "all three paid pages stay durable",
  );
});

test("a repeated-cursor page persists its block before an abort racing the response is propagated", async () => {
  const client = new FakeXApiClient();
  client.listPageResults.set("1001", new Map([
    ["cursor-1", {
      items: [post("p2", FROM + 1)],
      nextCursor: "cursor-1",
      complete: false,
    }],
  ]));
  client.resolveListPagesDespiteAbort = true;
  const cache = new FakeXContentCache();
  // The resumed cursor was already returned by the earlier page, so the
  // durable seen set contains it before this operation starts.
  cache.seedProgress("x:list:1001", {
    range: { from: FROM, to: TO },
    nextCursor: "cursor-1",
    pageCount: 1,
    updatedAt: 1,
    blockedReason: null,
    seenCursors: ["cursor-1"],
  });
  const connector = new XConnector(client, cache, "space", 0);
  const controller = new AbortController();

  const pending = connector.getRawData(
    FROM,
    TO,
    ["x:list:1001"],
    controller.signal,
  );
  controller.abort();

  const error = await assertRejects(() => pending);
  assert(error instanceof DOMException);
  assertEquals(error.name, "AbortError");
  const saved = cache.pendingRanges("x:list:1001", FROM, TO)[0];
  assertExists(saved, "the repeating page must be persisted before abort propagation");
  assertEquals(saved.blockedReason, "repeated_cursor");
  assertEquals(saved.nextCursor, "cursor-1");
  assertEquals(saved.pageCount, 2);
  assertEquals(
    cache.read("x:list:1001", FROM, TO).map((item) => item.externalId),
    ["p2"],
    "the paid page stays durable",
  );
  assertEquals(
    cache.pageRecords.map((record) => record.blockedReason),
    ["repeated_cursor"],
  );
  assertEquals(
    client.calls,
    [
      {
        op: "getListPostsPage",
        listId: "1001",
        from: FROM,
        to: TO,
        cursor: "cursor-1",
      },
    ],
    "an aborted operation must not issue a second request",
  );
});

test("cursor cycles are detected from durable state when every page comes from a fresh connector", async () => {
  const client = new FakeXApiClient();
  client.listPageResults.set("1001", new Map([
    [null, { items: [post("p1", FROM)], nextCursor: "a", complete: false }],
    ["a", { items: [post("p2", FROM + 1)], nextCursor: "b", complete: false }],
    ["b", { items: [post("p3", FROM + 2)], nextCursor: "a", complete: false }],
  ]));
  client.resolveListPagesDespiteAbort = true;
  const cache = new FakeXContentCache();

  // One page per operation: each operation is aborted while its page is in
  // flight, so the successful page is durably recorded and the abort
  // propagates before the next request. Every later operation uses a fresh
  // connector over the same persisted cache, so only durable state can catch
  // the cycle.
  for (const cursor of [null, "a", "b"]) {
    const connector = new XConnector(client, cache, "space", 0);
    const controller = new AbortController();
    const pending = connector.getRawData(
      FROM,
      TO,
      ["x:list:1001"],
      controller.signal,
    );
    controller.abort();
    const error = await assertRejects(() => pending);
    assert(error instanceof DOMException);
    assertEquals(error.name, "AbortError");
  }

  // The cycling page (b -> a) was recorded together with its terminal block.
  const saved = cache.pendingRanges("x:list:1001", FROM, TO)[0];
  assertExists(saved);
  assertEquals(saved.blockedReason, "repeated_cursor");
  assertEquals(saved.nextCursor, "a");
  assertEquals(saved.pageCount, 3);
  assertEquals(
    cache.read("x:list:1001", FROM, TO).map((item) => item.externalId),
    ["p1", "p2", "p3"],
    "every paid page stays durable across connector instances",
  );
  assertEquals(
    cache.pageRecords.map((record) => record.blockedReason),
    [null, null, "repeated_cursor"],
  );
  assertEquals(client.calls, [
    { op: "getListPostsPage", listId: "1001", from: FROM, to: TO, cursor: null },
    { op: "getListPostsPage", listId: "1001", from: FROM, to: TO, cursor: "a" },
    { op: "getListPostsPage", listId: "1001", from: FROM, to: TO, cursor: "b" },
  ]);

  // Every later connector fails locally on the persisted block with zero HTTP.
  let blockedMessage: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const fresh = new XConnector(client, cache, "space", 0);
    const error = await assertRejects(() =>
      fresh.getRawData(FROM, TO, ["x:list:1001"])
    );
    assertStringIncludes(error.message, "progress for this range is blocked");
    if (blockedMessage === undefined) blockedMessage = error.message;
    else assertStrictEquals(error.message, blockedMessage, "the block error is fixed");
  }
  assertEquals(client.calls, [
    { op: "getListPostsPage", listId: "1001", from: FROM, to: TO, cursor: null },
    { op: "getListPostsPage", listId: "1001", from: FROM, to: TO, cursor: "a" },
    { op: "getListPostsPage", listId: "1001", from: FROM, to: TO, cursor: "b" },
  ], "blocked progress must never purchase another page");
});

test("an incomplete list page without a resume cursor is recorded as a missing-cursor block before the local error", async () => {
  const client = new FakeXApiClient();
  client.listPageResults.set("1001", new Map([
    [null, {
      items: [post("p1", FROM)],
      nextCursor: null,
      complete: false,
    }],
  ]));
  const cache = new FakeXContentCache();
  const connector = new XConnector(client, cache, "space", 0);

  const error = await assertRejects(() =>
    connector.getRawData(FROM, TO, ["x:list:1001"])
  );

  assertStringIncludes(error.message, "incomplete without a resume cursor");
  const saved = cache.pendingRanges("x:list:1001", FROM, TO)[0];
  assertExists(saved);
  assertEquals(saved.nextCursor, null);
  assertEquals(saved.pageCount, 1);
  assertEquals(saved.blockedReason, "missing_cursor");
  assertEquals(
    cache.read("x:list:1001", FROM, TO).map((item) => item.externalId),
    ["p1"],
    "the paid page stays durable",
  );
  assertEquals(
    cache.pageRecords.map((record) => record.blockedReason),
    ["missing_cursor"],
    "the page is recorded exactly once with its terminal reason",
  );
  assertEquals(client.calls, [
    { op: "getListPostsPage", listId: "1001", from: FROM, to: TO, cursor: null },
  ]);

  // A later operation on a new connector over the same persisted state fails
  // locally on the block with zero provider calls.
  const fresh = new XConnector(client, cache, "space", 0);
  const retryError = await assertRejects(() =>
    fresh.getRawData(FROM, TO, ["x:list:1001"])
  );
  assertStringIncludes(retryError.message, "progress for this range is blocked");
  assertEquals(client.calls, [
    { op: "getListPostsPage", listId: "1001", from: FROM, to: TO, cursor: null },
  ], "blocked progress must never purchase another page");
});

test("an incomplete chat page without a resume cursor is recorded as a missing-cursor block before the local error", async () => {
  const client = new FakeXApiClient();
  client.chatPageResults.set("g1", new Map([
    [null, {
      items: [chatMessage("c1", FROM)],
      nextCursor: null,
      complete: false,
    }],
  ]));
  const cache = new FakeXContentCache();
  const connector = new XConnector(client, cache, "space", 0);

  const error = await assertRejects(() =>
    connector.getRawData(FROM, TO, ["x:chat:g1"])
  );

  assertStringIncludes(error.message, "incomplete without a resume cursor");
  const saved = cache.pendingRanges("x:chat:g1", FROM, TO)[0];
  assertExists(saved);
  assertEquals(saved.nextCursor, null);
  assertEquals(saved.pageCount, 1);
  assertEquals(saved.blockedReason, "missing_cursor");
  assertEquals(
    cache.read("x:chat:g1", FROM, TO).map((item) => item.externalId),
    ["c1"],
    "the paid page stays durable",
  );
  assertEquals(
    cache.pageRecords.map((record) => record.blockedReason),
    ["missing_cursor"],
  );
  assertEquals(client.calls, [
    {
      op: "getChatMessagesPage",
      conversationId: "g1",
      from: FROM,
      to: TO,
      cursor: null,
    },
  ]);

  const fresh = new XConnector(client, cache, "space", 0);
  const retryError = await assertRejects(() =>
    fresh.getRawData(FROM, TO, ["x:chat:g1"])
  );
  assertStringIncludes(retryError.message, "progress for this range is blocked");
  assertEquals(client.calls, [
    {
      op: "getChatMessagesPage",
      conversationId: "g1",
      from: FROM,
      to: TO,
      cursor: null,
    },
  ], "blocked progress must never purchase another page");
});

test("a mismatched-conversation terminal page is recorded as a block before the local error", async () => {
  const client = new FakeXApiClient();
  client.chatPageResults.set("g1", new Map([
    [null, {
      items: [chatMessage("wrong-conversation", FROM)],
      nextCursor: null,
      complete: false,
      terminalReason: "mismatched_conversation",
    }],
  ]));
  const cache = new FakeXContentCache();
  const connector = new XConnector(client, cache, "space", 0);

  const error = await assertRejects(() =>
    connector.getRawData(FROM, TO, ["x:chat:g1"])
  );

  assertStringIncludes(error.message, "different conversation");
  const saved = cache.pendingRanges("x:chat:g1", FROM, TO)[0];
  assertExists(saved);
  assertEquals(saved.nextCursor, null);
  assertEquals(saved.pageCount, 1);
  assertEquals(saved.blockedReason, "mismatched_conversation");
  assertEquals(
    cache.read("x:chat:g1", FROM, TO),
    [],
    "mismatched items are never kept",
  );
  assertEquals(
    cache.pageRecords.map((record) => record.blockedReason),
    ["mismatched_conversation"],
  );
  assertEquals(client.calls, [
    {
      op: "getChatMessagesPage",
      conversationId: "g1",
      from: FROM,
      to: TO,
      cursor: null,
    },
  ]);

  const fresh = new XConnector(client, cache, "space", 0);
  const retryError = await assertRejects(() =>
    fresh.getRawData(FROM, TO, ["x:chat:g1"])
  );
  assertStringIncludes(retryError.message, "progress for this range is blocked");
  assertEquals(client.calls, [
    {
      op: "getChatMessagesPage",
      conversationId: "g1",
      from: FROM,
      to: TO,
      cursor: null,
    },
  ], "blocked progress must never purchase another page");
});

test("chat safety limits use durable page counts before another request", async () => {
  const client = new FakeXApiClient();
  const cache = new FakeXContentCache();
  cache.seedProgress("x:chat:g1", {
    range: { from: FROM, to: TO },
    nextCursor: "before-2",
    pageCount: 2,
    updatedAt: 1,
    blockedReason: null,
  });
  const connector = new XConnector(client, cache, "space", 0);

  await assertRejects(
    () => connector.getRawData(FROM, TO, ["x:chat:g1"]),
    "safety page limit",
  );
  assertEquals(client.calls, []);
});

test("getRawData does not call the client for fully covered feeds", async () => {
  const cache = new FakeXContentCache();
  cache.seedCoverage("x:list:1001", { from: FROM, to: TO });
  cache.seedItems("x:list:1001", [post("cached", FROM)]);
  const client = new FakeXApiClient();
  const connector = new XConnector(client, cache, "space", 0);

  const raw = await connector.getRawData(FROM, TO, ["x:list:1001"]);

  assertEquals(client.calls, []);
  assertEquals(cache.records, []);
  assertEquals(raw["x:list:1001"].items, [post("cached", FROM)]);
});

test("a successful empty fetch establishes coverage for the whole gap", async () => {
  const client = new FakeXApiClient();
  const cache = new FakeXContentCache();
  const connector = new XConnector(client, cache, "space", 0);

  const first = await connector.getRawData(FROM, TO, ["x:list:1001", "x:chat:g1"]);

  assertEquals(first["x:list:1001"].items, []);
  assertEquals(first["x:chat:g1"].items, []);
  assertEquals(cache.records, [
    { feed: "x:list:1001", range: { from: FROM, to: TO }, items: [] },
    { feed: "x:chat:g1", range: { from: FROM, to: TO }, items: [] },
  ]);

  const second = await connector.getRawData(FROM, TO, ["x:list:1001", "x:chat:g1"]);

  assertEquals(second["x:list:1001"].items, []);
  assertEquals(second["x:chat:g1"].items, []);
  assertEquals(client.calls, [
    { op: "getListPostsPage", listId: "1001", from: FROM, to: TO, cursor: null },
    { op: "getChatMessagesPage", conversationId: "g1", from: FROM, to: TO, cursor: null },
  ], "covered feeds must not be refetched");
});

test("getNormalizedData keeps the inclusive window and normalizes posts and chats", async () => {
  const reactions = [
    { emoji: "like", count: 2, reactedByViewer: false },
    { emoji: "party", count: 3, reactedByViewer: true },
  ];
  const client = new FakeXApiClient();
  client.chatMessages.set("team-chat", [
    chatMessage("chat-before", FROM - 1),
    chatMessage("chat-at-start", FROM, reactions),
    chatMessage("chat-at-end", TO),
    chatMessage("chat-after", TO + 1),
  ]);
  client.listPosts.set("1001", [
    post("post-before", FROM - 1),
    post("post-at-start", FROM, {
      replyCount: 0,
      repostCount: 2,
      likeCount: 3,
      viewCount: 4,
    }),
    post("post-at-end", TO),
    post("post-after", TO + 1),
  ]);
  const connector = new XConnector(client, new FakeXContentCache(), "space", 0);

  const result = await connector.getNormalizedData(FROM, TO, [
    "x:chat:team-chat",
    "x:list:1001",
  ]);

  assertEquals(result, {
    "x:chat:team-chat": [
      {
        connectorId: ConnectorId.X,
        feedExternalId: "x:chat:team-chat",
        externalId: "chat-at-start",
        date: FROM,
        title: null,
        text: "chat chat-at-start",
        author: "Chat Author",
        url: "https://x.com/i/chat/team-chat",
        meta: {
          messageKind: "chat",
          reactions,
          reactionCount: 5,
          reactedByViewer: true,
        },
      },
      {
        connectorId: ConnectorId.X,
        feedExternalId: "x:chat:team-chat",
        externalId: "chat-at-end",
        date: TO,
        title: null,
        text: "chat chat-at-end",
        author: "Chat Author",
        url: "https://x.com/i/chat/team-chat",
        meta: {
          messageKind: "chat",
          reactions: [],
          reactionCount: 0,
          reactedByViewer: false,
        },
      },
    ],
    "x:list:1001": [
      {
        connectorId: ConnectorId.X,
        feedExternalId: "x:list:1001",
        externalId: "post-at-start",
        date: FROM,
        title: null,
        text: "post post-at-start",
        author: "Post Author",
        url: "https://x.com/post-author/status/post-at-start",
        meta: {
          messageKind: "post",
          metrics: {
            replies: 0,
            reposts: 2,
            likes: 3,
            views: 4,
          },
        },
      },
      {
        connectorId: ConnectorId.X,
        feedExternalId: "x:list:1001",
        externalId: "post-at-end",
        date: TO,
        title: null,
        text: "post post-at-end",
        author: "Post Author",
        url: "https://x.com/post-author/status/post-at-end",
        meta: {
          messageKind: "post",
        },
      },
    ],
  });
});

test("items come back deduplicated in stable date-then-external-id order", async () => {
  const client = new FakeXApiClient();
  client.listPosts.set("1001", [
    post("b", FROM + 2),
    post("dup", FROM),
    post("a", FROM + 2),
    post("dup", FROM),
  ]);
  const connector = new XConnector(client, new FakeXContentCache(), "space", 0);

  const raw = await connector.getRawData(FROM, TO, ["x:list:1001"]);
  assertEquals(raw["x:list:1001"].items.map((item) => item.externalId), ["dup", "a", "b"]);

  const normalized = await connector.getNormalizedData(FROM, TO, ["x:list:1001"]);
  assertEquals(
    normalized["x:list:1001"].map((item) => item.externalId),
    ["dup", "a", "b"],
  );
});

test("getRawData propagates a pre-aborted signal without calling the client", async () => {
  const controller = new AbortController();
  controller.abort();
  const client = new FakeXApiClient();
  const connector = new XConnector(client, new FakeXContentCache(), "space", 0);

  const error = await assertRejects(() =>
    connector.getRawData(FROM, TO, ["x:list:1001"], controller.signal)
  );

  assert(error instanceof DOMException);
  assertEquals(error.name, "AbortError");
  assertEquals(client.calls, []);
});

test("getRawData aborts in-flight client work when the signal aborts", async () => {
  const controller = new AbortController();
  const client = new FakeXApiClient();
  const connector = new XConnector(client, new FakeXContentCache(), "space", 0);

  const pending = connector.getRawData(FROM, TO, ["x:list:1001"], controller.signal);
  controller.abort();

  const error = await assertRejects(() => pending);
  assert(error instanceof DOMException);
  assertEquals(error.name, "AbortError");
});

test("dispose aborts in-flight work and permanently disables the connector", async () => {
  const client = new FakeXApiClient();
  client.holdListPosts = true;
  const connector = new XConnector(client, new FakeXContentCache(), "space", 0);

  const pending = connector.getRawData(FROM, TO, ["x:list:1001"]);
  pending.catch(() => {}); // observed by assertRejects below; keeps Bun's handler quiet
  await connector.dispose();

  const error = await assertRejects(() => pending);
  assert(error instanceof DOMException);
  assertEquals(error.name, "AbortError");

  await assertRejects(
    () => connector.getRawData(FROM, TO, ["x:list:1001"]),
    "X connector has been disposed",
  );
  await assertRejects(
    () => connector.listAvailableFeeds(),
    "X connector has been disposed",
  );

  await connector.dispose(); // idempotent
  assertEquals(client.calls, [
    { op: "getListPostsPage", listId: "1001", from: FROM, to: TO, cursor: null },
  ]);
});

test("a failed list discovery drains its held conversation sibling before listAvailableFeeds and dispose settle", async () => {
  const original = new Error("list search exploded");
  const client = new FakeXApiClient();
  client.searchListsFailure = original;
  client.holdConversations = true;
  const connector = new XConnector(client, new FakeXContentCache(), "space", 0);

  const order: string[] = [];
  let disposal: Promise<void> | undefined;
  // Dispose at the exact moment the held sibling settles: both the tracked
  // operation and dispose must still wait for the sibling's cleanup first.
  client.onDiscoverySettled = () => {
    order.push("sibling");
    disposal = connector.dispose();
    void disposal.then(() => order.push("dispose"));
  };

  const feeds = connector.listAvailableFeeds();
  const error = await assertRejects(() => feeds);
  order.push("feeds");

  assertStrictEquals(error, original, "the original failure must remain observable");
  assertStrictEquals(
    client.conversationsAbortReason,
    original,
    "the sibling must be aborted with the failure's reason",
  );
  assertExists(disposal);
  await disposal;
  assertStrictEquals(
    order[0],
    "sibling",
    "neither listAvailableFeeds nor dispose may settle before the sibling",
  );
  assert(
    order.includes("feeds") && order.includes("dispose"),
    "both listAvailableFeeds and dispose must settle",
  );
});

test("a failed conversation discovery drains its held list sibling and keeps the original failure", async () => {
  const original = new Error("conversations exploded");
  const client = new FakeXApiClient();
  client.conversationsFailure = original;
  client.holdSearchLists = true;
  const connector = new XConnector(client, new FakeXContentCache(), "space", 0);

  const error = await assertRejects(() => connector.listAvailableFeeds());

  assertStrictEquals(error, original, "the original failure must remain observable");
  assertStrictEquals(
    client.searchListsAbortReason,
    original,
    "the held list search must be aborted with the failure's reason",
  );
  assert(
    client.searchListsSettled,
    "the held list search must settle before listAvailableFeeds settles",
  );
});

test("a client failure rejects the whole batch and leaves no coverage for the failed feed", async () => {
  const client = new FakeXApiClient();
  client.listPosts.set("1001", [post("ok", FROM)]);
  client.chatMessagesFailure = new Error("upstream exploded");
  const cache = new FakeXContentCache();
  const connector = new XConnector(client, cache, "space", 0);

  const error = await assertRejects(() =>
    connector.getRawData(FROM, TO, ["x:list:1001", "x:chat:g1"])
  );

  assertStringIncludes(error.message, "upstream exploded");
  assertEquals(cache.records.map((record) => record.feed), ["x:list:1001"]);
});

test("an empty explicit feed selection returns no data and calls no upstream", async () => {
  const client = new FakeXApiClient();
  const connector = new XConnector(client, new FakeXContentCache(), "space", 0);

  const raw = await connector.getRawData(FROM, TO, []);

  assertEquals(raw, {});
  assertEquals(client.calls, []);
});

test("explicit targets must be canonical x:list or x:chat ids", async () => {
  const connector = new XConnector(
    new FakeXApiClient(),
    new FakeXContentCache(),
    "space",
    0,
  );

  for (const invalid of [
    "x:following",
    "x:list:abc",
    "x:list:0",
    "x:chat:bad id!",
    "x:chat:",
  ]) {
    await assertRejects(
      () => connector.getRawData(FROM, TO, [invalid]),
      "must be x:list:<numeric-id> or x:chat:<conversation-id>",
      `feed id ${JSON.stringify(invalid)} must be rejected`,
    );
  }
});

test("duplicate explicit targets are collected once", async () => {
  const client = new FakeXApiClient();
  client.listPosts.set("1001", [post("p1", FROM)]);
  const connector = new XConnector(client, new FakeXContentCache(), "space", 0);

  const raw = await connector.getRawData(FROM, TO, ["x:list:1001", "x:list:1001"]);

  assertEquals(client.calls, [
    { op: "getListPostsPage", listId: "1001", from: FROM, to: TO, cursor: null },
  ]);
  assertEquals(Object.keys(raw), ["x:list:1001"]);
});

test("explicit batches above 250 feeds are rejected", async () => {
  const many = Array.from({ length: 251 }, (_, index) => `x:list:${1000 + index}`);
  const connector = new XConnector(
    new FakeXApiClient(),
    new FakeXContentCache(),
    "space",
    0,
  );

  await assertRejects(
    () => connector.getRawData(FROM, TO, many),
    "limited to 250 feeds per batch",
  );
});

test("discovery above 250 feeds is rejected", async () => {
  const client = new FakeXApiClient();
  client.conversations = Array.from({ length: 251 }, (_, index) =>
    conversationData(`g${index}`, "group", ["u1", "u2"])
  );
  const connector = new XConnector(client, new FakeXContentCache(), "space", 0);

  await assertRejects(
    () => connector.getRawData(FROM, TO),
    "limited to 250 feeds per batch",
  );
});

test("getRawData validates the window", async () => {
  const connector = new XConnector(
    new FakeXApiClient(),
    new FakeXContentCache(),
    "space",
    0,
  );

  await assertRejects(
    () => connector.getRawData(TO, FROM, ["x:list:1001"]),
    "start must not exceed its end",
  );
  await assertRejects(
    () => connector.getRawData(Number.NaN, TO, ["x:list:1001"]),
    "finite epoch milliseconds",
  );
});

test("a successful incomplete list page is persisted before an abort racing the response is propagated", async () => {
  const client = new FakeXApiClient();
  client.listPageResults.set("1001", new Map([
    [null, {
      items: [post("p1", FROM)],
      nextCursor: "cursor-1",
      complete: false,
    }],
  ]));
  client.resolveListPagesDespiteAbort = true;
  const cache = new FakeXContentCache();
  const connector = new XConnector(client, cache, "space", 0);
  const controller = new AbortController();

  const pending = connector.getRawData(
    FROM,
    TO,
    ["x:list:1001"],
    controller.signal,
  );
  controller.abort();

  const error = await assertRejects(() => pending);
  assert(error instanceof DOMException);
  assertEquals(error.name, "AbortError");
  const saved = cache.pendingRanges("x:list:1001", FROM, TO)[0];
  assertExists(saved, "the successful page must be persisted before abort propagation");
  assertEquals(saved.nextCursor, "cursor-1");
  assertEquals(saved.pageCount, 1);
  assertEquals(
    cache.read("x:list:1001", FROM, TO).map((item) => item.externalId),
    ["p1"],
  );
  assertEquals(
    client.calls,
    [
      { op: "getListPostsPage", listId: "1001", from: FROM, to: TO, cursor: null },
    ],
    "an aborted operation must not issue a second request",
  );
});

test("a successful incomplete chat page is persisted before an abort racing the response is propagated", async () => {
  const client = new FakeXApiClient();
  client.chatPageResults.set("g1", new Map([
    [null, {
      items: [chatMessage("c1", FROM)],
      nextCursor: "before-1",
      complete: false,
    }],
  ]));
  client.resolveChatPagesDespiteAbort = true;
  const cache = new FakeXContentCache();
  const connector = new XConnector(client, cache, "space", 0);
  const controller = new AbortController();

  const pending = connector.getRawData(
    FROM,
    TO,
    ["x:chat:g1"],
    controller.signal,
  );
  controller.abort();

  const error = await assertRejects(() => pending);
  assert(error instanceof DOMException);
  assertEquals(error.name, "AbortError");
  const saved = cache.pendingRanges("x:chat:g1", FROM, TO)[0];
  assertExists(saved, "the successful page must be persisted before abort propagation");
  assertEquals(saved.nextCursor, "before-1");
  assertEquals(saved.pageCount, 1);
  assertEquals(
    cache.read("x:chat:g1", FROM, TO).map((item) => item.externalId),
    ["c1"],
  );
  assertEquals(
    client.calls,
    [
      {
        op: "getChatMessagesPage",
        conversationId: "g1",
        from: FROM,
        to: TO,
        cursor: null,
      },
    ],
    "an aborted operation must not issue a second request",
  );
});

test("a complete page's coverage and items are persisted before an abort racing the response is propagated", async () => {
  const client = new FakeXApiClient();
  client.listPosts.set("1001", [post("p1", FROM)]);
  client.resolveListPagesDespiteAbort = true;
  const cache = new FakeXContentCache();
  const connector = new XConnector(client, cache, "space", 0);
  const controller = new AbortController();

  const pending = connector.getRawData(
    FROM,
    TO,
    ["x:list:1001"],
    controller.signal,
  );
  controller.abort();

  const error = await assertRejects(() => pending);
  assert(error instanceof DOMException);
  assertEquals(error.name, "AbortError");
  assertEquals(cache.records, [
    { feed: "x:list:1001", range: { from: FROM, to: TO }, items: [post("p1", FROM)] },
  ]);
  assertEquals(cache.missingRanges("x:list:1001", FROM, TO), []);
  assertEquals(
    client.calls,
    [
      { op: "getListPostsPage", listId: "1001", from: FROM, to: TO, cursor: null },
    ],
    "an aborted operation must not issue a second request",
  );
});

test("cache coverage tolerance suppresses exactly-tolerance edge slivers with zero provider calls for list and chat", async () => {
  const client = new FakeXApiClient();
  const cache = new FakeXContentCache();
  for (const feed of ["x:list:1001", "x:chat:g1"]) {
    cache.seedCoverage(feed, { from: TOL_COVER_FROM, to: TOL_COVER_TO });
  }
  cache.seedItems("x:list:1001", [
    post("cached-head", TOL_COVER_FROM),
    post("cached-tail", TOL_COVER_TO),
  ]);
  cache.seedItems("x:chat:g1", [
    chatMessage("cached-head", TOL_COVER_FROM),
    chatMessage("cached-tail", TOL_COVER_TO),
  ]);
  const connector = new XConnector(client, cache, "space", TOLERANCE_MS);

  const raw = await connector.getRawData(TOL_FROM, TOL_TO, [
    "x:list:1001",
    "x:chat:g1",
  ]);

  assertEquals(client.calls, [], "tolerated edge slivers must not be fetched");
  assertEquals(cache.records, [], "tolerance must not write coverage");
  assertEquals(
    raw["x:list:1001"].items.map((item) => item.externalId),
    ["cached-head", "cached-tail"],
  );
  assertEquals(
    raw["x:chat:g1"].items.map((item) => item.externalId),
    ["cached-head", "cached-tail"],
  );
  assertEquals(
    cache.missingRanges("x:list:1001", TOL_FROM, TOL_TO),
    [
      { from: TOL_FROM, to: TOL_COVER_FROM - 1 },
      { from: TOL_COVER_TO + 1, to: TOL_TO },
    ],
    "tolerance must not alter persisted coverage truth",
  );
});

test("cached results are filtered to the requested window while edge items stay persisted", async () => {
  const client = new FakeXApiClient();
  const cache = new FakeXContentCache();
  cache.seedCoverage("x:list:1001", { from: TOL_COVER_FROM, to: TOL_COVER_TO });
  cache.seedItems("x:list:1001", [
    post("outside-before", TOL_FROM - 1),
    post("in-sliver", TOL_COVER_FROM - 1),
    post("inside", TOL_COVER_FROM),
    post("outside-after", TOL_TO + 1),
  ]);
  const connector = new XConnector(client, cache, "space", TOLERANCE_MS);

  const raw = await connector.getRawData(TOL_FROM, TOL_TO, ["x:list:1001"]);

  assertEquals(client.calls, []);
  assertEquals(
    raw["x:list:1001"].items.map((item) => item.externalId),
    ["in-sliver", "inside"],
  );
  assertEquals(
    cache.storedItems.get("x:list:1001")?.map((item) => item.externalId).sort(),
    ["in-sliver", "inside", "outside-after", "outside-before"],
    "items outside the window remain persisted",
  );
});

test("cache coverage tolerance fetches an edge sliver one millisecond over the tolerance", async () => {
  const client = new FakeXApiClient();
  client.listPosts.set("1001", [post("head", TOL_FROM - 1)]);
  const cache = new FakeXContentCache();
  cache.seedCoverage("x:list:1001", { from: TOL_COVER_FROM, to: TOL_COVER_TO });
  const connector = new XConnector(client, cache, "space", TOLERANCE_MS);

  // The head sliver is exactly tolerance+1ms long; the tail sliver stays
  // exactly at the tolerance and is still suppressed.
  const raw = await connector.getRawData(TOL_FROM - 1, TOL_TO, ["x:list:1001"]);

  assertEquals(client.calls, [
    {
      op: "getListPostsPage",
      listId: "1001",
      from: TOL_FROM - 1,
      to: TOL_COVER_FROM - 1,
      cursor: null,
    },
  ]);
  assertEquals(cache.records, [
    {
      feed: "x:list:1001",
      range: { from: TOL_FROM - 1, to: TOL_COVER_FROM - 1 },
      items: [post("head", TOL_FROM - 1)],
    },
  ]);
  assertEquals(
    raw["x:list:1001"].items.map((item) => item.externalId),
    ["head"],
  );
});

test("cache coverage tolerance never suppresses an internal gap even when shorter than the tolerance", async () => {
  const client = new FakeXApiClient();
  client.listPosts.set("1001", [post("internal", TOL_BASE + 15 * TOLERANCE_MS + 1)]);
  const cache = new FakeXContentCache();
  cache.seedCoverage("x:list:1001", {
    from: TOL_COVER_FROM,
    to: TOL_BASE + 15 * TOLERANCE_MS,
  });
  cache.seedCoverage("x:list:1001", {
    from: TOL_BASE + 15 * TOLERANCE_MS + 2,
    to: TOL_COVER_TO,
  });
  const connector = new XConnector(client, cache, "space", TOLERANCE_MS);

  const raw = await connector.getRawData(TOL_FROM, TOL_TO, ["x:list:1001"]);

  // A 1ms internal gap (well under the tolerance) is fetched while both
  // exactly-tolerance edge slivers are suppressed.
  assertEquals(client.calls, [
    {
      op: "getListPostsPage",
      listId: "1001",
      from: TOL_BASE + 15 * TOLERANCE_MS + 1,
      to: TOL_BASE + 15 * TOLERANCE_MS + 1,
      cursor: null,
    },
  ]);
  assertEquals(
    raw["x:list:1001"].items.map((item) => item.externalId),
    ["internal"],
  );
});

test("cache coverage tolerance never suppresses a wholly uncovered window shorter than the tolerance", async () => {
  const client = new FakeXApiClient();
  client.listPosts.set("1001", [post("only", TOL_FROM)]);
  const cache = new FakeXContentCache();
  const connector = new XConnector(client, cache, "space", TOLERANCE_MS);

  // The whole window's inclusive duration equals the tolerance and nothing
  // inside it is covered, so it must still be fetched.
  const shortTo = TOL_FROM + TOLERANCE_MS - 1;
  const raw = await connector.getRawData(TOL_FROM, shortTo, ["x:list:1001"]);

  assertEquals(client.calls, [
    {
      op: "getListPostsPage",
      listId: "1001",
      from: TOL_FROM,
      to: shortTo,
      cursor: null,
    },
  ]);
  assertEquals(
    raw["x:list:1001"].items.map((item) => item.externalId),
    ["only"],
  );
});

test("cache coverage tolerance of zero disables edge sliver suppression", async () => {
  const client = new FakeXApiClient();
  client.listPosts.set("1001", [
    post("head", TOL_COVER_FROM - 1),
    post("tail", TOL_COVER_TO + 1),
  ]);
  const cache = new FakeXContentCache();
  cache.seedCoverage("x:list:1001", { from: TOL_COVER_FROM, to: TOL_COVER_TO });
  const connector = new XConnector(client, cache, "space", 0);

  const raw = await connector.getRawData(TOL_FROM, TOL_TO, ["x:list:1001"]);

  assertEquals(client.calls, [
    {
      op: "getListPostsPage",
      listId: "1001",
      from: TOL_FROM,
      to: TOL_COVER_FROM - 1,
      cursor: null,
    },
    {
      op: "getListPostsPage",
      listId: "1001",
      from: TOL_COVER_TO + 1,
      to: TOL_TO,
      cursor: null,
    },
  ]);
  assertEquals(
    raw["x:list:1001"].items.map((item) => item.externalId),
    ["head", "tail"],
  );
});

test("pending progress wholly inside a tolerated edge sliver does not force a provider call", async () => {
  const client = new FakeXApiClient();
  const cache = new FakeXContentCache();
  for (const feed of ["x:list:1001", "x:chat:g1"]) {
    cache.seedCoverage(feed, { from: TOL_COVER_FROM, to: TOL_COVER_TO });
    cache.seedItems(feed, [post("cached", TOL_COVER_FROM)]);
    cache.seedProgress(feed, {
      range: {
        from: TOL_FROM + 1,
        to: TOL_FROM + TOLERANCE_MS - 1,
      },
      nextCursor: `sliver-${feed}`,
      pageCount: 1,
      updatedAt: 1,
      blockedReason: null,
    });
  }
  const connector = new XConnector(client, cache, "space", TOLERANCE_MS);

  const raw = await connector.getRawData(TOL_FROM, TOL_TO, [
    "x:list:1001",
    "x:chat:g1",
  ]);

  assertEquals(client.calls, [], "tolerated pending progress must not be resumed");
  assertEquals(cache.records, []);
  assertEquals(
    raw["x:list:1001"].items.map((item) => item.externalId),
    ["cached"],
  );
  assertEquals(
    cache.pendingRanges("x:list:1001", TOL_FROM, TOL_TO).length,
    1,
    "the pending row survives untouched for a later wider request",
  );
  assertEquals(cache.pendingRanges("x:chat:g1", TOL_FROM, TOL_TO).length, 1);
});

test("pending progress overlapping a real missing gap still resumes", async () => {
  const client = new FakeXApiClient();
  client.listPageResults.set("1001", new Map([
    ["sliver-cursor", {
      items: [post("p1", TOL_BASE + 12 * TOLERANCE_MS)],
      nextCursor: null,
      complete: true,
    }],
  ]));
  const cache = new FakeXContentCache();
  // Coverage runs through 14:40 and resumes at 14:50:00.001; the pending
  // range reaches through that real internal gap, so tolerance cannot skip
  // its resume.
  cache.seedCoverage("x:list:1001", {
    from: TOL_COVER_FROM,
    to: TOL_BASE + 11 * TOLERANCE_MS,
  });
  cache.seedCoverage("x:list:1001", {
    from: TOL_BASE + 12 * TOLERANCE_MS + 1,
    to: TOL_TO,
  });
  cache.seedProgress("x:list:1001", {
    range: {
      from: TOL_FROM + TOLERANCE_MS,
      to: TOL_BASE + 12 * TOLERANCE_MS,
    },
    nextCursor: "sliver-cursor",
    pageCount: 1,
    updatedAt: 1,
    blockedReason: null,
  });
  const connector = new XConnector(client, cache, "space", TOLERANCE_MS);

  const raw = await connector.getRawData(TOL_FROM, TOL_TO, ["x:list:1001"]);

  assertEquals(client.calls, [
    {
      op: "getListPostsPage",
      listId: "1001",
      from: TOL_FROM + TOLERANCE_MS,
      to: TOL_BASE + 12 * TOLERANCE_MS,
      cursor: "sliver-cursor",
    },
  ]);
  assertEquals(
    raw["x:list:1001"].items.map((item) => item.externalId),
    ["p1"],
  );
});

test("wider pending progress outside a fully covered digest makes zero provider calls", async () => {
  const client = new FakeXApiClient();
  const cache = new FakeXContentCache();
  cache.seedCoverage("x:list:1001", { from: TOL_COVER_FROM, to: TOL_COVER_TO });
  cache.seedItems("x:list:1001", [post("cached", TOL_COVER_FROM)]);
  // Pending spans 12:00-20:00; the digest requests exactly the covered
  // 13:00-19:00 window, so its outside-window gaps must not force a call.
  cache.seedProgress("x:list:1001", {
    range: {
      from: WIDE_PENDING_FROM,
      to: WIDE_PENDING_TO,
    },
    nextCursor: "wide-1",
    pageCount: 1,
    updatedAt: 1,
    blockedReason: null,
  });
  const connector = new XConnector(client, cache, "space", TOLERANCE_MS);

  const raw = await connector.getRawData(
    TOL_COVER_FROM,
    TOL_COVER_TO,
    ["x:list:1001"],
  );

  assertEquals(client.calls, []);
  assertEquals(
    raw["x:list:1001"].items.map((item) => item.externalId),
    ["cached"],
  );
  assertEquals(
    cache.pendingRanges("x:list:1001", TOL_COVER_FROM, TOL_COVER_TO).length,
    1,
    "the wider pending row survives untouched",
  );
});

test("wider pending progress never forces calls when only tolerated slivers are missing", async () => {
  const client = new FakeXApiClient();
  const cache = new FakeXContentCache();
  for (const feed of ["x:list:1001", "x:chat:g1"]) {
    cache.seedCoverage(feed, { from: TOL_COVER_FROM, to: TOL_COVER_TO });
    cache.seedItems(feed, [post("cached", TOL_COVER_FROM)]);
    // Pending spans 12:00-20:00, wider than the 12:50-19:10 digest; both
    // in-window slivers are exactly at the tolerance and suppressed.
    cache.seedProgress(feed, {
      range: {
        from: WIDE_PENDING_FROM,
        to: WIDE_PENDING_TO,
      },
      nextCursor: `wide-${feed}`,
      pageCount: 1,
      updatedAt: 1,
      blockedReason: null,
    });
  }
  const connector = new XConnector(client, cache, "space", TOLERANCE_MS);

  const raw = await connector.getRawData(TOL_FROM, TOL_TO, [
    "x:list:1001",
    "x:chat:g1",
  ]);

  assertEquals(client.calls, [], "outside-window gaps must never force calls");
  assertEquals(
    raw["x:list:1001"].items.map((item) => item.externalId),
    ["cached"],
  );
  assertEquals(cache.pendingRanges("x:list:1001", TOL_FROM, TOL_TO).length, 1);
  assertEquals(cache.pendingRanges("x:chat:g1", TOL_FROM, TOL_TO).length, 1);
});

test("a pre-existing blocked pending range overlapping a required gap fails locally before HTTP", async () => {
  const client = new FakeXApiClient();
  const cache = new FakeXContentCache();
  // Coverage on both sides of a real 1ms internal gap at MID; the blocked
  // pending range reaches through the gap, so tolerance cannot skip it.
  cache.seedCoverage("x:list:1001", { from: FROM, to: MID - 1 });
  cache.seedCoverage("x:list:1001", { from: MID + 1, to: TO });
  cache.seedItems("x:list:1001", [
    post("cached-left", FROM),
    post("cached-right", TO),
  ]);
  cache.seedProgress("x:list:1001", {
    range: { from: FROM, to: TO },
    nextCursor: "stuck-cursor",
    pageCount: 3,
    updatedAt: 1,
    blockedReason: "repeated_cursor",
  });
  const connector = new XConnector(client, cache, "space", TOLERANCE_MS);

  const error = await assertRejects(() =>
    connector.getRawData(FROM, TO, ["x:list:1001"])
  );

  assertStringIncludes(error.message, "progress for this range is blocked");
  assert(
    !error.message.includes("stuck-cursor"),
    "the fixed error must not echo the persisted cursor",
  );
  assertEquals(
    client.calls,
    [],
    "blocked progress must fail before any provider request",
  );
  assertEquals(
    cache.read("x:list:1001", FROM, TO).map((item) => item.externalId),
    ["cached-left", "cached-right"],
    "cached items stay served",
  );
});

test("a blocked pending row fails locally before an earlier resumable row is purchased", async () => {
  const client = new FakeXApiClient();
  const cache = new FakeXContentCache();
  // Both rows intersect the window's only required gap; the earlier row is
  // resumable, but the later one is terminally blocked. The pre-scan must
  // fail locally before ANY provider request, so the resumable row is never
  // purchased first.
  cache.seedProgress("x:list:1001", {
    range: { from: FROM, to: MID },
    nextCursor: "resume-1",
    pageCount: 1,
    updatedAt: 1,
    blockedReason: null,
  });
  cache.seedProgress("x:list:1001", {
    range: { from: MID + 1, to: TO },
    nextCursor: "blocked-cursor",
    pageCount: 2,
    updatedAt: 1,
    blockedReason: "repeated_cursor",
  });
  const connector = new XConnector(client, cache, "space", 0);

  const error = await assertRejects(() =>
    connector.getRawData(FROM, TO, ["x:list:1001"])
  );

  assertStringIncludes(error.message, "progress for this range is blocked");
  assertEquals(
    client.calls,
    [],
    "the block must fail before the resumable row's provider request",
  );
  assertEquals(
    cache.pendingRanges("x:list:1001", FROM, TO).length,
    2,
    "both rows survive untouched",
  );
});

test("blocked wider pending progress under a fully covered digest makes zero provider calls", async () => {
  const client = new FakeXApiClient();
  const cache = new FakeXContentCache();
  cache.seedCoverage("x:list:1001", { from: TOL_COVER_FROM, to: TOL_COVER_TO });
  cache.seedItems("x:list:1001", [post("cached", TOL_COVER_FROM)]);
  // The blocked row spans 12:00-20:00, far wider than the fully covered
  // 13:00-19:00 digest; it intersects no required gap of this window, so the
  // block must not fail or force a call regardless of its reason.
  cache.seedProgress("x:list:1001", {
    range: { from: WIDE_PENDING_FROM, to: WIDE_PENDING_TO },
    nextCursor: "wide-blocked",
    pageCount: 4,
    updatedAt: 1,
    blockedReason: "missing_cursor",
  });
  const connector = new XConnector(client, cache, "space", TOLERANCE_MS);

  const raw = await connector.getRawData(
    TOL_COVER_FROM,
    TOL_COVER_TO,
    ["x:list:1001"],
  );

  assertEquals(client.calls, [], "irrelevant blocked progress must not force calls");
  assertEquals(
    raw["x:list:1001"].items.map((item) => item.externalId),
    ["cached"],
  );
  const saved = cache.pendingRanges("x:list:1001", TOL_COVER_FROM, TOL_COVER_TO)[0];
  assertExists(saved);
  assertEquals(
    saved.blockedReason,
    "missing_cursor",
    "the blocked row survives untouched",
  );
});

test("blocked wider pending progress never fails or calls when only tolerated slivers are missing", async () => {
  const client = new FakeXApiClient();
  const cache = new FakeXContentCache();
  cache.seedCoverage("x:chat:g1", { from: TOL_COVER_FROM, to: TOL_COVER_TO });
  cache.seedItems("x:chat:g1", [chatMessage("cached", TOL_COVER_FROM)]);
  // Both in-window slivers are exactly at the tolerance and suppressed, so
  // the blocked wide pending row is irrelevant to this digest: no failure,
  // no provider call, regardless of its reason.
  cache.seedProgress("x:chat:g1", {
    range: { from: WIDE_PENDING_FROM, to: WIDE_PENDING_TO },
    nextCursor: "wide-blocked-chat",
    pageCount: 2,
    updatedAt: 1,
    blockedReason: "mismatched_conversation",
  });
  const connector = new XConnector(client, cache, "space", TOLERANCE_MS);

  const raw = await connector.getRawData(TOL_FROM, TOL_TO, ["x:chat:g1"]);

  assertEquals(
    client.calls,
    [],
    "tolerated slivers must not trigger the blocked-range failure",
  );
  assertEquals(
    raw["x:chat:g1"].items.map((item) => item.externalId),
    ["cached"],
  );
  assertEquals(
    cache.pendingRanges("x:chat:g1", TOL_FROM, TOL_TO).length,
    1,
    "the blocked row survives untouched",
  );
});
