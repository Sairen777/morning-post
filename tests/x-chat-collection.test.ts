import { test } from "bun:test";
import type { Page } from "playwright";

import {
  collectXTarget,
  normalizeCollectedChatMessages,
} from "../src/connectors/x/collection.ts";
import type {
  XDomChatMessage,
  XDomTimelineItem,
} from "../src/connectors/x/dom-extractors.ts";
import { X_DOM } from "../src/connectors/x/dom-selectors.ts";
import type { XVirtualScrollWait } from "../src/connectors/x/virtual-scroll.ts";
import type { XTarget } from "../src/connectors/x/x.types.ts";
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "./assertions.ts";

const FROM = 1_750_000_000_000;
const TO = FROM + 86_400_000;
const CHAT_CONVERSATION_ID = "team-chat";
const CHAT_TARGET = {
  kind: "chat",
  conversationId: CHAT_CONVERSATION_ID,
} as const satisfies XTarget;
const CHAT_URL = `https://x.com/i/chat/${CHAT_CONVERSATION_ID}`;
const LIST_ID = "123456789";
const LIST_TARGET = {
  kind: "list",
  listId: LIST_ID,
} as const satisfies XTarget;
const LIST_URL = `https://x.com/i/lists/${LIST_ID}`;

// Production virtual-scroll backoff totals seconds per empty capture; tests
// inject an immediate settle wait so deterministic regression cases stay fast.
const immediateWait: XVirtualScrollWait = async () => {};

function chatMessage(overrides: Partial<XDomChatMessage> = {}): XDomChatMessage {
  return {
    platformId: "11111111-1111-4111-8111-111111111111",
    identityKey: "identityKey" in overrides
      ? overrides.identityKey
      : overrides.platformId ?? "11111111-1111-4111-8111-111111111111",
    date: FROM,
    text: "hello from the team",
    author: "Alice",
    reactions: [],
    ...overrides,
  };
}

interface FakeChatPageOptions {
  mainText: string;
  composerCount?: number;
  chatRounds?: XDomChatMessage[][];
  movements?: boolean[];
  emptyStateText?: string;
  emptyStateInsideRowOrComposer?: boolean;
}

// Drives collectXTarget through its full readiness, virtual-scroll, and
// completeness pipeline. The message extractor's in-browser callback is
// bypassed: `evaluateAll` on the chat message locator hands back pre-shaped
// XDomChatMessage rounds so the collection behavior itself is exercised.
// The structural empty-state locator runs the production phrase-matching
// callback against a stub element, so exact-phrase and row/composer
// exclusion rules are tested for real.
function fakeChatPage(options: FakeChatPageOptions): Page {
  const rounds = options.chatRounds ?? [];
  const movements = options.movements ?? [];
  let roundIndex = 0;
  let movementIndex = 0;

  const invisible = () => ({
    count: async () => 0,
    nth: () => ({ isVisible: async () => false, innerText: async () => "" }),
    first: () => ({ isVisible: async () => false, innerText: async () => "" }),
    evaluateAll: async () => [],
  });

  const locator = (selector: string) => {
    if (selector === X_DOM.chatMessage) {
      return {
        count: async () => (rounds[roundIndex] ?? []).length,
        evaluateAll: async () => rounds[roundIndex++] ?? [],
      };
    }
    if (selector === X_DOM.chatMessageScroller) {
      // The explicit Chat scroller mode advances the configured
      // dm-message-scroller directly; the fake reports the canned
      // movement sequence instead of running the in-browser callback.
      return {
        count: async () => 1,
        evaluate: async () => movements[movementIndex++] ?? false,
      };
    }
    if (selector === X_DOM.chatEmptyState) {
      return {
        count: async () => (options.emptyStateText === undefined ? 0 : 1),
        nth: () => ({
          isVisible: async () => true,
          evaluate: async (
            fn: (node: unknown, config: unknown) => unknown,
            config: unknown,
          ) => fn(
            {
              closest: () => (options.emptyStateInsideRowOrComposer === true ? {} : null),
              textContent: options.emptyStateText ?? "",
            },
            config,
          ),
        }),
      };
    }
    if (selector === X_DOM.chatComposer) {
      return {
        count: async () => options.composerCount ?? 0,
        nth: () => ({ isVisible: async () => false }),
      };
    }
    if (selector === X_DOM.main) {
      return {
        first: () => ({
          isVisible: async () => true,
          innerText: async () => options.mainText,
        }),
      };
    }
    if (selector === X_DOM.authenticatedAccount || selector === X_DOM.chatShell) {
      return {
        count: async () => 1,
        nth: () => ({ isVisible: async () => true }),
      };
    }
    return invisible();
  };

  return {
    url: () => CHAT_URL,
    goto: async () => {},
    locator,
    getByRole: () => ({
      count: async () => 0,
      nth: () => ({ isVisible: async () => false }),
    }),
    // With the explicit Chat scroller mode every advancement is driven by
    // the dm-message-scroller locator above; a page-level evaluate would
    // mean collection regressed to the implicit window fallback.
    evaluate: async () => {
      throw new Error("fake chat page unexpectedly used the page-level scroll fallback");
    },
  } as unknown as Page;
}

