import { afterAll, beforeAll, test } from "bun:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import { requireCompleteCollection } from "../src/connectors/x/collection.ts";
import type { AvailableFeed } from "../src/connectors/connector.types.ts";
import {
  discoveryStopError,
  mergeDiscoveredFeeds,
  toAvailableFeeds,
} from "../src/connectors/x/discovery.ts";
import {
  extractChatMessages,
  extractLinks,
  type XDomChatMessage,
  type XDomLink,
} from "../src/connectors/x/dom-extractors.ts";
import { X_DOM } from "../src/connectors/x/dom-selectors.ts";
import {
  collectVirtualizedItems,
  type XVirtualScrollWait,
} from "../src/connectors/x/virtual-scroll.ts";
import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from "./assertions.ts";

// Real-DOM regression suite for deterministic X automation against a
// synthetic scrollable/virtualized Chat DOM. Every fixture lives in a
// hermetic Playwright Chromium page created with setContent (no network),
// and every collection injects a wait recorder, so no production-duration
// sleeps ever run. The virtualizer re-renders its message/link window from
// the current scroll position, exactly like a real X chat list: an edge row
// that is only partially visible is still present, and the scroll handler
// replaces the rows, which would detach the edge element if the scroller
// were advanced through a Playwright action that scrolls before locating
// its scrollable ancestor.

interface MessageRow {
  id: string;
  sender: string;
  text: string;
  date: string;
}

interface ConversationRow {
  href: string;
  name?: string;
  ariaLabel?: string;
}

interface VirtualizerOptions {
  rows: MessageRow[] | ConversationRow[];
  rowHeight: number;
  containerHeight: number;
  initialTop: number;
  /** Render only the initial window; subsequent scrolls change nothing. */
  stuck?: boolean;
  /** Wrap the scroller in an outer scrollable container with filler. */
  outerHeight?: number;
}

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser.close();
});

// Each test gets an isolated context. Every external request is intercepted
// and aborted before it can reach the network, and recorded so a test fails
// if the fixture ever tries to load anything.
async function newHermeticPage(): Promise<{
  context: BrowserContext;
  page: Page;
  requests: string[];
}> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests: string[] = [];
  await page.route(/^https?:/, async (route) => {
    requests.push(route.request().url());
    await route.abort();
  });
  return { context, page, requests };
}

function recordingWait(page: Page): { waits: number[]; wait: XVirtualScrollWait } {
  const waits: number[] = [];
  return {
    waits,
    wait: async (milliseconds: number) => {
      waits.push(milliseconds);
      // The injected wait replaces production's >=1s settle time, so give
      // the browser two frames: the previous advancement's scroll event,
      // the virtualizer's re-render, and any layout adjustments must all
      // land before the next round reads the DOM.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
    },
  };
}

// Globals installed by the fixture's inline script; every read below is a
// cross-realm bridge to that compiled-in contract.
interface VirtualizerGlobals {
  __render: () => void;
  __scrollLog: number[];
}

const renderVirtualWindow = (page: Page) =>
  page.evaluate(() => {
    const globals = window as unknown as VirtualizerGlobals;
    globals.__render();
  });

const scrollLog = (page: Page) =>
  page.evaluate(() => {
    const globals = window as unknown as VirtualizerGlobals;
    return globals.__scrollLog;
  });

const scrollerTop = (page: Page) =>
  page.evaluate(() => document.querySelector<HTMLElement>("#scroller")?.scrollTop ?? 0);

const windowScrollY = (page: Page) => page.evaluate(() => window.scrollY);

