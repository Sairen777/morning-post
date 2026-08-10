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
    url: "https://x.com/i/chat/a",
    externalId: "x:chat:a",
    target: { kind: "chat", conversationId: "a" },
  },
  {
    url: "https://x.com/i/chat/Team_chat-01",
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
  "https://x.com/i/chat/",
  "https://x.com/i/chat/_chat",
  "https://x.com/i/chat/-chat",
  "https://x.com/i/chat/chat.name",
  "https://x.com/i/chat/chat/extra",
  "https://x.com/i/chat/chat?via=inbox",
  "https://x.com/i/chat/chat#latest",
  "https://x.com/i/chat/compose",
  "https://x.com/i/chat/new",
  "https://x.com/i/chat/REQUESTS",
  `https://x.com/i/chat/${"a".repeat(129)}`,
  "https://x.com/messages/a",
  "https://x.com/messages/Team_chat-01",
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
  "x:chat:new",
  "x:chat:Settings",
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
interface WaitSpy {
  waits: number[];
  wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

function recordingWait(): WaitSpy {
  const waits: number[] = [];
  return {
    waits,
    wait: async (milliseconds: number) => {
      waits.push(milliseconds);
    },
  };
}


test("virtual scrolling advances by half a viewport with instant behavior and deterministic pacing", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const scrollCalls: ScrollToOptions[] = [];
  let scrollY = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      innerHeight: 800,
      get scrollY() {
        return scrollY;
      },
      scrollBy(options: ScrollToOptions) {
        scrollCalls.push(options);
        scrollY += Number(options.top ?? 0);
      },
    },
  });

  try {
    const page = {
      locator: () => ({ count: () => Promise.resolve(0) }),
      evaluate: <T>(callback: (sign: number) => T, sign: number) =>
        Promise.resolve(callback(sign)),
    } as unknown as Page;
    const waits = recordingWait();
    const windows = [
      ["first"],
      ["first", "second"],
      ["first", "second", "third"],
    ];
    let round = 0;

    const result = await collectVirtualizedItems(page, {
      itemSelector: "[data-item]",
      extractRound: () =>
        Promise.resolve(windows[Math.min(round++, windows.length - 1)]),
      identityOf: (item: string) => item,
      maxRounds: 3,
    }, undefined, waits.wait);

    assertEquals(result, {
      items: ["first", "second", "third"],
      stopReason: "max_rounds",
    });
    assertEquals(scrollCalls, [
      { top: 400, behavior: "instant" },
      { top: 400, behavior: "instant" },
      { top: 400, behavior: "instant" },
    ]);
    assertEquals(waits.waits, [1000, 1000]);
  } finally {
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  }
});

test("virtual scrolling resets pacing after a productive window follows no progress", async () => {
  const fake = fakePage([true, true, true, true]);
  const waits = recordingWait();
  const windows = [["first"], [], ["first", "second"], ["first", "second", "third"]];
  let round = 0;

  const result = await collectVirtualizedItems(fake.page, {
    itemSelector: "[data-item]",
    extractRound: () =>
      Promise.resolve(windows[Math.min(round++, windows.length - 1)]),
    identityOf: (item) => item,
    maxRounds: 4,
  }, undefined, waits.wait);

  assertEquals(result, {
    items: ["first", "second", "third"],
    stopReason: "max_rounds",
  });
  assertEquals(waits.waits, [1000, 1500, 1000]);
});


test("virtual scrolling reports a reached condition even when the item cap is reached in that round", async () => {
  const fake = fakePage([]);
  const waits = recordingWait();

  const result = await collectVirtualizedItems(fake.page, {
    itemSelector: "[data-item]",
    extractRound: () => Promise.resolve(["first", "second"]),
    identityOf: (item) => item,
    maxItems: 1,
    maxRounds: 1,
    shouldStop: () => true,
  }, undefined, waits.wait);

  assertEquals(result, { items: ["first"], stopReason: "condition" });
  assertStrictEquals(fake.advancementCount(), 0);
  assertEquals(waits.waits, []);
});