function timelinePost(overrides: Partial<XDomTimelineItem> = {}): XDomTimelineItem {
  return {
    platformId: "300000000000000000",
    date: FROM,
    text: "post from the list",
    author: "@list-author",
    url: "https://x.com/list-author/status/300000000000000000",
    replyCount: null,
    repostCount: null,
    likeCount: null,
    viewCount: null,
    ...overrides,
  };
}

interface FakeTimelinePageOptions {
  rounds?: XDomTimelineItem[][];
  movements?: boolean[];
  heading?: string;
  mainText?: string;
}

// Drives collectXTarget through the same readiness, virtual-scroll, and
// completeness pipeline for timeline targets (following and lists). The
// in-browser post extractor's callback is bypassed: `evaluateAll` on the
// timeline locator hands back pre-shaped XDomTimelineItem rounds so the
// collection behavior itself is exercised. Implicit-mode scrolling walks
// the last rendered item for a scrollable ancestor; the fake reports the
// canned movement sequence instead of running that callback. With no
// explicit scroller, an advance over an empty rendered window uses the
// production page-level scroll fallback, so the fake's page-level
// evaluate reports the same canned sequence.
function fakeTimelinePage(options: FakeTimelinePageOptions): Page {
  const rounds = options.rounds ?? [];
  const movements = options.movements ?? [];
  let roundIndex = 0;
  let movementIndex = 0;

  const invisible = () => ({
    count: async () => 0,
    nth: () => ({ isVisible: async () => false, innerText: async () => "" }),
    first: () => ({ isVisible: async () => false, innerText: async () => "" }),
    evaluateAll: async () => [],
  });

  const locator = (selector: string) => {
    if (selector === X_DOM.timelinePost) {
      return {
        count: async () => (rounds[roundIndex] ?? []).length,
        evaluateAll: async () => rounds[roundIndex++] ?? [],
        nth: () => ({ evaluate: async () => movements[movementIndex++] ?? false }),
      };
    }
    if (selector === X_DOM.main) {
      return {
        first: () => ({
          isVisible: async () => true,
          innerText: async () => options.mainText ?? "",
        }),
      };
    }
    if (selector === X_DOM.pageHeading) {
      return {
        count: async () => (options.heading === undefined ? 0 : 1),
        nth: () => ({
          isVisible: async () => options.heading !== undefined,
          innerText: async () => options.heading ?? "",
        }),
      };
    }
    if (selector === X_DOM.authenticatedAccount) {
      return {
        count: async () => 1,
        nth: () => ({ isVisible: async () => true }),
      };
    }
    return invisible();
  };

  return {
    url: () => LIST_URL,
    goto: async () => {},
    locator,
    getByRole: () => ({
      count: async () => 0,
      nth: () => ({ isVisible: async () => false }),
    }),
    evaluate: async () => movements[movementIndex++] ?? false,
  } as unknown as Page;
}

test("chat collection fails closed when only the composer renders without messages", async () => {
  const page = fakeChatPage({
    mainText: "Team Chat",
    composerCount: 1,
  });

  await assertRejects(
    () => collectXTarget(page, CHAT_TARGET, FROM, TO, undefined, immediateWait),
    Error,
    "explicit empty-conversation state",
  );
});

test("chat collection completes empty only for explicit structural empty-conversation UI", async () => {
  for (const emptyText of ["No messages yet", "Start a conversation"]) {
    const page = fakeChatPage({
      // The phrase also appears in ordinary prose: only the structural
      // empty-state element may certify the conversation as empty.
      mainText: `Team Chat — ${emptyText}, the team says`,
      composerCount: 1,
      emptyStateText: emptyText,
    });

    const result = await collectXTarget(
      page,
      CHAT_TARGET,
      FROM,
      TO,
      undefined,
      immediateWait,
    );

    assertEquals(result.items, []);
    assertEquals(result.feed.externalId, `x:chat:${CHAT_CONVERSATION_ID}`);
  }
});