async function installVirtualizer(
  page: Page,
  kind: "messages" | "conversations",
  options: VirtualizerOptions,
): Promise<void> {
  const {
    rows,
    rowHeight,
    containerHeight,
    initialTop,
    stuck = false,
    outerHeight = 0,
  } = options;
  const totalHeight = rows.length * rowHeight;
  const scroller = outerHeight > 0
    ? `<div id="outer" style="height:${outerHeight}px;overflow-y:scroll">
        <div id="scroller" style="height:${containerHeight}px;overflow-y:auto;position:relative">
          <div id="spacer" style="position:relative;height:${totalHeight}px"><div id="virtual-window"></div></div>
        </div>
        <div style="height:800px"></div>
      </div>`
    : `<div id="scroller" style="height:${containerHeight}px;overflow-y:auto;position:relative">
        <div id="spacer" style="position:relative;height:${totalHeight}px"><div id="virtual-window"></div></div>
      </div>`;

  await page.setContent(`
<!doctype html>
<html>
<head>
<style>
  body { margin: 0; font-family: sans-serif; }
  #header { height: 80px; }
  main { display: block; }
</style>
</head>
<body>
  <div id="header">X automation hermetic fixture</div>
  <main>${scroller}</main>
  <div style="height:2000px" aria-hidden="true"></div>
  <script>
    (() => {
      const rows = ${JSON.stringify(rows)};
      const kind = ${JSON.stringify(kind)};
      const rowHeight = ${rowHeight};
      const containerHeight = ${containerHeight};
      const stuck = ${stuck};
      const scroller = document.getElementById("scroller");
      const windowEl = document.getElementById("virtual-window");
      const log = (window.__scrollLog = []);
      const makeRow = (row, index) => {
        const element = document.createElement(kind === "messages" ? "section" : "a");
        element.style.position = "absolute";
        element.style.top = index * rowHeight + "px";
        element.style.left = "0";
        element.style.right = "0";
        element.style.height = rowHeight + "px";
        element.style.boxSizing = "border-box";
        if (kind === "messages") {
          element.setAttribute("data-testid", "messageEntry");
          element.setAttribute("data-message-id", row.id);
          element.setAttribute("data-sender-name", row.sender);
          const time = document.createElement("time");
          time.setAttribute("datetime", row.date);
          const text = document.createElement("p");
          text.setAttribute("data-testid", "messageText");
          text.textContent = row.text;
          element.append(time, text);
        } else {
          element.setAttribute("data-conversation", "");
          element.setAttribute("href", row.href);
          if (row.ariaLabel) element.setAttribute("aria-label", row.ariaLabel);
          if (row.name) {
            const name = document.createElement("span");
            name.textContent = row.name;
            element.append(name);
          }
        }
        return element;
      };
      const render = () => {
        const top = scroller.scrollTop;
        const first = Math.max(0, Math.floor(top / rowHeight));
        const last = Math.min(rows.length - 1, Math.floor((top + containerHeight - 1) / rowHeight));
        const fragment = document.createDocumentFragment();
        for (let index = first; index <= last; index += 1) {
          fragment.append(makeRow(rows[index], index));
        }
        windowEl.replaceChildren(fragment);
      };
      void scroller.offsetHeight;
      scroller.scrollTop = ${initialTop};
      window.__render = stuck ? () => {} : render;
      scroller.addEventListener("scroll", () => {
        log.push(scroller.scrollTop);
        if (!stuck) render();
      });
      render();
    })();
  </script>
</body>
</html>
  `);
  // The initial `scrollTop` assignment can queue a scroll event that fires
  // after the listener is attached; flush it (and the re-render) before
  // clearing the log so only production-driven advancements are recorded.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await page.evaluate(() => {
    const globals = window as unknown as VirtualizerGlobals;
    globals.__scrollLog.length = 0;
  });
}

function chatRows(count: number): MessageRow[] {
  const rows: MessageRow[] = [];
  const base = Date.parse("2026-08-01T00:00:00.000Z");
  for (let index = 0; index < count; index += 1) {
    rows.push({
      id: `m-${index}`,
      sender: index % 2 === 0 ? "Alice" : "Bob",
      text: `message ${index} text`,
      date: new Date(base + index * 60_000).toISOString(),
    });
  }
  return rows;
}

const chatExtractRound = (page: Page) => async (): Promise<XDomChatMessage[]> => {
  await renderVirtualWindow(page);
  return await extractChatMessages(page);
};

const chatIdentity = (item: XDomChatMessage) =>
  item.platformId ?? `chat:${item.author}:${item.text}:${item.date}`;

const chatTarget = { kind: "chat", conversationId: "fixture" } as const;

