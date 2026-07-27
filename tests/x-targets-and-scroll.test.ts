import { test } from "bun:test";
import type { Page } from "playwright";

import { xCredentialSchema } from "../src/connectors/credential-schemas.ts";
import { normalizeCollectedChatMessages } from "../src/connectors/x/collection.ts";
import {
  formatXFeedExternalId,
  formatXTargetUrl,
  parseXFeedExternalId,
  parseXTargetUrl,
} from "../src/connectors/x/targets.ts";
import type { XTarget } from "../src/connectors/x/x.types.ts";
import { collectVirtualizedItems } from "../src/connectors/x/virtual-scroll.ts";
import {
  assertEquals,
  assertStrictEquals,
  assertRejects,
  assertThrows,
} from "./assertions.ts";

interface CanonicalTargetCase {
  url: string;
  externalId: string;
  target: XTarget;
}

const CANONICAL_TARGETS: CanonicalTargetCase[] = [
  {
    url: "https://x.com/home",
    externalId: "x:following",
    target: { kind: "following" },
  },
  {
    url: "https://x.com/i/lists/1",
    externalId: "x:list:1",
    target: { kind: "list", listId: "1" },
  },
  {
    url: "https://x.com/i/lists/12345678901234567890123456789012",
    externalId: "x:list:12345678901234567890123456789012",
    target: { kind: "list", listId: "12345678901234567890123456789012" },
  },
  {
    url: "https://x.com/messages/a",
    externalId: "x:chat:a",
    target: { kind: "chat", conversationId: "a" },
  },
  {
    url: "https://x.com/messages/Team_chat-01",
    externalId: "x:chat:Team_chat-01",
    target: { kind: "chat", conversationId: "Team_chat-01" },
  },
];

const REJECTED_TARGET_URLS = [
  "http://x.com/home",
  "https://twitter.com/home",
  "https://www.x.com/home",
  "https://mobile.x.com/home",
  "https://x.com.evil.example/home",
  "https://x.com:443/home",
  "https://x.com/home?lang=en",
  "https://x.com/home#top",
  "https://x.com/home/",
  "https://x.com/home/following",
  "https://x.com/i/lists/0",
  "https://x.com/i/lists/01",
  "https://x.com/i/lists/-1",
  "https://x.com/i/lists/not-a-number",
  "https://x.com/i/lists/123/members",
  "https://x.com/i/lists/123?show=posts",
  "https://x.com/i/lists/123#posts",
  "https://x.com/i/lists/123456789012345678901234567890123",
  "https://x.com/messages/",
  "https://x.com/messages/_chat",
  "https://x.com/messages/-chat",
  "https://x.com/messages/chat.name",
  "https://x.com/messages/chat/extra",
  "https://x.com/messages/chat?via=inbox",
  "https://x.com/messages/chat#latest",
  "https://x.com/messages/compose",
  "https://x.com/messages/REQUESTS",
  `https://x.com/messages/${"a".repeat(129)}`,
  "https://x.com/home\n",
];

const REJECTED_EXTERNAL_IDS = [
  "X:following",
  "x:following:",
  "x:following:extra",
  "x:list:",
  "x:list:0",
  "x:list:01",
  "x:list:-1",
  "x:list:not-a-number",
  "x:list:1:extra",
  `x:list:${"1".repeat(33)}`,
  "x:chat:",
  "x:chat:_chat",
  "x:chat:-chat",
  "x:chat:chat.name",
  "x:chat:chat/extra",
  "x:chat:compose",
  "x:chat:Settings",
  `x:chat:${"a".repeat(129)}`,
  " x:following",
  "x:following ",
  "x:following\n",
];

const CANONICAL_PROFILE_ID = "123e4567-e89b-42d3-a456-426614174000";

test("X targets accept and round-trip only canonical URLs and feed IDs", () => {
  for (const { url, externalId, target } of CANONICAL_TARGETS) {
    assertEquals(parseXTargetUrl(url), target);
    assertEquals(parseXFeedExternalId(externalId), target);
    assertStrictEquals(formatXTargetUrl(target), url);
    assertStrictEquals(formatXFeedExternalId(target), externalId);
  }
});