test("chat collection rejects user prose that merely contains the empty phrase", async () => {
  const page = fakeChatPage({
    mainText: "No messages yet — everyone is on holiday",
    composerCount: 1,
  });

  await assertRejects(
    () => collectXTarget(page, CHAT_TARGET, FROM, TO, undefined, immediateWait),
    Error,
    "explicit empty-conversation state",
  );
});

test("chat collection rejects an empty phrase rendered inside a message row or composer", async () => {
  const page = fakeChatPage({
    mainText: "Team Chat",
    composerCount: 1,
    emptyStateText: "No messages yet",
    emptyStateInsideRowOrComposer: true,
  });

  await assertRejects(
    () => collectXTarget(page, CHAT_TARGET, FROM, TO, undefined, immediateWait),
    Error,
    "explicit empty-conversation state",
  );
});

test("chat collection fails when the extractor goes silent after rendering content", async () => {
  // Rounds [valid rows] -> [] -> []: virtual scrolling would otherwise
  // stall and report a boundary for a partial collection, certifying it.
  const page = fakeChatPage({
    mainText: "Team Chat",
    composerCount: 1,
    chatRounds: [
      [chatMessage({ platformId: "uuid-in-window" })],
      [],
      [],
    ],
  });

  await assertRejects(
    () => collectXTarget(page, CHAT_TARGET, FROM, TO, undefined, immediateWait),
    Error,
    "empty round after",
  );
});

test("chat collection returns zero when every dated message predates the window", async () => {
  const page = fakeChatPage({
    mainText: "Team Chat",
    composerCount: 1,
    chatRounds: [
      [chatMessage({ platformId: "uuid-oldest", date: FROM - 1, text: "old message" })],
    ],
  });

  const result = await collectXTarget(
    page,
    CHAT_TARGET,
    FROM,
    TO,
    undefined,
    immediateWait,
  );

  assertEquals(result.items, []);
  assertEquals(result.feed.externalId, `x:chat:${CHAT_CONVERSATION_ID}`);
});

test("chat collection boundary stop runs the top-boundary finalizer fail-closed and returns the collected window", async () => {
  // The finalizer is invoked only after the scroll boundary is proven. The
  // fake page's page-level evaluate throws, so this test also proves the
  // finalizer never reaches Chromium: without verified midnight-descent
  // evidence it fails closed before any evaluate.
  const message = chatMessage({ platformId: "uuid-in-window", date: FROM + 1_000 });
  const page = fakeChatPage({
    mainText: "Team Chat",
    composerCount: 1,
    chatRounds: [
      [message],
      [message],
      [message],
      [message],
      [message],
    ],
    // One moving advance, then four non-moving probes: the last probe
    // proves the boundary stall.
    movements: [true, false, false, false, false],
  });

  const result = await collectXTarget(
    page,
    CHAT_TARGET,
    FROM,
    TO,
    undefined,
    immediateWait,
  );

  assertEquals(result.items.length, 1);
  assertEquals(result.items[0]!.externalId, "uuid-in-window");
  assertEquals(result.items[0]!.date, FROM + 1_000);
  assertEquals(result.feed.externalId, `x:chat:${CHAT_CONVERSATION_ID}`);
});

test("chat collection condition stop never invokes the top-boundary finalizer", async () => {
  // The window predicate ends the collection (stopReason "condition")
  // before any boundary is proven: the stopReason gate keeps the leading
  // rows undated instead of inferring a previous day, and the collection
  // completes normally.
  const page = fakeChatPage({
    mainText: "Team Chat",
    composerCount: 1,
    chatRounds: [
      [chatMessage({ platformId: "uuid-oldest", date: FROM - 1, text: "old message" })],
    ],
  });

  const result = await collectXTarget(
    page,
    CHAT_TARGET,
    FROM,
    TO,
    undefined,
    immediateWait,
  );

  assertEquals(result.items, []);
  assertEquals(result.feed.externalId, `x:chat:${CHAT_CONVERSATION_ID}`);
});