test("real-DOM virtualized chat collection advances a re-rendering scroller, merges overlap, and proves the top boundary", async () => {
  const { context, page, requests } = await newHermeticPage();
  try {
    // 20 rows of 100px in a 400px scroller, starting at the bottom
    // (scrollTop 1600). Each half-viewport advance is 240px and lands on a
    // partially visible edge row, so any pre-scroll Playwright action that
    // scrolls the re-rendering virtualizer would detach the edge element.
    await installVirtualizer(page, "messages", {
      rows: chatRows(20),
      rowHeight: 100,
      containerHeight: 400,
      initialTop: 1600,
    });
    const waits = recordingWait(page);

    const result = await collectVirtualizedItems(page, {
      itemSelector: X_DOM.chatMessage,
      direction: "up",
      mergeOverlappingWindows: true,
      extractRound: chatExtractRound(page),
      identityOf: chatIdentity,
      identityIsStable: (item: XDomChatMessage) => item.platformId !== null,
    }, undefined, waits.wait);

    assertEquals(result.stopReason, "boundary");
    // Every rendered message is collected exactly once, in the order each
    // overlapping upward window introduced it.
    assertEquals(result.items.map((item) => item.platformId), [
      "m-16", "m-17", "m-18", "m-19",
      "m-13", "m-14", "m-15",
      "m-11", "m-12",
      "m-8", "m-9", "m-10",
      "m-6", "m-7",
      "m-4", "m-5",
      "m-1", "m-2", "m-3",
      "m-0",
    ]);
    assertStrictEquals(
      new Set(result.items.map((item) => item.platformId)).size,
      result.items.length,
    );
    assertEquals(result.items[0], {
      platformId: "m-16",
      date: Date.parse("2026-08-01T00:16:00.000Z"),
      text: "message 16 text",
      author: "Alice",
      reactions: [],
    });
    assertEquals(result.items[result.items.length - 1], {
      platformId: "m-0",
      date: Date.parse("2026-08-01T00:00:00.000Z"),
      text: "message 0 text",
      author: "Alice",
      reactions: [],
    });
    // Productive rounds settle for 1000ms; the no-new backoff runs
    // 1500/2500/4000ms, and the pending boundary probe adds no wait.
    assertEquals(
      waits.waits,
      [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1500, 2500, 4000],
    );
    // Every advancement is exactly half a viewport (240px) with instant
    // behavior: one scroll event per jump, no smooth-scroll frames.
    assertEquals(await scrollLog(page), [1360, 1120, 880, 640, 400, 160, 0]);
    assertEquals(await scrollerTop(page), 0);
    // The document is taller than the viewport, yet the window never
    // scrolls: the scroller detection must pick the chat container.
    assertEquals(await windowScrollY(page), 0);
    await requireCompleteCollection(page, chatTarget, "boundary");
    assertEquals(requests, []);
  } finally {
    await context.close();
  }
});

test("real-DOM chat collection proves a boundary when the scroller never moves", async () => {
  const { context, page, requests } = await newHermeticPage();
  try {
    await installVirtualizer(page, "messages", {
      rows: chatRows(20),
      rowHeight: 100,
      containerHeight: 400,
      initialTop: 0,
    });
    const waits = recordingWait(page);

    const result = await collectVirtualizedItems(page, {
      itemSelector: X_DOM.chatMessage,
      direction: "up",
      mergeOverlappingWindows: true,
      extractRound: chatExtractRound(page),
      identityOf: chatIdentity,
      identityIsStable: (item: XDomChatMessage) => item.platformId !== null,
    }, undefined, waits.wait);

    assertEquals(result.stopReason, "boundary");
    assertEquals(result.items.map((item) => item.platformId), [
      "m-0", "m-1", "m-2", "m-3",
    ]);
    assertEquals(waits.waits, [1000, 1500, 2500, 4000]);
    assertEquals(await scrollLog(page), []);
    assertEquals(await windowScrollY(page), 0);
    await requireCompleteCollection(page, chatTarget, "boundary");
    assertEquals(requests, []);
  } finally {
    await context.close();
  }
});