test("X target URLs reject alternate origins and non-canonical path variants", () => {
  for (const value of REJECTED_TARGET_URLS) {
    assertThrows(() => parseXTargetUrl(value), Error, undefined, value);
  }
});

test("X feed IDs reject malformed list and chat identifiers", () => {
  for (const value of REJECTED_EXTERNAL_IDS) {
    assertThrows(() => parseXFeedExternalId(value), Error, undefined, value);
  }
});

test("X credentials contain exactly one canonical lowercase UUID profile ID", () => {
  assertEquals(xCredentialSchema.parse({ profileId: CANONICAL_PROFILE_ID }), {
    profileId: CANONICAL_PROFILE_ID,
  });

  const rejectedCredentials: unknown[] = [
    {},
    { profileId: CANONICAL_PROFILE_ID, extra: true },
    { profileId: CANONICAL_PROFILE_ID.toUpperCase() },
    { profileId: "123e4567e89b42d3a456426614174000" },
    { profileId: `../${CANONICAL_PROFILE_ID}` },
    { profileId: "not-a-uuid" },
    { profileId: 42 },
    { profileId: null },
  ];

  for (const credentials of rejectedCredentials) {
    assertStrictEquals(
      xCredentialSchema.safeParse(credentials).success,
      false,
      `Expected X credentials to reject ${JSON.stringify(credentials)}`,
    );
  }
});