test("list collection scrolls below the window and keeps in-window posts with stable identity, ordering, and canonical feed metadata", async () => {
  const newest = timelinePost({
    platformId: "300000000000000001",
    date: TO,
    text: "newest in-window post",
    author: "@new-author",
    url: "https://x.com/new-author/status/300000000000000001",
    replyCount: 0,
    repostCount: 1,
    likeCount: 2,
    viewCount: 3,
  });
  const middle = timelinePost({
    platformId: "300000000000000002",
    date: FROM + 1_000,
    text: "middle in-window post",
  });
  const oldPosts = [
    "300000000000000003",
    "300000000000000004",
    "300000000000000005",
    "300000000000000006",
    "300000000000000007",
  ].map((platformId, index) =>
    timelinePost({
      platformId,
      date: FROM - (index + 1) * 1_000,
      text: `old post ${index + 1}`,
    }),
  );

  const page = fakeTimelinePage({
    heading: "Design Picks",
    rounds: [
      [newest, middle],
      [middle, oldPosts[0]!],
      [oldPosts[0]!, oldPosts[1]!],
      [oldPosts[1]!, oldPosts[2]!],
      [oldPosts[2]!, oldPosts[3]!],
      [oldPosts[3]!, oldPosts[4]!],
    ],
    movements: [true, true, true, true, true],
  });

  const result = await collectXTarget(
    page,
    LIST_TARGET,
    FROM,
    TO,
    undefined,
    immediateWait,
  );

  // Virtual scrolling walked below the window (four consecutive rounds of
  // older posts prove the window predicate); only the in-window posts
  // survive timestamp filtering, newest first, each carrying its stable
  // platform identity as the external ID.
  assertEquals(result.items.length, 2);
  const first = result.items[0]!;
  const second = result.items[1]!;
  assert(first.kind === "post");
  assert(second.kind === "post");
  assertEquals(first.externalId, "300000000000000001");
  assertEquals(first.platformId, "300000000000000001");
  assertEquals(first.date, TO);
  assertEquals(first.text, "newest in-window post");
  assertEquals(first.author, "@new-author");
  assertEquals(first.url, "https://x.com/new-author/status/300000000000000001");
  assertEquals(first.replyCount, 0);
  assertEquals(first.repostCount, 1);
  assertEquals(first.likeCount, 2);
  assertEquals(first.viewCount, 3);
  assertEquals(second.externalId, "300000000000000002");
  assertEquals(second.date, FROM + 1_000);
  assertEquals(result.target, LIST_TARGET);
  assertEquals(result.feed, {
    externalId: `x:list:${LIST_ID}`,
    name: "Design Picks",
    kind: "news",
  });
});

test("list collection boundary stop omits rows outside the inclusive window", async () => {
  const inWindow = timelinePost({
    platformId: "300000000000000008",
    date: FROM + 5_000,
    text: "in-window post",
  });
  const before = timelinePost({
    platformId: "300000000000000009",
    date: FROM - 1,
    text: "predates the window",
  });
  const after = timelinePost({
    platformId: "300000000000000010",
    date: TO + 1,
    text: "postdates the window",
  });
  const round = [inWindow, before, after];

  const page = fakeTimelinePage({
    heading: "Design Picks",
    rounds: [round, round, round, round, round],
    movements: [false, false, false, false, false],
  });

  const result = await collectXTarget(
    page,
    LIST_TARGET,
    FROM,
    TO,
    undefined,
    immediateWait,
  );

  // A proven scroll boundary ends the collection; rows dated outside the
  // inclusive window are filtered out while in-window content is preserved.
  assertEquals(result.items.length, 1);
  assertEquals(result.items[0]!.externalId, "300000000000000008");
  assertEquals(result.items[0]!.date, FROM + 5_000);
  assertEquals(result.items[0]!.kind, "post");
  assertEquals(result.feed.externalId, `x:list:${LIST_ID}`);
});

test("chat normalization rejects empty or unrepresentable body text", () => {
  for (const text of ["", "   ", "\n\t"]) {
    assertThrows(
      () => normalizeCollectedChatMessages(
        [chatMessage({ text })],
        CHAT_TARGET,
        FROM,
        TO,
      ),
      Error,
      "empty or unrepresentable body",
    );
  }
});

test("chat normalization rejects unresolved or non-finite dates", () => {
  for (const date of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
    assertThrows(
      () => normalizeCollectedChatMessages(
        [chatMessage({ date })],
        CHAT_TARGET,
        FROM,
        TO,
      ),
      Error,
      "no reliable rendered timestamp",
    );
  }
});