test("repeated virtualized chat windows fail closed as no_progress", async () => {
  const { context, page, requests } = await newHermeticPage();
  try {
    await installVirtualizer(page, "messages", {
      rows: chatRows(20),
      rowHeight: 100,
      containerHeight: 400,
      initialTop: 1600,
      stuck: true,
    });
    const waits = recordingWait(page);

    const result = await collectVirtualizedItems(page, {
      itemSelector: X_DOM.chatMessage,
      direction: "up",
      mergeOverlappingWindows: true,
      extractRound: chatExtractRound(page),
      identityOf: chatIdentity,
      identityIsStable: (item: XDomChatMessage) => item.platformId !== null,
    }, undefined, waits.wait);

    assertEquals(result.stopReason, "no_progress");
    assertEquals(result.items.map((item) => item.platformId), [
      "m-16", "m-17", "m-18", "m-19",
    ]);
    assertEquals(waits.waits, [1000, 1500, 2500, 4000]);
    assertEquals(await scrollLog(page), [1360, 1120, 880, 640]);
    // The repeated window is never proven complete: the collection
    // consumer must reject it instead of treating the items as final.
    await assertRejects(
      () => requireCompleteCollection(page, chatTarget, "no_progress"),
      Error,
      "X collection could not prove the requested time-window boundary (no_progress)",
    );
    assertEquals(requests, []);
  } finally {
    await context.close();
  }
});

test("real-DOM scroller selection prefers the nearest scrollable ancestor over outer and window scrollers", async () => {
  const { context, page, requests } = await newHermeticPage();
  try {
    await installVirtualizer(page, "messages", {
      rows: chatRows(13),
      rowHeight: 80,
      containerHeight: 200,
      initialTop: 0,
      outerHeight: 300,
    });
    const waits = recordingWait(page);

    const result = await collectVirtualizedItems(page, {
      itemSelector: X_DOM.chatMessage,
      direction: "down",
      extractRound: chatExtractRound(page),
      identityOf: chatIdentity,
    }, undefined, waits.wait);

    assertEquals(result.stopReason, "boundary");
    assertEquals(result.items.map((item) => item.platformId), [
      "m-0", "m-1", "m-2",
      "m-3", "m-4", "m-5",
      "m-6", "m-7", "m-8",
      "m-9", "m-10", "m-11",
      "m-12",
    ]);
    assertEquals(waits.waits, [1000, 1000, 1000, 1000, 1000, 1500, 2500, 4000]);
    assertEquals(await scrollLog(page), [240, 480, 720, 840]);
    assertEquals(await scrollerTop(page), 840);
    assertEquals(
      await page.evaluate(() => document.querySelector<HTMLElement>("#outer")?.scrollTop ?? 0),
      0,
    );
    assertEquals(await windowScrollY(page), 0);
    assertEquals(requests, []);
  } finally {
    await context.close();
  }
});

const CONVERSATION_ROWS: ConversationRow[] = [
  { href: "/i/chat/launch-room", name: "Launch room" },
  { href: "/i/chat/Team_Design-2026", name: "Team design 2026" },
  { href: "/i/chat/\u0000evil", name: "NUL link" },
  { href: "/i/chat/compose", name: "Compose" },
  { href: "/i/chat/", name: "Empty id" },
  { href: "/i/chat/abc/extra", name: "Extra segment" },
  { href: "/i/chat/launch-room", name: "Launch room (alt name)" },
  { href: "https://evil.example/i/chat/stolen", name: "Stolen" },
  { href: "/i/chat/query-conv?via=inbox", name: "Query conversation" },
  { href: "/i/chat/empty-name" },
  { href: "/i/chat/empty-name-2", name: "Real name later" },
  { href: "/i/lists/123456789", name: "A list" },
  { href: "/i/chat/dm-bob", name: "Bob DM" },
  { href: "/i/chat/aria-only", ariaLabel: "Aria conversation" },
  ...Array.from({ length: 10 }, (_, index) => ({
    href: `/i/chat/conv-${index + 14}`,
    name: `Conversation ${index + 14}`,
  })),
];

const EXPECTED_COLLECTED_HREFS = [
  "/i/chat/launch-room",
  "/i/chat/Team_Design-2026",
  "/i/chat/\u0000evil",
  "/i/chat/compose",
  "/i/chat/",
  "/i/chat/abc/extra",
  "/i/chat/query-conv?via=inbox",
  "/i/chat/empty-name",
  "/i/chat/empty-name-2",
  "/i/chat/dm-bob",
  "/i/chat/aria-only",
  ...Array.from({ length: 10 }, (_, index) => `/i/chat/conv-${index + 14}`),
];