test("ID-less identical X chat messages receive distinct deterministic fallback IDs", () => {
  const message = {
    platformId: null,
    date: 1_721_000_000_000,
    text: "same message",
    author: "Alice",
    reactions: [],
  };
  const target = { kind: "chat", conversationId: "conversation-1" } as const;

  const first = normalizeCollectedChatMessages(
    [{ ...message }, { ...message }],
    target,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const second = normalizeCollectedChatMessages(
    [{ ...message }, { ...message }],
    target,
    0,
    Number.MAX_SAFE_INTEGER,
  );

  assertStrictEquals(first.length, 2);
  assertStrictEquals(new Set(first.map((item) => item.externalId)).size, 2);
  assertEquals(
    first.map((item) => item.externalId),
    second.map((item) => item.externalId),
  );
});

interface FakePage {
  page: Page;
  advancementCount: () => number;
}

function fakePage(movements: readonly boolean[]): FakePage {
  let advancementCount = 0;
  return {
    page: {
      locator: () => ({
        count: () => Promise.resolve(0),
      }),
      evaluate: () => {
        const moved = movements[advancementCount] ?? false;
        advancementCount += 1;
        return Promise.resolve(moved);
      },
    } as unknown as Page,
    advancementCount: () => advancementCount,
  };
}

test("virtual scrolling reports a reached condition even when the item cap is reached in that round", async () => {
  const fake = fakePage([]);

  const result = await collectVirtualizedItems(fake.page, {
    itemSelector: "[data-item]",
    extractRound: () => Promise.resolve(["first", "second"]),
    identityOf: (item) => item,
    maxItems: 1,
    maxRounds: 1,
    shouldStop: () => true,
  });

  assertEquals(result, { items: ["first"], stopReason: "condition" });
  assertStrictEquals(fake.advancementCount(), 0);
});

test("virtual scrolling reports max_items when an item cap truncates collection", async () => {
  const fake = fakePage([]);

  const result = await collectVirtualizedItems(fake.page, {
    itemSelector: "[data-item]",
    extractRound: () => Promise.resolve(["first", "second"]),
    identityOf: (item) => item,
    maxItems: 1,
    shouldStop: () => false,
  });

  assertEquals(result, { items: ["first"], stopReason: "max_items" });
  assertStrictEquals(fake.advancementCount(), 0);
});

test("virtual scrolling reports a reached boundary on the final allowed round", async () => {
  const fake = fakePage([false]);

  const result = await collectVirtualizedItems(fake.page, {
    itemSelector: "[data-item]",
    extractRound: () => Promise.resolve([]),
    identityOf: (item: string) => item,
    maxRounds: 1,
    maxNoProgressRounds: 1,
  });

  assertEquals(result, { items: [], stopReason: "boundary" });
  assertStrictEquals(fake.advancementCount(), 1);
});

test("virtual scrolling propagates rendered-edge failures instead of inferring a boundary", async () => {
  let windowFallbackCount = 0;
  const page = {
    locator: () => ({
      count: () => Promise.resolve(1),
      nth: () => ({
        scrollIntoViewIfNeeded: () =>
          Promise.reject(new Error("rendered edge detached")),
        evaluate: () => Promise.resolve(false),
      }),
    }),
    evaluate: () => {
      windowFallbackCount += 1;
      return Promise.resolve(false);
    },
  } as unknown as Page;

  await assertRejects(
    () =>
      collectVirtualizedItems(page, {
        itemSelector: "[data-item]",
        extractRound: () => Promise.resolve([]),
        identityOf: (item: string) => item,
        maxRounds: 1,
        maxNoProgressRounds: 1,
      }),
    Error,
    "rendered edge detached",
  );
  assertStrictEquals(windowFallbackCount, 0);
});

test("virtual scrolling reports max_rounds when movement prevents a boundary result", async () => {
  const fake = fakePage([true]);

  const result = await collectVirtualizedItems(fake.page, {
    itemSelector: "[data-item]",
    extractRound: () => Promise.resolve([]),
    identityOf: (item: string) => item,
    maxRounds: 1,
    maxNoProgressRounds: 1,
  });

  assertEquals(result, { items: [], stopReason: "max_rounds" });
  assertStrictEquals(fake.advancementCount(), 1);
});

test("overlap-aware upward scrolling preserves identical messages entering the window", async () => {
  const fake = fakePage([true, true]);
  const windows = [["same"], ["same", "same"]];
  let round = 0;

  const result = await collectVirtualizedItems(fake.page, {
    itemSelector: "[data-item]",
    direction: "up",
    mergeOverlappingWindows: true,
    extractRound: () =>
      Promise.resolve(windows[Math.min(round++, windows.length - 1)]),
    identityOf: (item) => item,
    maxRounds: 2,
  });

  assertEquals(result, {
    items: ["same", "same"],
    stopReason: "max_rounds",
  });
  assertStrictEquals(fake.advancementCount(), 2);
});

test("overlap-aware scrolling rejects an indistinguishable moved fixed-size window", async () => {
  const fake = fakePage([true, true]);
  let round = 0;
  const windows = [["same", "same"], ["same", "same"]];

  await assertRejects(
    () =>
      collectVirtualizedItems(fake.page, {
        itemSelector: "[data-item]",
        direction: "up",
        mergeOverlappingWindows: true,
        extractRound: () =>
          Promise.resolve(windows[Math.min(round++, windows.length - 1)]),
        identityOf: (item) => item,
        maxRounds: 2,
      }),
    Error,
    "could not reconcile a moved window",
  );
});

test("overlap-aware scrolling still globally deduplicates stable item IDs", async () => {
  const fake = fakePage([true, true]);
  let round = 0;
  const windows = [
    [{ id: "one" }, { id: "two" }],
    [{ id: "one" }, { id: "three" }],
  ];

  const result = await collectVirtualizedItems(fake.page, {
    itemSelector: "[data-item]",
    direction: "up",
    mergeOverlappingWindows: true,
    identityIsStable: () => true,
    extractRound: () =>
      Promise.resolve(windows[Math.min(round++, windows.length - 1)]),
    identityOf: (item) => item.id,
    maxRounds: 2,
  });

  assertEquals(result, {
    items: [{ id: "one" }, { id: "two" }, { id: "three" }],
    stopReason: "max_rounds",
  });
});

test("overlap-aware scrolling rejects multiple unstable overlap candidates", async () => {
  const fake = fakePage([true, true]);
  let round = 0;
  const windows = [
    ["A", "B", "A", "C"],
    ["D", "A", "B", "A"],
  ];

  await assertRejects(
    () =>
      collectVirtualizedItems(fake.page, {
        itemSelector: "[data-item]",
        direction: "up",
        mergeOverlappingWindows: true,
        extractRound: () =>
          Promise.resolve(windows[Math.min(round++, windows.length - 1)]),
        identityOf: (item) => item,
        maxRounds: 2,
      }),
    Error,
    "could not reconcile a moved window",
  );
});