test("chat normalization ignores undated rows conservatively proven outside the window", () => {
  const before = chatMessage({
    platformId: "uuid-media-before",
    date: null,
    text: "",
  });
  const after = chatMessage({
    platformId: "uuid-media-after",
    date: null,
    text: "",
  });

  const result = normalizeCollectedChatMessages(
    [before, after],
    CHAT_TARGET,
    FROM,
    TO,
    (item) => item.platformId === "uuid-media-before"
      ? { lower: null, upper: FROM - 1 }
      : { lower: TO + 1, upper: null },
  );

  assertEquals(result, []);
});

test("chat normalization fails undated rows whose bounds touch or cross the window", () => {
  for (const bounds of [
    { lower: null, upper: FROM },
    { lower: null, upper: null },
    { lower: TO, upper: null },
  ]) {
    assertThrows(
      () => normalizeCollectedChatMessages(
        [chatMessage({ platformId: "uuid-media", date: null, text: "" })],
        CHAT_TARGET,
        FROM,
        TO,
        () => bounds,
      ),
      Error,
      "no reliable rendered timestamp",
    );
  }
});

test("chat normalization keeps valid in-window messages and drops those outside it", () => {
  const older = chatMessage({
    platformId: "uuid-older",
    date: FROM - 1,
    text: "before the window",
  });
  const atEnd = chatMessage({
    platformId: "uuid-at-end",
    date: TO,
    text: "at the window end",
  });
  const after = chatMessage({
    platformId: "uuid-after",
    date: TO + 1,
    text: "after the window",
  });

  const result = normalizeCollectedChatMessages(
    [older, atEnd, after],
    CHAT_TARGET,
    FROM,
    TO,
  );

  assertEquals(result.map((item) => item.externalId), ["uuid-at-end"]);
});

test("chat normalization resolves fully contained undated rows to their lower bound", () => {
  const contained = chatMessage({
    platformId: "uuid-media-contained",
    date: null,
    text: "[Image]",
  });

  const result = normalizeCollectedChatMessages(
    [contained],
    CHAT_TARGET,
    FROM,
    TO,
    () => ({ lower: FROM + 10_000, upper: TO - 10_000 }),
  );

  assertEquals(result.length, 1);
  assertEquals(result[0].externalId, "uuid-media-contained");
  assertEquals(result[0].platformId, "uuid-media-contained");
  assertEquals(result[0].date, FROM + 10_000);
  assertEquals(result[0].text, "[Image]");
});

test("chat normalization resolves undated rows whose bounds equal the window edges", () => {
  const atStart = chatMessage({
    platformId: "uuid-media-at-start",
    date: null,
    text: "[Image]",
  });
  const atEnd = chatMessage({
    platformId: "uuid-media-at-end",
    date: null,
    text: "[Image]",
  });

  const result = normalizeCollectedChatMessages(
    [atStart, atEnd],
    CHAT_TARGET,
    FROM,
    TO,
    (item) => item.platformId === "uuid-media-at-start"
      ? { lower: FROM, upper: FROM }
      : { lower: TO, upper: TO },
  );

  assertEquals(
    result.map((item) => ({ externalId: item.externalId, date: item.date })),
    [
      { externalId: "uuid-media-at-end", date: TO },
      { externalId: "uuid-media-at-start", date: FROM },
    ],
  );
});

test("chat normalization fails undated rows whose bounds straddle the window", () => {
  for (const bounds of [
    { lower: FROM - 5_000, upper: TO + 5_000 },
    { lower: FROM - 5_000, upper: TO },
    { lower: FROM, upper: TO + 5_000 },
  ]) {
    assertThrows(
      () => normalizeCollectedChatMessages(
        [chatMessage({ platformId: "uuid-media", date: null, text: "[Image]" })],
        CHAT_TARGET,
        FROM,
        TO,
        () => bounds,
      ),
      Error,
      "no reliable rendered timestamp",
    );
  }
});

test("chat normalization fails undated rows with one-sided bounds that may touch the window", () => {
  for (const bounds of [
    { lower: null, upper: TO },
    { lower: FROM, upper: null },
  ]) {
    assertThrows(
      () => normalizeCollectedChatMessages(
        [chatMessage({ platformId: "uuid-media", date: null, text: "[Image]" })],
        CHAT_TARGET,
        FROM,
        TO,
        () => bounds,
      ),
      Error,
      "no reliable rendered timestamp",
    );
  }
});