const EXPECTED_CONVERSATION_FEEDS: AvailableFeed[] = [
  { externalId: "x:chat:aria-only", name: "Aria conversation", kind: "discussion" },
  { externalId: "x:chat:dm-bob", name: "Bob DM", kind: "discussion" },
  { externalId: "x:chat:empty-name", name: "Chat empty-name", kind: "discussion" },
  ...Array.from({ length: 10 }, (_, index): AvailableFeed => ({
    externalId: `x:chat:conv-${index + 14}`,
    name: `Conversation ${index + 14}`,
    kind: "discussion",
  })),
  { externalId: "x:chat:launch-room", name: "Launch room", kind: "discussion" },
  { externalId: "x:chat:query-conv", name: "Query conversation", kind: "discussion" },
  { externalId: "x:chat:empty-name-2", name: "Real name later", kind: "discussion" },
  { externalId: "x:chat:Team_Design-2026", name: "Team design 2026", kind: "discussion" },
];

test("virtualized conversation discovery enumerates named chats and ignores invalid and control links", async () => {
  const { context, page, requests } = await newHermeticPage();
  try {
    await installVirtualizer(page, "conversations", {
      rows: CONVERSATION_ROWS,
      rowHeight: 80,
      containerHeight: 400,
      initialTop: 0,
    });
    const waits = recordingWait(page);
    const extractRound = async (): Promise<XDomLink[]> => {
      await renderVirtualWindow(page);
      return await extractLinks(page, X_DOM.conversationLink);
    };

    const result = await collectVirtualizedItems(page, {
      itemSelector: X_DOM.conversationLink,
      direction: "down",
      extractRound,
      identityOf: (link: XDomLink) => link.href,
    }, undefined, waits.wait);

    assertEquals(result.stopReason, "boundary");
    assertStrictEquals(discoveryStopError(result.stopReason), null);
    // Candidate links are collected exactly once in window order; the
    // duplicate launch-room row is deduplicated by its href identity.
    assertEquals(result.items.map((link) => link.href), EXPECTED_COLLECTED_HREFS);
    assertEquals(
      waits.waits,
      [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1500, 2500, 4000],
    );
    assertEquals(await scrollLog(page), [240, 480, 720, 960, 1200, 1440, 1520]);
    assertEquals(await scrollerTop(page), 1520);
    assertEquals(await windowScrollY(page), 0);

    // Multiple named conversations are enumerated through the discovery
    // mapping; the fallback name, aria-label name, query-stripped href, and
    // duplicate resolution are all exercised on the collected window.
    assertEquals(
      mergeDiscoveredFeeds(toAvailableFeeds(result.items, "chat")),
      EXPECTED_CONVERSATION_FEEDS,
    );

    // The foreign-origin and list links never enter the collection: the
    // production selector excludes them, and mapping-level rejection of
    // cross-origin and cross-kind links is unit-covered separately.
    assertStrictEquals(
      result.items.some((link) => link.href === "https://evil.example/i/chat/stolen"),
      false,
    );
    assertStrictEquals(
      result.items.some((link) => link.href === "/i/lists/123456789"),
      false,
    );
    assertEquals(requests, []);
  } finally {
    await context.close();
  }
});

test("conversation discovery fails closed when a repeated window cannot be proven", async () => {
  const { context, page, requests } = await newHermeticPage();
  try {
    await installVirtualizer(page, "conversations", {
      rows: CONVERSATION_ROWS,
      rowHeight: 80,
      containerHeight: 400,
      initialTop: 0,
      stuck: true,
    });
    const waits = recordingWait(page);
    const extractRound = async (): Promise<XDomLink[]> => {
      await renderVirtualWindow(page);
      return await extractLinks(page, X_DOM.conversationLink);
    };

    const result = await collectVirtualizedItems(page, {
      itemSelector: X_DOM.conversationLink,
      direction: "down",
      extractRound,
      identityOf: (link: XDomLink) => link.href,
    }, undefined, waits.wait);

    assertEquals(result.stopReason, "no_progress");
    assertEquals(result.items.map((link) => link.href), [
      "/i/chat/launch-room",
      "/i/chat/Team_Design-2026",
      "/i/chat/\u0000evil",
      "/i/chat/compose",
      "/i/chat/",
    ]);
    assertEquals(waits.waits, [1000, 1500, 2500, 4000]);
    // Discovery treats an unproven window as a safety stop: the cursor
    // must never advance past an incomplete window.
    assertStrictEquals(
      discoveryStopError(result.stopReason)?.message,
      "X feed discovery reached a safety limit before completion",
    );
    assertEquals(requests, []);
  } finally {
    await context.close();
  }
});
