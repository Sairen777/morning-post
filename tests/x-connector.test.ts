import { test } from "bun:test";

import {
  abortReason,
  throwIfAborted,
} from "../src/connectors/x/abort.ts";
import type { XApiClient } from "../src/connectors/x/twex-api-client.ts";
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
const TO = 1_700_000_010_000;
const MID = FROM + 5_000;

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
  public readonly coverage = new Map<string, XTimeRange[]>();
  public readonly storedItems = new Map<string, XRawItem[]>();
  public readonly records: Array<{ feed: string; range: XTimeRange; items: XRawItem[] }> = [];
  public clearCount = 0;

  public seedCoverage(feed: string, range: XTimeRange): void {
    const ranges = this.coverage.get(feed) ?? [];
    ranges.push({ ...range });
    this.coverage.set(feed, ranges);
  }

  public seedItems(feed: string, items: XRawItem[]): void {
    const existing = this.storedItems.get(feed) ?? [];
    existing.push(...items);
    this.storedItems.set(feed, existing);
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

  public record(feed: string, range: XTimeRange, items: XRawItem[]): void {
    this.records.push({ feed, range: { ...range }, items: [...items] });
    this.seedCoverage(feed, range);
    this.seedItems(feed, items);
  }

  public clear(): void {
    this.clearCount += 1;
    this.coverage.clear();
    this.storedItems.clear();
  }
}

type FakeClientCall = {
  op: "searchLists" | "getConversations" | "getListPosts" | "getChatMessages";
  query?: string;
  targetCount?: number;
  listId?: string;
  conversationId?: string;
  from?: number;
  to?: number;
};

/** Deterministic {@link XApiClient} that honors abort signals and records
 * every call; content is seeded per list/conversation id. */
class FakeXApiClient implements XApiClient {
  public lists: TwexList[] = [];
  public conversations: TwexConversation[] = [];
  public readonly listPosts = new Map<string, XRawPost[]>();
  public readonly chatMessages = new Map<string, XRawChatMessage[]>();
  public readonly calls: FakeClientCall[] = [];
  public listPostsFailure: Error | undefined;
  public chatMessagesFailure: Error | undefined;
  public holdListPosts = false;
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