test("chat normalization fails undated rows with contradictory bounds", () => {
  // A contradictory interval is invalid evidence and must fail even when its
  // upper bound alone would look wholly before the window.
  assertThrows(
    () => normalizeCollectedChatMessages(
      [chatMessage({ platformId: "uuid-media", date: null, text: "[Image]" })],
      CHAT_TARGET,
      FROM,
      TO,
      () => ({ lower: 100, upper: 50 }),
    ),
    Error,
    "no reliable rendered timestamp",
  );
  assertThrows(
    () => normalizeCollectedChatMessages(
      [chatMessage({ platformId: "uuid-media", date: null, text: "[Image]" })],
      CHAT_TARGET,
      FROM,
      TO,
      () => ({ lower: FROM + 10_000, upper: FROM + 5_000 }),
    ),
    Error,
    "no reliable rendered timestamp",
  );
});

test("chat normalization ignores undated rows with finite bounds wholly outside the window", () => {
  const before = chatMessage({
    platformId: "uuid-media-before",
    date: null,
    text: "",
  });
  const after = chatMessage({
    platformId: "uuid-media-after",
    date: null,
    text: "",
  });

  const result = normalizeCollectedChatMessages(
    [before, after],
    CHAT_TARGET,
    FROM,
    TO,
    (item) => item.platformId === "uuid-media-before"
      ? { lower: FROM - 100_000, upper: FROM - 1 }
      : { lower: TO + 1, upper: TO + 100_000 },
  );

  assertEquals(result, []);
});

test("chat normalization builds deterministic fallback IDs from the resolved date", () => {
  const item = chatMessage({
    platformId: null,
    identityKey: null,
    date: null,
    text: "[Image]",
  });

  const first = normalizeCollectedChatMessages(
    [item],
    CHAT_TARGET,
    FROM,
    TO,
    () => ({ lower: FROM + 10_000, upper: TO - 10_000 }),
  );
  const repeated = normalizeCollectedChatMessages(
    [item],
    CHAT_TARGET,
    FROM,
    TO,
    () => ({ lower: FROM + 10_000, upper: TO - 10_000 }),
  );
  const differentBounds = normalizeCollectedChatMessages(
    [item],
    CHAT_TARGET,
    FROM,
    TO,
    () => ({ lower: FROM + 20_000, upper: TO - 10_000 }),
  );

  assertEquals(first[0].date, FROM + 10_000);
  assertEquals(first[0].externalId.startsWith("fallback:"), true);
  // Deterministic for identical evidence, and the surrogate timestamp
  // participates in the identity rather than being ignored.
  assertEquals(first[0].externalId, repeated[0].externalId);
  assertNotEquals(first[0].externalId, differentBounds[0].externalId);
  // Distinct occurrences of identical undated rows still get unique IDs.
  const duplicates = normalizeCollectedChatMessages(
    [
      chatMessage({ platformId: null, identityKey: null, date: null, text: "[Image]" }),
      chatMessage({ platformId: null, identityKey: null, date: null, text: "[Image]" }),
    ],
    CHAT_TARGET,
    FROM,
    TO,
    () => ({ lower: FROM + 10_000, upper: TO - 10_000 }),
  );
  assertNotEquals(duplicates[0].externalId, duplicates[1].externalId);

  // A sender literally named "You" and the viewer must not collapse to one
  // ID-less record merely because their visible author, body, and date match.
  const senderNamedYou = chatMessage({
    platformId: null,
    identityKey: null,
    date: null,
    text: "same visible message",
    author: "You",
  });
  const viewer = { ...senderNamedYou, viewerAuthored: true as const };
  const visibleNameCollision = normalizeCollectedChatMessages(
    [senderNamedYou, viewer],
    CHAT_TARGET,
    FROM,
    TO,
    () => ({ lower: FROM + 10_000, upper: TO - 10_000 }),
  );
  assertNotEquals(
    visibleNameCollision[0].externalId,
    visibleNameCollision[1].externalId,
  );
  assertEquals(
    visibleNameCollision.map((message) => message.viewerAuthored === true),
    [false, true],
  );
});

test("chat normalization rejects empty body text even after undated bounds resolve", () => {
  assertThrows(
    () => normalizeCollectedChatMessages(
      [chatMessage({ platformId: "uuid-media", date: null, text: "" })],
      CHAT_TARGET,
      FROM,
      TO,
      () => ({ lower: FROM + 1_000, upper: TO - 1_000 }),
    ),
    Error,
    "empty or unrepresentable body",
  );
});
