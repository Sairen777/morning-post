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
  /** Wrap every message row in a nearer scrollable decoy container. */
  decoyRows?: boolean;
  /** Wrap the scroller in a non-scrollable container that owns the Chat testid. */
  staticOuter?: boolean;
  /**
   * Re-pin programmatic scrolls back to the bottom unless a wheel-intent
   * signal preceded them, like X's auto-pinned DM list.
   */
  pinnedToBottom?: boolean;
  /**
   * Render every row once and never replace them, like X's accumulated DM
   * list: far-offscreen rows stay laid out with client rects, so extraction
   * must bound rounds by scroller geometry instead of relying on the
   * virtualizer's re-rendered window.
   */
  accumulated?: boolean;
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

const decoyTop = (page: Page) =>
  page.evaluate(() => document.querySelector<HTMLElement>(".decoy")?.scrollTop ?? 0);

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
    decoyRows = false,
    staticOuter = false,
    pinnedToBottom = false,
    accumulated = false,
  } = options;
  const totalHeight = rows.length * rowHeight;
  const scrollerTestId = 'data-testid="dm-message-scroller"';
  const scrollerElement = (testId: boolean) =>
    `<div id="scroller" ${testId ? scrollerTestId : ""} style="height:${containerHeight}px;overflow-y:auto;position:relative">
      <div id="spacer" style="position:relative;height:${totalHeight}px"><div id="virtual-window"></div></div>
    </div>`;
  const scroller = staticOuter
    ? `<div id="static-outer" ${scrollerTestId} style="overflow:visible">
        ${scrollerElement(false)}
      </div>`
    : outerHeight > 0
      ? `<div id="outer" style="height:${outerHeight}px;overflow-y:scroll">
          ${scrollerElement(true)}
          <div style="height:800px"></div>
        </div>`
      : scrollerElement(true);

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
  <svg data-testid="svg-scroller" aria-hidden="true" style="display:none"></svg>
  <div style="height:2000px" aria-hidden="true"></div>
  <script>
    (() => {
      const rows = ${JSON.stringify(rows)};
      const kind = ${JSON.stringify(kind)};
      const rowHeight = ${rowHeight};
      const containerHeight = ${containerHeight};
      const stuck = ${stuck};
      const decoyRows = ${decoyRows};
      const pinnedToBottom = ${pinnedToBottom};
      const accumulated = ${accumulated};
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
      const render = accumulated
        ? () => {}
        : () => {
            const top = scroller.scrollTop;
            const first = Math.max(0, Math.floor(top / rowHeight));
            const last = Math.min(rows.length - 1, Math.floor((top + containerHeight - 1) / rowHeight));
            const fragment = document.createDocumentFragment();
            for (let index = first; index <= last; index += 1) {
              const row = makeRow(rows[index], index);
              if (decoyRows && kind === "messages") {
                // A scrollable decoy nearer to the row than the real scroller:
                // the legacy ancestor walk picks it up and scrolls it instead
                // of the message scroller, exactly like the live X failure.
                // The decoy is pre-scrolled into the middle of tall content so
                // every upward advance genuinely moves it for many rounds.
                const wrap = document.createElement("div");
                wrap.className = "decoy";
                wrap.style.position = "absolute";
                wrap.style.top = index * rowHeight + "px";
                wrap.style.left = "0";
                wrap.style.right = "0";
                wrap.style.height = "100px";
                wrap.style.overflowY = "auto";
                row.style.position = "static";
                row.style.top = "0px";
                const fillerTop = document.createElement("div");
                fillerTop.style.height = "5000px";
                const fillerBottom = document.createElement("div");
                fillerBottom.style.height = "5000px";
                wrap.append(fillerTop, row, fillerBottom);
                fragment.append(wrap);
              } else {
                fragment.append(row);
              }
            }
            windowEl.replaceChildren(fragment);
            if (decoyRows && kind === "messages") {
              const decoys = windowEl.querySelectorAll(".decoy");
              for (let decoyIndex = 0; decoyIndex < decoys.length; decoyIndex += 1) {
                decoys[decoyIndex].scrollTop = 5000;
              }
            }
          };
      void scroller.offsetHeight;
      scroller.scrollTop = ${initialTop};
      window.__render = stuck ? () => {} : render;
      scroller.addEventListener("scroll", () => {
        log.push(scroller.scrollTop);
        if (!stuck) render();
      });
      if (pinnedToBottom) {
        // X re-pins a programmatically scrolled DM list to the bottom; a
        // wheel event is the only signal that treats the movement as
        // user-initiated and leaves it in place.
        let wheelIntent = false;
        scroller.addEventListener("wheel", () => {
          wheelIntent = true;
        });
        scroller.addEventListener("scroll", () => {
          if (wheelIntent) {
            wheelIntent = false;
            return;
          }
          const maxScroll = scroller.scrollHeight - scroller.clientHeight;
          if (Math.abs(scroller.scrollTop - maxScroll) > 1) {
            scroller.scrollTop = maxScroll;
          }
        });
      }
      if (accumulated) {
        // The full accumulated list stays laid out, exactly like X's tall
        // DM list: extraction must bound rounds by scroller geometry rather
        // than by what a virtualizer re-rendered.
        const fragment = document.createDocumentFragment();
        for (let index = 0; index < rows.length; index += 1) {
          fragment.append(makeRow(rows[index], index));
        }
        windowEl.replaceChildren(fragment);
      }
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

test("real-DOM Chat edge wheel intent loads and collects an older full-fit page", async () => {
  const { context, page, requests } = await newHermeticPage();
  try {
    await page.setContent(`
      <main role="main">
        <div data-testid="dm-message-scroller" id="edge-loader"
             style="height:200px;overflow-y:auto;width:420px;">
          <section data-testid="messageEntry" data-message-id="m-2" style="height:100px;">
            <time datetime="2026-08-01T00:02:00.000Z"></time>
            <p data-testid="messageText">message 2 text</p>
          </section>
          <section data-testid="messageEntry" data-message-id="m-3" style="height:100px;">
            <time datetime="2026-08-01T00:03:00.000Z"></time>
            <p data-testid="messageText">message 3 text</p>
          </section>
        </div>
      </main>
      <script>
        (() => {
          const scroller = document.querySelector("#edge-loader");
          window.__edgeWheelCount = 0;
          let loaded = false;
          scroller.addEventListener("wheel", (event) => {
            window.__edgeWheelCount += 1;
            if (loaded || event.deltaY >= 0) return;
            loaded = true;
            scroller.insertAdjacentHTML("afterbegin", \`
              <section data-testid="messageEntry" data-message-id="m-0" style="height:100px;">
                <time datetime="2026-08-01T00:00:00.000Z"></time>
                <p data-testid="messageText">message 0 text</p>
              </section>
              <section data-testid="messageEntry" data-message-id="m-1" style="height:100px;">
                <time datetime="2026-08-01T00:01:00.000Z"></time>
                <p data-testid="messageText">message 1 text</p>
              </section>
            \`);
          });
        })();
      </script>
    `);
    const waits = recordingWait(page);

    const result = await collectVirtualizedItems(page, {
      itemSelector: X_DOM.chatMessage,
      direction: "up",
      mergeOverlappingWindows: true,
      scrollerSelector: X_DOM.chatMessageScroller,
      dispatchWheelIntent: true,
      extractRound: async () => await extractChatMessages(page),
      identityOf: chatIdentity,
      identityIsStable: (item: XDomChatMessage) => item.platformId !== null,
    }, undefined, waits.wait);

    assertEquals(result.stopReason, "boundary");
    assertEquals(result.items.map((item) => item.platformId), [
      "m-2", "m-3", "m-0", "m-1",
    ]);
    assertEquals(
      await page.evaluate(
        () => (window as unknown as { __edgeWheelCount: number }).__edgeWheelCount > 0,
      ),
      true,
    );
    await requireCompleteCollection(page, chatTarget, result.stopReason);
    assertEquals(requests, []);
  } finally {
    await context.close();
  }
});

test("first wheel intent on a deciding Chat edge settles before boundary proof", async () => {
  const { context, page, requests } = await newHermeticPage();
  try {
    const rows = Array.from(
      { length: 12 },
      (_, index) =>
        `<section data-testid="messageEntry" data-message-id="dom-${index}" style="height:100px;"></section>`,
    ).join("");
    await page.setContent(`
      <main role="main">
        <div data-testid="dm-message-scroller" id="deciding-edge"
             style="height:200px;overflow-y:auto;width:420px;">
          ${rows}
        </div>
      </main>
      <script>
        (() => {
          const scroller = document.querySelector("#deciding-edge");
          scroller.dataset.loaded = "false";
          scroller.scrollTop = 960;
          scroller.addEventListener("wheel", (event) => {
            if (
              scroller.dataset.loaded === "false" &&
              scroller.scrollTop <= 1 &&
              event.deltaY < 0
            ) {
              scroller.dataset.loaded = "true";
            }
          });
        })();
      </script>
    `);
    const waits = recordingWait(page);
    const anchor: XDomChatMessage = {
      platformId: "anchor",
      date: Date.parse("2026-08-01T00:01:00.000Z"),
      text: "anchor",
      author: null,
      reactions: [],
    };
    const older: XDomChatMessage = {
      platformId: "older",
      date: Date.parse("2026-08-01T00:00:00.000Z"),
      text: "older",
      author: null,
      reactions: [],
    };

    const result = await collectVirtualizedItems(page, {
      itemSelector: X_DOM.chatMessage,
      direction: "up",
      mergeOverlappingWindows: true,
      scrollerSelector: X_DOM.chatMessageScroller,
      dispatchWheelIntent: true,
      extractRound: async () => {
        const loaded = await page.evaluate(
          () => document.querySelector<HTMLElement>("#deciding-edge")?.dataset["loaded"] === "true",
        );
        return loaded ? [older, anchor] : [anchor];
      },
      identityOf: chatIdentity,
      identityIsStable: (item: XDomChatMessage) => item.platformId !== null,
    }, undefined, waits.wait);

    assertEquals(result.stopReason, "boundary");
    assertEquals(result.items.map((item) => item.platformId), ["anchor", "older"]);
    assertEquals(
      await page.evaluate(
        () => document.querySelector<HTMLElement>("#deciding-edge")?.dataset["loaded"],
      ),
      "true",
    );
    await requireCompleteCollection(page, chatTarget, result.stopReason);
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

    // The deciding probe's scrollBy returns before its scroll event is
    // dispatched: flush one event turn so the last advancement is logged
    // before asserting the scroll history.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );

    assertEquals(result.stopReason, "no_progress");
    assertEquals(result.items.map((item) => item.platformId), [
      "m-16", "m-17", "m-18", "m-19",
    ]);
    assertEquals(waits.waits, [1000, 1500, 2500, 4000]);
    // The threshold round issues one deciding probe: it moves the window
    // again, so the collection fails closed as no_progress on that fifth
    // advance instead of certifying a boundary.
    assertEquals(await scrollLog(page), [1360, 1120, 880, 640, 400]);
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

test("explicit Chat scroller mode moves the real message scroller past a nearer nested decoy and proves the top boundary", async () => {
  const { context, page, requests } = await newHermeticPage();
  try {
    // Every row lives inside a scrollable decoy nearer to it than the
    // real message scroller, so the legacy ancestor walk scrolls the
    // decoy and the rendered window never changes (the live X failure).
    await installVirtualizer(page, "messages", {
      rows: chatRows(20),
      rowHeight: 100,
      containerHeight: 400,
      initialTop: 1600,
      decoyRows: true,
    });
    const waits = recordingWait(page);

    const result = await collectVirtualizedItems(page, {
      itemSelector: X_DOM.chatMessage,
      direction: "up",
      mergeOverlappingWindows: true,
      scrollerSelector: X_DOM.chatMessageScroller,
      extractRound: chatExtractRound(page),
      identityOf: chatIdentity,
      identityIsStable: (item: XDomChatMessage) => item.platformId !== null,
    }, undefined, waits.wait);

    // The exact configured scroller moves with the same deterministic
    // half-viewport log as the decoy-free fixture and proves its own top.
    assertEquals(result.stopReason, "boundary");
    assertEquals(result.items.length, 20);
    assertStrictEquals(
      new Set(result.items.map((item) => item.platformId)).size,
      result.items.length,
    );
    assertEquals(await scrollLog(page), [1360, 1120, 880, 640, 400, 160, 0]);
    assertEquals(await scrollerTop(page), 0);
    // The misleading decoy stays exactly where the fixture put it: the
    // explicit mode never touches a nearer nested scrollable container.
    assertEquals(await decoyTop(page), 5000);
    assertEquals(await windowScrollY(page), 0);
    await requireCompleteCollection(page, chatTarget, "boundary");
    assertEquals(requests, []);
  } finally {
    await context.close();
  }
});

test("without the explicit option a nearer nested decoy hijacks the ancestor walk and collection fails closed", async () => {
  const { context, page, requests } = await newHermeticPage();
  try {
    await installVirtualizer(page, "messages", {
      rows: chatRows(20),
      rowHeight: 100,
      containerHeight: 400,
      initialTop: 1600,
      decoyRows: true,
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

    // The decoy moved but the real scroller never did: the same 18-UUID
    // window repeats and the collection refuses to certify a boundary.
    assertEquals(result.stopReason, "no_progress");
    assertEquals(result.items.map((item) => item.platformId), [
      "m-16", "m-17", "m-18", "m-19",
    ]);
    assertEquals(await scrollLog(page), []);
    assertStrictEquals((await decoyTop(page)) > 0, true);
    assertEquals(await scrollerTop(page), 1600);
    assertEquals(requests, []);
  } finally {
    await context.close();
  }
});

test("explicit Chat wheel intent keeps the real scroller moved past an app auto-pin listener and still proves the boundary", async () => {
  const { context, page, requests } = await newHermeticPage();
  try {
    // The fixture re-pins any programmatic scroll back to the bottom
    // unless a wheel-intent signal preceded it, like X's DM list.
    await installVirtualizer(page, "messages", {
      rows: chatRows(20),
      rowHeight: 100,
      containerHeight: 400,
      initialTop: 1600,
      pinnedToBottom: true,
    });
    const waits = recordingWait(page);

    const result = await collectVirtualizedItems(page, {
      itemSelector: X_DOM.chatMessage,
      direction: "up",
      mergeOverlappingWindows: true,
      scrollerSelector: X_DOM.chatMessageScroller,
      dispatchWheelIntent: true,
      extractRound: chatExtractRound(page),
      identityOf: chatIdentity,
      identityIsStable: (item: XDomChatMessage) => item.platformId !== null,
    }, undefined, waits.wait);

    assertEquals(result.stopReason, "boundary");
    assertEquals(result.items.length, 20);
    assertStrictEquals(
      new Set(result.items.map((item) => item.platformId)).size,
      result.items.length,
    );
    assertEquals(await scrollLog(page), [1360, 1120, 880, 640, 400, 160, 0]);
    assertEquals(await scrollerTop(page), 0);
    await requireCompleteCollection(page, chatTarget, "boundary");
    assertEquals(requests, []);
  } finally {
    await context.close();
  }
});

test("without wheel intent an app auto-pin listener re-pins the explicit scroller and collection fails closed", async () => {
  const { context, page, requests } = await newHermeticPage();
  try {
    await installVirtualizer(page, "messages", {
      rows: chatRows(20),
      rowHeight: 100,
      containerHeight: 400,
      initialTop: 1600,
      pinnedToBottom: true,
    });
    const waits = recordingWait(page);

    const result = await collectVirtualizedItems(page, {
      itemSelector: X_DOM.chatMessage,
      direction: "up",
      mergeOverlappingWindows: true,
      scrollerSelector: X_DOM.chatMessageScroller,
      extractRound: chatExtractRound(page),
      identityOf: chatIdentity,
      identityIsStable: (item: XDomChatMessage) => item.platformId !== null,
    }, undefined, waits.wait);

    // The deciding probe's scrollBy returns before its scroll event is
    // dispatched, and the app's pin listener runs on that event: flush one
    // event turn so the re-pin has landed before asserting the scrollTop.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );

    // Each programmatic jump is measured as moved synchronously but the
    // app pins the scroller straight back to the bottom, so the same
    // window repeats and no boundary is certified.
    assertEquals(result.stopReason, "no_progress");
    assertEquals(result.items.map((item) => item.platformId), [
      "m-16", "m-17", "m-18", "m-19",
    ]);
    assertEquals(await scrollerTop(page), 1600);
    assertEquals(requests, []);
  } finally {
    await context.close();
  }
});

test("accumulated tall Chat list bounds rounds by scroller geometry and proves a wholly-old round", async () => {
  const { context, page, requests } = await newHermeticPage();
  try {
    // The separator calendar days resolve in the page while the extractor
    // constructs dates in the test process, which bun test pins to UTC:
    // rows and the cutoff are UTC constructions of the page-resolved
    // calendar days, so the assertions hold at any hour and timezone.
    const pageDays = await page.evaluate(() => {
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      return {
        today: { year: today.getFullYear(), month: today.getMonth(), day: today.getDate() },
        yesterday: { year: yesterday.getFullYear(), month: yesterday.getMonth(), day: yesterday.getDate() },
      };
    });
    const dayEpoch = (day: { year: number; month: number; day: number }, hours: number, minutes: number) =>
      Date.UTC(day.year, day.month, day.day, hours, minutes);
    // 310 rows of 100px in a 900px scroller: a 31,000px fully laid-out
    // accumulated list (the live X DM list accumulates ~192,705px). The
    // oldest 20 rows are yesterday and the rest are today, so only the
    // oldest rounds can satisfy a today-midnight cutoff, and the laid-out
    // Today block many viewports below must never enter them. The yesterday
    // block is 20 rows so the wholly-old proof only exists for a 0.5x
    // overscan: the first round whose whole window falls before the cutoff
    // sits at scrollTop 400, where the 1,800px window spans rows 0..17.
    // A 1.5x overscan window (3,600px) always reaches a today row, so the
    // condition could never fire and the collection would fail closed as
    // no_progress at the top instead of certifying the wholly-old round.
    const rows: MessageRow[] = Array.from({ length: 310 }, (_, index) => ({
      id: `m-${index}`,
      sender: index % 2 === 0 ? "Alice" : "Bob",
      text: `message ${index} text`,
      date: new Date(
        index < 20
          ? dayEpoch(pageDays.yesterday, 8, index)
          : dayEpoch(pageDays.today, 0, 30 + index),
      ).toISOString(),
    }));
    await installVirtualizer(page, "messages", {
      rows,
      rowHeight: 100,
      containerHeight: 900,
      initialTop: rows.length * 100 - 900,
      accumulated: true,
    });
    const waits = recordingWait(page);
    const cutoff = dayEpoch(pageDays.today, 0, 0);

    const result = await collectVirtualizedItems(page, {
      itemSelector: X_DOM.chatMessage,
      direction: "up",
      mergeOverlappingWindows: true,
      scrollerSelector: X_DOM.chatMessageScroller,
      extractRound: chatExtractRound(page),
      identityOf: chatIdentity,
      identityIsStable: (item: XDomChatMessage) => item.platformId !== null,
      shouldStop: (roundItems: XDomChatMessage[]) => {
        if (roundItems.length === 0) return false;
        return roundItems.every((item) =>
          item.date !== null && Number.isFinite(item.date) && item.date < cutoff,
        );
      },
    }, undefined, waits.wait);

    // The old round becomes wholly before the cutoff even though the whole
    // 31,000px list stays rendered below it.
    assertEquals(result.stopReason, "condition");
    // Every laid-out row is collected exactly once: adjacent half-viewport
    // rounds retain the shared visible rows (no duplicates, no gaps) even
    // though far-offscreen rows keep reporting client rects.
    assertEquals(result.items.length, 310);
    assertStrictEquals(
      new Set(result.items.map((item) => item.platformId)).size,
      result.items.length,
    );
    // Round windows are bounded to the scroller overscan: the first round
    // spans the bottom viewport plus 0.5x overscan (the 1,800px window
    // reaches 550px above the viewport top, so rows 296..309 are the first
    // fourteen), and the oldest rows arrive last in ascending order.
    assertEquals(result.items[0]!.platformId, "m-296");
    assertEquals(
      result.items.slice(-3).map((item) => item.platformId),
      ["m-0", "m-1", "m-2"],
    );
    // Every round up to the wholly-old stop is productive and settles for
    // 1000ms: the condition fires on the round at scrollTop 400 before any
    // no-new backoff, so no 1500ms wait ever runs.
    assertEquals(waits.waits.length, 66);
    assertEquals(waits.waits.filter((wait) => wait === 1000).length, 66);
    assertEquals(waits.waits[waits.waits.length - 1], 1000);
    // Deterministic half-viewport advances stop one step above the top.
    const log = await scrollLog(page);
    assertEquals(log.length, 66);
    assertEquals(log[0], rows.length * 100 - 900 - 450);
    assertEquals(log[log.length - 1], 400);
    assertEquals(await scrollerTop(page), 400);
    assertEquals(await windowScrollY(page), 0);
    await requireCompleteCollection(page, chatTarget, "condition");
    assertEquals(requests, []);
  } finally {
    await context.close();
  }
});

test("accumulated short Chat list certifies the real top boundary instead of four moved no-new rounds", async () => {
  const { context, page, requests } = await newHermeticPage();
  try {
    // 24 rows of 100px in a 900px scroller, fully laid out (accumulated) and
    // parked at the bottom (scrollTop 1500). The 0.5x overscan window is
    // 1,800px, so the first round spans rows 10..23, and each half-viewport
    // advance surfaces the strip just beyond the prior window (rows 5..9,
    // then 1..4, then 0). With the old 1.5x overscan the 3,600px window
    // pre-collected all 24 rows in the first round: the four moves up
    // produced four moved no-new rounds and the generic no_progress guard
    // fired before the non-moving top-boundary probe could certify the real
    // top. The 0.5x window keeps every move productive until the scroller
    // reaches its own top, where the boundary probe certifies it.
    await installVirtualizer(page, "messages", {
      rows: chatRows(24),
      rowHeight: 100,
      containerHeight: 900,
      initialTop: 24 * 100 - 900,
      accumulated: true,
    });
    const waits = recordingWait(page);

    const result = await collectVirtualizedItems(page, {
      itemSelector: X_DOM.chatMessage,
      direction: "up",
      mergeOverlappingWindows: true,
      scrollerSelector: X_DOM.chatMessageScroller,
      extractRound: chatExtractRound(page),
      identityOf: chatIdentity,
      identityIsStable: (item: XDomChatMessage) => item.platformId !== null,
    }, undefined, waits.wait);

    // The scroller's own top is reached and certified, not a no_progress
    // false positive from pre-collected rows.
    assertEquals(result.stopReason, "boundary");
    // Every laid-out row is collected exactly once, each introduced by the
    // round whose window first reached it.
    assertEquals(result.items.map((item) => item.platformId), [
      "m-10", "m-11", "m-12", "m-13", "m-14", "m-15", "m-16", "m-17",
      "m-18", "m-19", "m-20", "m-21", "m-22", "m-23",
      "m-5", "m-6", "m-7", "m-8", "m-9",
      "m-1", "m-2", "m-3", "m-4",
      "m-0",
    ]);
    assertStrictEquals(
      new Set(result.items.map((item) => item.platformId)).size,
      result.items.length,
    );
    // Each of the four half-viewport advances moved and every round up to
    // the top surfaced new identities; the boundary stall then backs off
    // with escalating no-new waits before the final non-moving probe.
    assertEquals(waits.waits, [1000, 1000, 1000, 1000, 1500, 2500, 4000]);
    // The four advances land at 1050, 600, 150, and 0 — the real top.
    assertEquals(await scrollLog(page), [1050, 600, 150, 0]);
    assertEquals(await scrollerTop(page), 0);
    assertEquals(await windowScrollY(page), 0);
    await requireCompleteCollection(page, chatTarget, "boundary");
    assertEquals(requests, []);
  } finally {
    await context.close();
  }
});

test("explicit Chat scroller mode fails closed when the configured scroller is missing", async () => {
  const { context, page, requests } = await newHermeticPage();
  try {
    await installVirtualizer(page, "messages", {
      rows: chatRows(20),
      rowHeight: 100,
      containerHeight: 400,
      initialTop: 1600,
    });
    const waits = recordingWait(page);

    await assertRejects(
      () => collectVirtualizedItems(page, {
        itemSelector: X_DOM.chatMessage,
        direction: "up",
        scrollerSelector: '[data-testid="missing-dm-scroller"]',
        extractRound: chatExtractRound(page),
        identityOf: chatIdentity,
      }, undefined, waits.wait),
      Error,
      "matched no element",
    );
    assertEquals(requests, []);
  } finally {
    await context.close();
  }
});

test("explicit Chat scroller mode fails closed when the configured selector is non-unique", async () => {
  const { context, page, requests } = await newHermeticPage();
  try {
    await installVirtualizer(page, "messages", {
      rows: chatRows(20),
      rowHeight: 100,
      containerHeight: 400,
      initialTop: 1600,
    });
    const waits = recordingWait(page);

    await assertRejects(
      () => collectVirtualizedItems(page, {
        itemSelector: X_DOM.chatMessage,
        direction: "up",
        scrollerSelector: X_DOM.chatMessage,
        extractRound: chatExtractRound(page),
        identityOf: chatIdentity,
      }, undefined, waits.wait),
      Error,
      "expected exactly one",
    );
    assertEquals(requests, []);
  } finally {
    await context.close();
  }
});

test("explicit Chat scroller mode fails closed when the configured selector matches a non-HTMLElement", async () => {
  const { context, page, requests } = await newHermeticPage();
  try {
    await installVirtualizer(page, "messages", {
      rows: chatRows(20),
      rowHeight: 100,
      containerHeight: 400,
      initialTop: 1600,
    });
    const waits = recordingWait(page);

    await assertRejects(
      () => collectVirtualizedItems(page, {
        itemSelector: X_DOM.chatMessage,
        direction: "up",
        scrollerSelector: '[data-testid="svg-scroller"]',
        extractRound: chatExtractRound(page),
        identityOf: chatIdentity,
      }, undefined, waits.wait),
      Error,
      "non-HTMLElement",
    );
    assertEquals(requests, []);
  } finally {
    await context.close();
  }
});

test("explicit Chat scroller mode fails closed when the configured element cannot scroll the rendered items", async () => {
  const { context, page, requests } = await newHermeticPage();
  try {
    // The configured testid lives on a non-scrollable wrapper while a
    // nested element actually scrolls the messages: certifying a boundary
    // here would silently drop the rest of the conversation.
    await installVirtualizer(page, "messages", {
      rows: chatRows(20),
      rowHeight: 100,
      containerHeight: 400,
      initialTop: 1600,
      staticOuter: true,
    });
    const waits = recordingWait(page);

    await assertRejects(
      () => collectVirtualizedItems(page, {
        itemSelector: X_DOM.chatMessage,
        direction: "up",
        scrollerSelector: X_DOM.chatMessageScroller,
        extractRound: chatExtractRound(page),
        identityOf: chatIdentity,
      }, undefined, waits.wait),
      Error,
      "nested element actually scrolls the items",
    );
    assertEquals(requests, []);
  } finally {
    await context.close();
  }
});

// Statically laid-out rows for the scroller-ownership regressions below:
// the fixtures exercise the explicit-scroller validation itself, so they
// use a plain [data-message-id] selector instead of the Chat DOM.
function staticRows(count: number, startIndex: number, top: number): string {
  const rows: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `m-${startIndex + index}`;
    rows.push(
      `<section data-message-id="${id}" style="position:absolute;top:${top + index * 100}px;left:0;right:0;height:100px;box-sizing:border-box"></section>`,
    );
  }
  return rows.join("");
}

const idsRound = (page: Page) => async (): Promise<{ id: string }[]> =>
  page.locator("[data-message-id]").evaluateAll((elements) =>
    elements.map((element) => ({
      id: element.getAttribute("data-message-id") ?? "",
    })),
  );

test("explicit Chat scroller mode fails closed when a configured auto scroller at its own edge does not contain the rendered items", async () => {
  const { context, page, requests } = await newHermeticPage();
  try {
    // The configured testid sits on an unrelated auto scroller parked at
    // its own bottom edge while the rows live in a different container:
    // the old code returned false at the unrelated edge before any
    // containment check and certified a boundary over a partial window.
    await page.setContent(`
<!doctype html>
<html><head><style>body{margin:0}</style></head><body>
  <div id="other" data-testid="dm-message-scroller" style="height:400px;overflow-y:auto">
    <div style="height:2000px"></div>
  </div>
  <div id="real" style="height:400px;overflow-y:auto;position:relative">
    <div style="position:relative;height:2000px">
      ${staticRows(20, 0, 0)}
    </div>
  </div>
  <script>
    document.getElementById("other").scrollTop = 1600;
  </script>
</body></html>
    `);
    const waits = recordingWait(page);

    await assertRejects(
      () => collectVirtualizedItems(page, {
        itemSelector: "[data-message-id]",
        direction: "down",
        scrollerSelector: '[data-testid="dm-message-scroller"]',
        extractRound: idsRound(page),
        identityOf: (item: { id: string }) => item.id,
      }, undefined, waits.wait),
      Error,
      "does not contain the rendered items",
    );
    assertEquals(requests, []);
  } finally {
    await context.close();
  }
});

test("explicit Chat scroller mode proves the boundary at a configured auto scroller's own edge even when a nested element actually scrolls the rows", async () => {
  const { context, page, requests } = await newHermeticPage();
  try {
    // The configured testid sits on an outer auto scroller parked at its
    // own bottom edge; the rows are rendered inside a nested element that
    // actually scrolls them. The configured element's positive auto/scroll
    // range makes it the validated owner, so its real edge is the boundary
    // proof and the nested scroller is overridden exactly like a decoy.
    await page.setContent(`
<!doctype html>
<html><head><style>body{margin:0}</style></head><body>
  <div id="outer" data-testid="dm-message-scroller" style="height:400px;overflow-y:auto">
    <div id="real" style="height:2000px;overflow-y:auto;position:relative">
      <div style="position:relative;height:3000px">
        ${staticRows(20, 1, 100)}
      </div>
    </div>
  </div>
  <script>
    document.getElementById("outer").scrollTop = 1600;
  </script>
</body></html>
    `);
    const waits = recordingWait(page);

    const result = await collectVirtualizedItems(page, {
      itemSelector: "[data-message-id]",
      direction: "down",
      scrollerSelector: '[data-testid="dm-message-scroller"]',
      extractRound: idsRound(page),
      identityOf: (item: { id: string }) => item.id,
    }, undefined, waits.wait);

    // The outer never moves (it is already at its own bottom edge) and its
    // real edge is the boundary proof; the nested scroller stays untouched.
    assertEquals(result.stopReason, "boundary");
    assertEquals(
      result.items.map((item) => item.id),
      Array.from({ length: 20 }, (_, index) => `m-${index + 1}`),
    );
    assertEquals(
      await page.evaluate(() => document.querySelector<HTMLElement>("#outer")?.scrollTop ?? 0),
      1600,
    );
    assertEquals(
      await page.evaluate(() => document.querySelector<HTMLElement>("#real")?.scrollTop ?? 0),
      0,
    );
    assertEquals(requests, []);
  } finally {
    await context.close();
  }
});

for (const overflow of ["hidden", "clip", "visible"] as const) {
  test(`explicit Chat scroller mode fails closed when a configured element overflows without auto/scroll overflow (overflow-y: ${overflow})`, async () => {
    const { context, page, requests } = await newHermeticPage();
    try {
      // The configured element's content overflows (range > 2) but its
      // overflow never scrolls: the old code treated this as a full-fit
      // boundary and certified a partial window.
      await page.setContent(`
<!doctype html>
<html><head><style>body{margin:0}</style></head><body>
  <div data-testid="dm-message-scroller" style="height:400px;overflow-y:${overflow};position:relative">
    <div style="position:relative;height:2000px">
      ${staticRows(20, 0, 0)}
    </div>
  </div>
</body></html>
      `);
      const waits = recordingWait(page);

      await assertRejects(
        () => collectVirtualizedItems(page, {
          itemSelector: "[data-message-id]",
          direction: "down",
          scrollerSelector: '[data-testid="dm-message-scroller"]',
          extractRound: idsRound(page),
          identityOf: (item: { id: string }) => item.id,
        }, undefined, waits.wait),
        Error,
        "unusable scroller",
      );
      assertEquals(requests, []);
    } finally {
      await context.close();
    }
  });
}

test("explicit Chat scroller mode still proves a full-fit boundary for a validated non-scrolling owner", async () => {
  const { context, page, requests } = await newHermeticPage();
  try {
    // Every row fits inside the configured scroller (range 0): a genuine
    // full-fit boundary, validated by containment and the absence of a
    // nested scroller.
    await page.setContent(`
<!doctype html>
<html><head><style>body{margin:0}</style></head><body>
  <div data-testid="dm-message-scroller" style="height:400px;overflow-y:auto;position:relative">
    ${staticRows(4, 0, 0)}
  </div>
</body></html>
    `);
    const waits = recordingWait(page);

    const result = await collectVirtualizedItems(page, {
      itemSelector: "[data-message-id]",
      direction: "up",
      scrollerSelector: '[data-testid="dm-message-scroller"]',
      extractRound: idsRound(page),
      identityOf: (item: { id: string }) => item.id,
    }, undefined, waits.wait);

    assertEquals(result.stopReason, "boundary");
    assertEquals(result.items.map((item) => item.id), ["m-0", "m-1", "m-2", "m-3"]);
    assertEquals(waits.waits, [1000, 1500, 2500, 4000]);
    assertEquals(requests, []);
  } finally {
    await context.close();
  }
});

test("explicit Chat scroller mode still proves the owned top edge of the real scroller", async () => {
  const { context, page, requests } = await newHermeticPage();
  try {
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
      scrollerSelector: X_DOM.chatMessageScroller,
      extractRound: chatExtractRound(page),
      identityOf: chatIdentity,
      identityIsStable: (item: XDomChatMessage) => item.platformId !== null,
    }, undefined, waits.wait);

    // The validated owner advances with the deterministic half-viewport
    // log and its own real top proves the boundary.
    assertEquals(result.stopReason, "boundary");
    assertEquals(result.items.length, 20);
    assertStrictEquals(
      new Set(result.items.map((item) => item.platformId)).size,
      result.items.length,
    );
    assertEquals(await scrollLog(page), [1360, 1120, 880, 640, 400, 160, 0]);
    assertEquals(await scrollerTop(page), 0);
    assertEquals(await windowScrollY(page), 0);
    await requireCompleteCollection(page, chatTarget, "boundary");
    assertEquals(requests, []);
  } finally {
    await context.close();
  }
});

test("real-DOM moved no-new rounds prove a boundary when the deciding top-edge probe does not move", async () => {
  const { context, page, requests } = await newHermeticPage();
  try {
    // 40 rows of 100px in a 900px accumulated scroller starting 500px
    // from the top: the first rounds move the validated scroller upward
    // while the viewport-bounded windows add nothing new, then the
    // threshold round's deciding probe lands on the exact top edge and
    // does not move, so the boundary is proven.
    await installVirtualizer(page, "messages", {
      rows: chatRows(40),
      rowHeight: 100,
      containerHeight: 900,
      initialTop: 500,
      accumulated: true,
    });
    const waits = recordingWait(page);

    const result = await collectVirtualizedItems(page, {
      itemSelector: X_DOM.chatMessage,
      direction: "up",
      mergeOverlappingWindows: true,
      scrollerSelector: X_DOM.chatMessageScroller,
      extractRound: chatExtractRound(page),
      identityOf: chatIdentity,
      identityIsStable: (item: XDomChatMessage) => item.platformId !== null,
    }, undefined, waits.wait);

    // The accumulated list is collected once from the topmost window; the
    // following moved rounds add nothing new, and the deciding probe on
    // the exact top edge proves the boundary.
    assertEquals(result.stopReason, "boundary");
    assertEquals(result.items[0]!.platformId, "m-0");
    assertStrictEquals(
      new Set(result.items.map((item) => item.platformId)).size,
      result.items.length,
    );
    // Two half-viewport advances (500 -> 50 -> 0) produce the only scroll
    // events; every later probe lands on the exact top edge and stays put.
    assertEquals(await scrollLog(page), [50, 0]);
    assertEquals(await scrollerTop(page), 0);
    assertEquals(await windowScrollY(page), 0);
    assertEquals(waits.waits, [1000, 1500, 2500, 4000]);
    await requireCompleteCollection(page, chatTarget, "boundary");
    assertEquals(requests, []);
  } finally {
    await context.close();
  }
});

test("real-DOM deciding probe correcting an async top-reflow offset still proves the boundary on the next probe", async () => {
  const { context, page, requests } = await newHermeticPage();
  try {
    // The fixture drifts the accumulated scroller 120px away from the real
    // top (an async reflow offset with the same rows) on the first three
    // scrolls that land on the top edge. The threshold round's deciding
    // probe corrects the third drift back to 0: it reached the real edge,
    // so the collection settles and lets the next round extract the edge
    // window, whose deciding probe no longer moves: boundary.
    await page.setContent(`
<!doctype html>
<html><head><style>body{margin:0}</style></head><body>
<main>
  <div id="scroller" data-testid="dm-message-scroller" style="height:900px;overflow-y:auto;position:relative">
    <div style="position:relative;height:4000px">
      ${staticRows(40, 0, 0)}
    </div>
  </div>
</main>
<script>
  const scroller = document.getElementById("scroller");
  const log = (window.__scrollLog = []);
  let drifts = 0;
  scroller.addEventListener("scroll", () => {
    log.push(scroller.scrollTop);
    if (scroller.scrollTop === 0 && drifts < 3) {
      drifts += 1;
      scroller.scrollTop = 120;
    }
  });
  scroller.scrollTop = 500;
</script>
</body></html>
    `);
    // Flush the initial scroll assignment's queued event and clear the
    // log so only production-driven scrolls are recorded.
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
    const waits = recordingWait(page);

    const result = await collectVirtualizedItems(page, {
      itemSelector: "[data-message-id]",
      direction: "up",
      scrollerSelector: '[data-testid="dm-message-scroller"]',
      extractRound: idsRound(page),
      identityOf: (item: { id: string }) => item.id,
    }, undefined, waits.wait);

    // All 40 rows are collected on the first round; the moved no-new
    // rounds and the deciding probes add nothing, and the final deciding
    // probe lands on the real top edge without moving.
    assertEquals(result.stopReason, "boundary");
    assertEquals(result.items.length, 40);
    assertEquals(result.items[0]!.id, "m-0");
    assertStrictEquals(
      new Set(result.items.map((item) => item.id)).size,
      result.items.length,
    );
    // One half-viewport advance (500 -> 50), then four top-edge landings
    // each logging 0; the first three are followed by the 120px async
    // reflow drift. The deciding probe's landing is the last event, and
    // the next deciding probe does not move.
    assertEquals(await scrollLog(page), [50, 0, 120, 0, 120, 0, 120, 0]);
    assertEquals(await scrollerTop(page), 0);
    assertEquals(await windowScrollY(page), 0);
    // The edge-reaching deciding probe settles at the max no-new backoff
    // before the next round extracts the edge window.
    assertEquals(waits.waits, [1000, 1500, 2500, 4000, 4000]);
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