  public getListPosts(
    listId: string,
    from: number,
    to: number,
    signal?: AbortSignal,
  ): Promise<XRawPost[]> {
    this.calls.push({ op: "getListPosts", listId, from, to });
    if (this.listPostsFailure !== undefined) {
      return Promise.reject(this.listPostsFailure);
    }
    return new Promise<XRawPost[]>((resolve, reject) => {
      const release = () => {
        if (!signal?.aborted) resolve(this.listPosts.get(listId) ?? []);
      };
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }
      signal?.addEventListener("abort", () => reject(abortReason(signal)), { once: true });
      if (!this.holdListPosts) queueMicrotask(release);
    });
  }

  public getChatMessages(
    conversationId: string,
    from: number,
    to: number,
    signal?: AbortSignal,
  ): Promise<XRawChatMessage[]> {
    this.calls.push({ op: "getChatMessages", conversationId, from, to });
    if (this.chatMessagesFailure !== undefined) {
      return Promise.reject(this.chatMessagesFailure);
    }
    throwIfAborted(signal);
    return Promise.resolve(this.chatMessages.get(conversationId) ?? []);
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
  const connector = new XConnector(client, new FakeXContentCache(), "space");

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
  const connector = new XConnector(client, cache, "space");

  const raw = await connector.getRawData(FROM, TO);

  assertEquals(client.calls, [
    { op: "searchLists", query: "space", targetCount: 100 },
    { op: "getConversations" },
    { op: "getListPosts", listId: "1001", from: FROM, to: TO },
    { op: "getChatMessages", conversationId: "conv-g1", from: FROM, to: TO },
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
  const connector = new XConnector(client, cache, "space");

  const raw = await connector.getRawData(FROM, TO, ["x:list:1001"]);

  assertEquals(client.calls, [
    { op: "getListPosts", listId: "1001", from: MID + 1, to: TO },
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

test("getRawData does not call the client for fully covered feeds", async () => {
  const cache = new FakeXContentCache();
  cache.seedCoverage("x:list:1001", { from: FROM, to: TO });
  cache.seedItems("x:list:1001", [post("cached", FROM)]);
  const client = new FakeXApiClient();
  const connector = new XConnector(client, cache, "space");

  const raw = await connector.getRawData(FROM, TO, ["x:list:1001"]);

  assertEquals(client.calls, []);
  assertEquals(cache.records, []);
  assertEquals(raw["x:list:1001"].items, [post("cached", FROM)]);
});

test("a successful empty fetch establishes coverage for the whole gap", async () => {
  const client = new FakeXApiClient();
  const cache = new FakeXContentCache();
  const connector = new XConnector(client, cache, "space");

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
    { op: "getListPosts", listId: "1001", from: FROM, to: TO },
    { op: "getChatMessages", conversationId: "g1", from: FROM, to: TO },
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
  const connector = new XConnector(client, new FakeXContentCache(), "space");

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
  const connector = new XConnector(client, new FakeXContentCache(), "space");

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
  const connector = new XConnector(client, new FakeXContentCache(), "space");

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
  const connector = new XConnector(client, new FakeXContentCache(), "space");

  const pending = connector.getRawData(FROM, TO, ["x:list:1001"], controller.signal);
  controller.abort();

  const error = await assertRejects(() => pending);
  assert(error instanceof DOMException);
  assertEquals(error.name, "AbortError");
});

test("dispose aborts in-flight work and permanently disables the connector", async () => {
  const client = new FakeXApiClient();
  client.holdListPosts = true;
  const connector = new XConnector(client, new FakeXContentCache(), "space");

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
    { op: "getListPosts", listId: "1001", from: FROM, to: TO },
  ]);
});

test("a failed list discovery drains its held conversation sibling before listAvailableFeeds and dispose settle", async () => {
  const original = new Error("list search exploded");
  const client = new FakeXApiClient();
  client.searchListsFailure = original;
  client.holdConversations = true;
  const connector = new XConnector(client, new FakeXContentCache(), "space");

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
  const connector = new XConnector(client, new FakeXContentCache(), "space");

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
  const connector = new XConnector(client, cache, "space");

  const error = await assertRejects(() =>
    connector.getRawData(FROM, TO, ["x:list:1001", "x:chat:g1"])
  );

  assertStringIncludes(error.message, "upstream exploded");
  assertEquals(cache.records.map((record) => record.feed), ["x:list:1001"]);
});

test("an empty explicit feed selection returns no data and calls no upstream", async () => {
  const client = new FakeXApiClient();
  const connector = new XConnector(client, new FakeXContentCache(), "space");

  const raw = await connector.getRawData(FROM, TO, []);

  assertEquals(raw, {});
  assertEquals(client.calls, []);
});

test("explicit targets must be canonical x:list or x:chat ids", async () => {
  const connector = new XConnector(
    new FakeXApiClient(),
    new FakeXContentCache(),
    "space",
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
  const connector = new XConnector(client, new FakeXContentCache(), "space");

  const raw = await connector.getRawData(FROM, TO, ["x:list:1001", "x:list:1001"]);

  assertEquals(client.calls, [
    { op: "getListPosts", listId: "1001", from: FROM, to: TO },
  ]);
  assertEquals(Object.keys(raw), ["x:list:1001"]);
});

test("explicit batches above 250 feeds are rejected", async () => {
  const many = Array.from({ length: 251 }, (_, index) => `x:list:${1000 + index}`);
  const connector = new XConnector(
    new FakeXApiClient(),
    new FakeXContentCache(),
    "space",
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
  const connector = new XConnector(client, new FakeXContentCache(), "space");

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