test("virtual scrolling reports max_items when an item cap truncates collection", async () => {
  const fake = fakePage([]);
  const waits = recordingWait();

  const result = await collectVirtualizedItems(fake.page, {
    itemSelector: "[data-item]",
    extractRound: () => Promise.resolve(["first", "second"]),
    identityOf: (item) => item,
    maxItems: 1,
    shouldStop: () => false,
  }, undefined, waits.wait);

  assertEquals(result, { items: ["first"], stopReason: "max_items" });
  assertStrictEquals(fake.advancementCount(), 0);
  assertEquals(waits.waits, []);
});

test("virtual scrolling reports a reached boundary on the final allowed round", async () => {
  const fake = fakePage([false]);
  const waits = recordingWait();

  const result = await collectVirtualizedItems(fake.page, {
    itemSelector: "[data-item]",
    extractRound: () => Promise.resolve([]),
    identityOf: (item: string) => item,
    maxRounds: 1,
    maxNoProgressRounds: 1,
  }, undefined, waits.wait);

  assertEquals(result, { items: [], stopReason: "boundary" });
  assertStrictEquals(fake.advancementCount(), 1);
  assertEquals(waits.waits, []);
});


test("virtual scrolling propagates rendered-edge failures instead of inferring a boundary", async () => {
  let windowFallbackCount = 0;
  const page = {
    locator: () => ({
      count: () => Promise.resolve(1),
      nth: () => ({
        evaluate: () => Promise.reject(new Error("rendered edge detached")),
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
  const waits = recordingWait();

  const result = await collectVirtualizedItems(fake.page, {
    itemSelector: "[data-item]",
    extractRound: () => Promise.resolve([]),
    identityOf: (item: string) => item,
    maxRounds: 1,
    maxNoProgressRounds: 4,
  }, undefined, waits.wait);

  assertEquals(result, { items: [], stopReason: "max_rounds" });
  assertStrictEquals(fake.advancementCount(), 1);
  assertEquals(waits.waits, []);
});

test("virtual scrolling reports no_progress after settled moved windows add nothing", async () => {
  const fake = fakePage([true, true]);
  const waits = recordingWait();

  const result = await collectVirtualizedItems(fake.page, {
    itemSelector: "[data-item]",
    extractRound: () => Promise.resolve([]),
    identityOf: (item: string) => item,
    maxRounds: 3,
    maxNoProgressRounds: 2,
  }, undefined, waits.wait);

  assertEquals(result, { items: [], stopReason: "no_progress" });
  assertStrictEquals(fake.advancementCount(), 2);
  assertEquals(waits.waits, [1500, 2500]);
});

test("virtual scrolling does not fail before a first moved window can load content", async () => {
  const fake = fakePage([true, true]);
  const waits = recordingWait();
  const windows = [[], ["loaded"]];
  let round = 0;

  const result = await collectVirtualizedItems(fake.page, {
    itemSelector: "[data-item]",
    extractRound: () =>
      Promise.resolve(windows[Math.min(round++, windows.length - 1)]),
    identityOf: (item: string) => item,
    maxRounds: 2,
    maxNoProgressRounds: 1,
  }, undefined, waits.wait);

  assertEquals(result, { items: ["loaded"], stopReason: "max_rounds" });
  assertStrictEquals(fake.advancementCount(), 2);
  assertEquals(waits.waits, [1500]);
});



test("virtual scrolling reports boundary only after a non-moving edge is proven", async () => {
  const fake = fakePage([false, false, false, false]);
  const waits = recordingWait();

  const result = await collectVirtualizedItems(fake.page, {
    itemSelector: "[data-item]",
    extractRound: () => Promise.resolve([]),
    identityOf: (item: string) => item,
    maxRounds: 4,
    maxNoProgressRounds: 4,
  }, undefined, waits.wait);

  assertEquals(result, { items: [], stopReason: "boundary" });
  assertStrictEquals(fake.advancementCount(), 4);
  assertEquals(waits.waits, [1500, 2500, 4000]);
});

test("virtual scrolling backs off no-new pacing through the 4000 ms cap", async () => {
  const fake = fakePage([true, true, true, true]);
  const waits = recordingWait();

  const result = await collectVirtualizedItems(fake.page, {
    itemSelector: "[data-item]",
    extractRound: () => Promise.resolve([]),
    identityOf: (item: string) => item,
    maxRounds: 5,
    maxNoProgressRounds: 4,
  }, undefined, waits.wait);

  assertEquals(result, { items: [], stopReason: "no_progress" });
  assertStrictEquals(fake.advancementCount(), 4);
  assertEquals(waits.waits, [1500, 2500, 4000, 4000]);
});

test("virtual scrolling defers no_progress to a pending probe that proves a boundary", async () => {
  const fake = fakePage([true, false, false, false, false]);
  const waits = recordingWait();

  const result = await collectVirtualizedItems(fake.page, {
    itemSelector: "[data-item]",
    extractRound: () => Promise.resolve([]),
    identityOf: (item: string) => item,
    maxRounds: 6,
    maxNoProgressRounds: 4,
  }, undefined, waits.wait);

  assertEquals(result, { items: [], stopReason: "boundary" });
  assertStrictEquals(fake.advancementCount(), 5);
  assertEquals(waits.waits, [1500, 2500, 4000, 4000]);
});

test("virtual scrolling fails closed as no_progress without a wait when the deferred probe moves", async () => {
  const fake = fakePage([true, false, false, false, true]);
  const waits = recordingWait();

  const result = await collectVirtualizedItems(fake.page, {
    itemSelector: "[data-item]",
    extractRound: () => Promise.resolve([]),
    identityOf: (item: string) => item,
    maxRounds: 6,
    maxNoProgressRounds: 4,
  }, undefined, waits.wait);

  assertEquals(result, { items: [], stopReason: "no_progress" });
  assertStrictEquals(fake.advancementCount(), 5);
  assertEquals(waits.waits, [1500, 2500, 4000, 4000]);
});

test("virtual scrolling fails mixed no-new stalls as no_progress", async () => {
  const fake = fakePage([true, false, true, false, true]);
  const waits = recordingWait();

  const result = await collectVirtualizedItems(fake.page, {
    itemSelector: "[data-item]",
    extractRound: () => Promise.resolve([]),
    identityOf: (item: string) => item,
    maxRounds: 5,
    maxNoProgressRounds: 4,
  }, undefined, waits.wait);

  assertEquals(result, { items: [], stopReason: "no_progress" });
  assertStrictEquals(fake.advancementCount(), 4);
  assertEquals(waits.waits, [1500, 2500, 4000, 4000]);
});

test("virtual scrolling propagates aborts from the injected settle wait", async () => {
  const fake = fakePage([true]);
  const controller = new AbortController();
  let waitStarted = 0;
  const wait = (_milliseconds: number, signal?: AbortSignal) => {
    const { promise, reject } = Promise.withResolvers<void>();
    signal?.addEventListener(
      "abort",
      () => reject(new Error("settle aborted")),
      { once: true },
    );
    waitStarted += 1;
    controller.abort();
    return promise;
  };
  const collection = collectVirtualizedItems(fake.page, {
    itemSelector: "[data-item]",
    extractRound: () => Promise.resolve([]),
    identityOf: (item: string) => item,
    maxRounds: 2,
  }, controller.signal, wait);

  await assertRejects(() => collection, Error, "settle aborted");
  assertStrictEquals(waitStarted, 1);
});

test("overlap-aware upward scrolling preserves identical messages entering the window", async () => {
  const fake = fakePage([true, true]);
  const waits = recordingWait();
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
  }, undefined, waits.wait);

  assertEquals(result, {
    items: ["same", "same"],
    stopReason: "max_rounds",
  });
  assertStrictEquals(fake.advancementCount(), 2);
  assertEquals(waits.waits, [1000]);
});

test("overlap-aware scrolling rejects an indistinguishable moved fixed-size window", async () => {
  const fake = fakePage([true, true]);
  const waits = recordingWait();
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
      }, undefined, waits.wait),
    Error,
    "could not reconcile a moved window",
  );
  assertEquals(waits.waits, [1000]);
});

test("overlap-aware scrolling still globally deduplicates stable item IDs", async () => {
  const fake = fakePage([true, true]);
  const waits = recordingWait();
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
  }, undefined, waits.wait);

  assertEquals(result, {
    items: [{ id: "one" }, { id: "two" }, { id: "three" }],
    stopReason: "max_rounds",
  });
  assertEquals(waits.waits, [1000]);
});

test("overlap-aware scrolling rejects multiple unstable overlap candidates", async () => {
  const fake = fakePage([true, true]);
  const waits = recordingWait();
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
      }, undefined, waits.wait),
    Error,
    "could not reconcile a moved window",
  );
  assertEquals(waits.waits, [1000]);
});
