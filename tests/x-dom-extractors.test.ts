import { test } from "bun:test";
import { chromium } from "playwright";

import { requireXTargetEvidence } from "../src/connectors/x/collection.ts";
import {
  extractChatMessages,
  extractLinks,
  extractTimelineItems,
  isAuthenticatedMarkerVisible,
  isChatShellVisible,
  isChatUnlockVisible,
  isLoginVisible,
} from "../src/connectors/x/dom-extractors.ts";
import { assertEquals } from "./assertions.ts";

test("X rendered-DOM extraction preserves canonical posts, metrics, chat timestamps, and emoji reactions", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <main role="main">
        <article data-testid="tweet">
          <div data-testid="User-Name"><a href="/alice">Alice\n@alice</a></div>
          <a href="/alice/status/123456789"><time datetime="2026-07-27T08:30:00.000Z"></time></a>
          <div data-testid="tweetText">Rendered   post text</div>
          <button data-testid="reply" aria-label="12 Replies"></button>
          <button data-testid="retweet" aria-label="1.2K Reposts"></button>
          <button data-testid="like" aria-label="3,456 Likes"></button>
          <a href="/alice/status/123456789/analytics" aria-label="2.5M Views"></a>
        </article>

        <section data-testid="messageEntry" data-message-id="message-1" data-sender-name="Alice">
          <time datetime="2026-07-27T09:00:00.000Z"></time>
          <p data-testid="messageText">First   chat message</p>
          <button data-testid="reaction" data-emoji="👍🏽" aria-label="3 reactions 👍🏽" aria-pressed="true"></button>
          <button data-testid="reaction" data-emoji="👍🏽" aria-label="2 reactions 👍🏽"></button>
          <button data-testid="reaction" data-emoji="👨‍👩‍👧‍👦" aria-label="2 reactions 👨‍👩‍👧‍👦"></button>
          <button data-testid="reaction" data-emoji="1️⃣" aria-label="4 reactions 1️⃣"></button>
          <button data-testid="reaction" data-emoji="🇺🇸" aria-label="🇺🇸 reaction"></button>
        </section>

        <section data-event-id="message-2" data-author="Bob" data-timestamp="1700000000">
          <p role="paragraph">Second chat message</p>
        </section>

        <a class="discovered-link" href="/i/chat/team-chat" aria-label="ARIA conversation name">
          <div>Rendered conversation name</div>
          <div>@team</div>
        </a>
        <a class="discovered-link" href="/i/chat/aria-only" aria-label="ARIA only name"></a>
      </main>
    `);

    assertEquals(await extractTimelineItems(page), [{
      platformId: "123456789",
      date: Date.parse("2026-07-27T08:30:00.000Z"),
      text: "Rendered post text",
      author: "@alice",
      url: "https://x.com/alice/status/123456789",
      replyCount: 12,
      repostCount: 1_200,
      likeCount: 3_456,
      viewCount: 2_500_000,
    }]);

    assertEquals(await extractChatMessages(page), [
      {
        platformId: "message-1",
        date: Date.parse("2026-07-27T09:00:00.000Z"),
        text: "First chat message",
        author: "Alice",
        reactions: [
          { emoji: "👍🏽", count: 3, reactedByViewer: true },
          { emoji: "👨‍👩‍👧‍👦", count: 2, reactedByViewer: false },
          { emoji: "1️⃣", count: 4, reactedByViewer: false },
          { emoji: "🇺🇸", count: 1, reactedByViewer: false },
        ],
      },
      {
        platformId: "message-2",
        date: 1_700_000_000_000,
        text: "Second chat message",
        author: "Bob",
        reactions: [],
      },
    ]);

    assertEquals(await extractLinks(page, ".discovered-link"), [
      {
        href: "/i/chat/team-chat",
        name: "Rendered conversation name",
      },
      {
        href: "/i/chat/aria-only",
        name: "ARIA only name",
      },
    ]);
  } finally {
    await browser.close();
  }
}, 15_000);

test("X state detection ignores post and message prose that resembles control text", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <main role="main">
        <a data-testid="AppTabBar_Home_Link" href="/home">Home</a>
        <article data-testid="tweet">
          <div data-testid="tweetText">You don't have access, so log in to X later.</div>
        </article>
        <section data-testid="messageEntry" data-message-id="message-1">
          <p data-testid="messageText">Please unlock your messages.</p>
        </section>
        <div data-testid="dmComposerTextInput" contenteditable="true" role="textbox"></div>
      </main>
    `);

    assertEquals(await isAuthenticatedMarkerVisible(page), true);
    assertEquals(await isLoginVisible(page), false);
    assertEquals(await isChatShellVisible(page), true);
    assertEquals(await isChatUnlockVisible(page), false);
    await requireXTargetEvidence(page, { kind: "list", listId: "1" });

    await page.setContent(`
      <main role="main">
        <div role="dialog">Log in to X</div>
      </main>
    `);
    assertEquals(await isLoginVisible(page), true);

    await page.setContent(`
      <main role="main">
        <form>
          <input autocomplete="username webauthn">
        </form>
      </main>
    `);
    assertEquals(await isLoginVisible(page), true);

    await page.setContent(`
      <main role="main">
        <form>
          <input name="username_or_email">
        </form>
      </main>
    `);
    assertEquals(await isLoginVisible(page), true);

    await page.setContent(`
      <main role="main">
        <form><h1>Unlock your messages</h1></form>
      </main>
    `);
    assertEquals(await isChatUnlockVisible(page), true);
  } finally {
    await browser.close();
  }
}, 15_000);

test("X authentication accepts a rendered Home timeline post without navigation markers", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <main role="main">
        <article data-testid="tweet">
          <div data-testid="tweetText">A rendered Home timeline post</div>
        </article>
      </main>
    `);

    assertEquals(await isAuthenticatedMarkerVisible(page), true);

    await page.setContent(`
      <main role="main">
        <p>A rendered Home timeline post</p>
      </main>
    `);
    assertEquals(await isAuthenticatedMarkerVisible(page), false);
  } finally {
    await browser.close();
  }
}, 15_000);

test("X authentication recognizes the rendered new Chat shell", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <main role="main">
        <button aria-label="New chat">Compose</button>
      </main>
    `);
    assertEquals(await isAuthenticatedMarkerVisible(page), true);
    assertEquals(await isChatShellVisible(page), true);

    await page.setContent(`
      <main role="main">
        <a href="/i/chat/team-chat">Conversation</a>
      </main>
    `);
    assertEquals(await isAuthenticatedMarkerVisible(page), true);
    assertEquals(await isChatShellVisible(page), true);
  } finally {
    await browser.close();
  }
}, 15_000);
