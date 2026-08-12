import { test } from "bun:test";
import { chromium } from "playwright";
import type { Page } from "playwright";

import {
  normalizeCollectedChatMessages,
  requireXTargetEvidence,
} from "../src/connectors/x/collection.ts";
import {
  createChatMessageExtractor,
  extractChatMessages,
  extractLinks,
  extractTimelineItems,
  isAuthenticatedMarkerVisible,
  isChatShellVisible,
  isChatUnlockVisible,
  isLoginVisible,
} from "../src/connectors/x/dom-extractors.ts";
import { assertEquals, assertRejects, assertStrictEquals } from "./assertions.ts";

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

const UUID_0 = "00000000-0000-4000-8000-000000000000";
const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const UUID_D = "44444444-4444-4444-8444-444444444444";
const UUID_E = "55555555-5555-4555-8555-555555555555";
const UUID_F = "66666666-6666-4666-8666-666666666666";
const UUID_G = "77777777-7777-4777-8777-777777777777";
const UUID_H = "88888888-8888-4888-8888-888888888888";
const UUID_I = "99999999-9999-4999-9999-999999999999";
const UUID_J = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UUID_K = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function modernChatRow(
  uuid: string,
  top: number,
  body: string,
  time: string,
  senderLabel?: string,
): string {
  return `
    <div data-testid="message-${uuid}" style="position:absolute;top:${top}px;left:0;width:420px;">
      <div data-testid="message-avatar-${uuid}" style="position:absolute;top:0;left:0;">avatar</div>
      <div style="margin-left:48px;">
        ${senderLabel ? `<span style="display:block;color:gray;">${senderLabel}</span>` : ""}
        <div data-testid="message-text-${uuid}">
          <span dir="auto">${body}</span>
          <span style="display:block;color:gray;">${time}</span>
        </div>
      </div>
    </div>`;
}

function chatSeparator(top: number, text: string): string {
  return `<div style="position:absolute;top:${top}px;left:0;color:gray;">${text}</div>`;
}

function chatScroller(content: string, height = 800): string {
  return `<main role="main"><div data-testid="dm-message-scroller" style="position:relative;height:${height}px;overflow-y:auto;width:480px;">${content}</div></main>`;
}

// Chat date expectations resolve against the same local calendar the
// extractor uses inside Chromium, never the test runner's timezone. Each
// spec below computes its epoch in the page under test:
//   - "offset": `dayOffset` days from the page's local today (0 = today,
//     -1 = yesterday) at the given local time;
//   - "date": an explicit local calendar date at the given time;
//   - "weekday": the most recent occurrence of `weekday` (0 = Sunday)
//     strictly before the page's local today;
//   - "monthDay": the most recent month/day on or before the page's local
//     today (this year when already past, otherwise last year).
type LocalDateTimeSpec =
  | { kind: "offset"; dayOffset: number; hours: number; minutes: number }
  | { kind: "date"; year: number; month: number; day: number; hours: number; minutes: number }
  | { kind: "weekday"; weekday: number; hours: number; minutes: number }
  | { kind: "monthDay"; month: number; day: number; hours: number; minutes: number };

async function pageLocalEpochs(page: Page, specs: LocalDateTimeSpec[]): Promise<number[]> {
  return page.evaluate((requests) => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return requests.map((spec) => {
      let base = today;
      if (spec.kind === "date") {
        base = new Date(spec.year, spec.month, spec.day);
      } else if (spec.kind === "offset") {
        base = new Date(today.getFullYear(), today.getMonth(), today.getDate() + spec.dayOffset);
      } else if (spec.kind === "weekday") {
        let back = (today.getDay() - spec.weekday + 7) % 7;
        if (back === 0) back = 7;
        base = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
      } else if (spec.kind === "monthDay") {
        let year = today.getFullYear();
        if (new Date(year, spec.month, spec.day).getTime() > today.getTime()) year -= 1;
        base = new Date(year, spec.month, spec.day);
      }
      return new Date(base.getFullYear(), base.getMonth(), base.getDate(), spec.hours, spec.minutes).getTime();
    });
  }, specs);
}

test("modern encrypted Chat rows extract clean body text, UUID ids, local epochs, and visual order", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // DOM order is scrambled (newest first, separators out of place);
    // absolute tops make visual order authoritative.
    await page.setContent(chatScroller([
      chatSeparator(360, "Today"),
      modernChatRow(UUID_C, 400, "Third visual message", "12:15 AM"),
      chatSeparator(0, "Yesterday"),
      modernChatRow(UUID_A, 40, "First visual message", "10:42 AM"),
      modernChatRow(UUID_B, 200, "Second visual message", "11:05 PM"),
    ].join("\n")));

    // Yesterday 10:42 AM, Yesterday 11:05 PM, Today 12:15 AM — resolved
    // against the page's own local calendar.
    const [firstDate, secondDate, thirdDate] = await pageLocalEpochs(page, [
      { kind: "offset", dayOffset: -1, hours: 10, minutes: 42 },
      { kind: "offset", dayOffset: -1, hours: 23, minutes: 5 },
      { kind: "offset", dayOffset: 0, hours: 0, minutes: 15 },
    ]);
    const expected = [
      {
        platformId: UUID_A,
        date: firstDate,
        text: "First visual message",
        author: null,
        reactions: [],
      },
      {
        platformId: UUID_B,
        date: secondDate,
        text: "Second visual message",
        author: null,
        reactions: [],
      },
      {
        platformId: UUID_C,
        date: thirdDate,
        text: "Third visual message",
        author: null,
        reactions: [],
      },
    ];

    const extract = createChatMessageExtractor(page);
    assertEquals(await extract(), expected);
    // The one-shot wrapper stays compatible with fresh per-call state.
    assertEquals(await extractChatMessages(page), expected);
  } finally {
    await browser.close();
  }
}, 15_000);

test("overlapping Chat scroll rounds apply sticky day context and never regress retained dates", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const extract = createChatMessageExtractor(page);

    // Bottom window: the "Today" label renders below five of the seven rows
    // (sticky header artifact), so the single distinct rendered day is
    // context for the whole round: every timed row is dated today.
    await page.setContent(chatScroller([
      modernChatRow(UUID_A, 0, "First row", "10:00 AM"),
      modernChatRow(UUID_B, 60, "Second row", "11:00 AM"),
      modernChatRow(UUID_C, 120, "Third row", "12:00 PM"),
      modernChatRow(UUID_D, 180, "Fourth row", "1:00 PM"),
      modernChatRow(UUID_E, 240, "Fifth row", "2:00 PM"),
      chatSeparator(300, "Today"),
      modernChatRow(UUID_F, 340, "First today", "3:00 PM"),
      modernChatRow(UUID_G, 400, "Second today", "4:00 PM"),
    ].join("\n")));
    const firstRound = await extract();
    assertEquals(firstRound.length, 7);
    // Today 10:00 AM through 4:00 PM, plus Yesterday 9:00 AM for the
    // overlapping round below — resolved against the page's own calendar.
    const [yesterday9, today10, today11, today12, today13, today14, today15, today16] =
      await pageLocalEpochs(page, [
        { kind: "offset", dayOffset: -1, hours: 9, minutes: 0 },
        { kind: "offset", dayOffset: 0, hours: 10, minutes: 0 },
        { kind: "offset", dayOffset: 0, hours: 11, minutes: 0 },
        { kind: "offset", dayOffset: 0, hours: 12, minutes: 0 },
        { kind: "offset", dayOffset: 0, hours: 13, minutes: 0 },
        { kind: "offset", dayOffset: 0, hours: 14, minutes: 0 },
        { kind: "offset", dayOffset: 0, hours: 15, minutes: 0 },
        { kind: "offset", dayOffset: 0, hours: 16, minutes: 0 },
      ]);
    assertEquals(firstRound[0]!.date, today10);
    assertEquals(firstRound[1]!.date, today11);
    assertEquals(firstRound[2]!.date, today12);
    assertEquals(firstRound[3]!.date, today13);
    assertEquals(firstRound[4]!.date, today14);
    assertEquals(firstRound[5]!.date, today15);
    assertEquals(firstRound[6]!.date, today16);

    // Scrolled-up window with a partial overlap: [M1, M2] re-render below a
    // "Yesterday" label. The new row is dated yesterday, but the retained
    // rows keep their finite today dates: existing dates never regress when
    // windows overlap.
    await page.setContent(chatScroller([
      chatSeparator(0, "Yesterday"),
      modernChatRow(UUID_0, 40, "Oldest yesterday", "9:00 AM"),
      modernChatRow(UUID_A, 100, "First row", "10:00 AM"),
      modernChatRow(UUID_B, 160, "Second row", "11:00 AM"),
    ].join("\n")));
    const secondRound = await extract();
    assertEquals(secondRound.length, 3);
    assertStrictEquals(secondRound[0]!.date, yesterday9);
    assertStrictEquals(secondRound[1], firstRound[0]);
    assertStrictEquals(secondRound[2], firstRound[1]);
    assertStrictEquals(secondRound[1]!.date, today10);
    assertStrictEquals(secondRound[2]!.date, today11);
    assertEquals(firstRound[2]!.date, today12);
    assertEquals(firstRound[3]!.date, today13);
    assertEquals(firstRound[4]!.date, today14);
    assertEquals(firstRound[5]!.date, today15);
    assertEquals(firstRound[6]!.date, today16);

    // A third overlapping round is idempotent: same records, no new state.
    await page.setContent(chatScroller([
      chatSeparator(0, "Yesterday"),
      modernChatRow(UUID_0, 40, "Oldest yesterday", "9:00 AM"),
      modernChatRow(UUID_A, 100, "First row", "10:00 AM"),
      modernChatRow(UUID_B, 160, "Second row", "11:00 AM"),
    ].join("\n")));
    const thirdRound = await extract();
    assertEquals(thirdRound.length, 3);
    assertStrictEquals(thirdRound[0], secondRound[0]);
    assertStrictEquals(thirdRound[1], secondRound[1]);
  } finally {
    await browser.close();
  }
}, 15_000);

test("new Chat rows between retained overlap anchors keep their visual-order bounds", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const extract = createChatMessageExtractor(page);

    // The first round retains A, C, and D. The virtualized second round
    // reveals a previously absent rich row B between the retained A/C
    // anchors; B must be inserted there, never appended after D.
    await page.setContent(chatScroller([
      chatSeparator(0, "Today"),
      modernChatRow(UUID_A, 40, "First anchor", "10:00 AM"),
      modernChatRow(UUID_C, 160, "Second anchor", "12:00 PM"),
      modernChatRow(UUID_D, 220, "Trailing retained row", "1:00 PM"),
    ].join("\n")));
    const firstRound = await extract();
    const [today10, today12, today13] = await pageLocalEpochs(page, [
      { kind: "offset", dayOffset: 0, hours: 10, minutes: 0 },
      { kind: "offset", dayOffset: 0, hours: 12, minutes: 0 },
      { kind: "offset", dayOffset: 0, hours: 13, minutes: 0 },
    ]);
    assertStrictEquals(firstRound[0]!.date, today10);
    assertStrictEquals(firstRound[1]!.date, today12);
    assertStrictEquals(firstRound[2]!.date, today13);

    await page.setContent(chatScroller([
      chatSeparator(0, "Today"),
      modernChatRow(UUID_A, 40, "First anchor", "10:00 AM"),
      `<div data-testid="message-${UUID_B}" style="position:absolute;top:100px;left:0;width:420px;">
        <a href="/alice/status/123456789">Shared preview</a>
      </div>`,
      modernChatRow(UUID_C, 160, "Second anchor", "12:00 PM"),
    ].join("\n")));
    const secondRound = await extract();
    assertEquals(secondRound.length, 3);
    assertStrictEquals(secondRound[0], firstRound[0]);
    assertStrictEquals(secondRound[2], firstRound[1]);
    assertStrictEquals(secondRound[1]!.date, null);
    assertStrictEquals(secondRound[1]!.text, "[Shared post] https://x.com/alice/status/123456789");
    assertEquals(extract.boundsOf(secondRound[1]!), {
      lower: today10,
      upper: today12 + 59_999,
    });
    assertEquals(extract.boundsOf(firstRound[2]!), {
      lower: today12,
      upper: null,
    });
  } finally {
    await browser.close();
  }
}, 15_000);

test("sticky same-day Chat context stays ahead of a newly surfaced leading row", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const extract = createChatMessageExtractor(page);

    await page.setContent(chatScroller([
      chatSeparator(0, "Today"),
      modernChatRow(UUID_A, 60, "First retained", "10:00 AM"),
      modernChatRow(UUID_C, 180, "Second retained", "12:00 PM"),
    ].join("\n")));
    const firstRound = await extract();
    const [todayMidnight, today10] = await pageLocalEpochs(page, [
      { kind: "offset", dayOffset: 0, hours: 0, minutes: 0 },
      { kind: "offset", dayOffset: 0, hours: 10, minutes: 0 },
    ]);

    // The repeated sticky Today context applies to the entire upward round.
    // Rich row B is newly visible before retained anchor A, but it still
    // belongs after the canonical Today marker rather than before that day.
    await page.setContent(chatScroller([
      chatSeparator(0, "Today"),
      `<div data-testid="message-${UUID_B}" style="position:absolute;top:60px;left:0;width:420px;">
        <a href="/alice/status/123456789">Shared preview</a>
      </div>`,
      modernChatRow(UUID_A, 120, "First retained", "10:00 AM"),
    ].join("\n")));
    const secondRound = await extract();
    assertStrictEquals(secondRound[1], firstRound[0]);
    assertStrictEquals(secondRound[0]!.date, null);
    assertEquals(extract.boundsOf(secondRound[0]!), {
      lower: todayMidnight,
      upper: today10 + 59_999,
    });
  } finally {
    await browser.close();
  }
}, 15_000);

test("known multi-day separators anchor newly surfaced rows on the correct day", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const extract = createChatMessageExtractor(page);
    const [yesterday10, todayMidnight, today12] = await pageLocalEpochs(page, [
      { kind: "offset", dayOffset: -1, hours: 10, minutes: 0 },
      { kind: "offset", dayOffset: 0, hours: 0, minutes: 0 },
      { kind: "offset", dayOffset: 0, hours: 12, minutes: 0 },
    ]);

    await page.setContent(chatScroller([
      chatSeparator(0, "Yesterday"),
      modernChatRow(UUID_A, 60, "Yesterday anchor", "10:00 AM"),
      chatSeparator(120, "Today"),
      modernChatRow(UUID_C, 180, "Today anchor", "12:00 PM"),
    ].join("\n")));
    const firstRound = await extract();
    assertStrictEquals(firstRound[0]!.date, yesterday10);
    assertStrictEquals(firstRound[1]!.date, today12);

    // B was absent from the first rendered window. Both retained day
    // separators are semantic anchors, so B stays before Today instead of
    // being appended after the retained C row.
    await page.setContent(chatScroller([
      chatSeparator(0, "Yesterday"),
      modernChatRow(UUID_A, 60, "Yesterday anchor", "10:00 AM"),
      `<div data-testid="message-${UUID_B}" style="position:absolute;top:120px;left:0;width:420px;">
        <a href="/alice/status/123456789">Shared preview</a>
      </div>`,
      chatSeparator(180, "Today"),
      modernChatRow(UUID_C, 240, "Today anchor", "12:00 PM"),
    ].join("\n")));
    const secondRound = await extract();
    assertEquals(secondRound.length, 3);
    assertStrictEquals(secondRound[0], firstRound[0]);
    assertStrictEquals(secondRound[2], firstRound[1]);
    assertEquals(extract.boundsOf(secondRound[1]!), {
      lower: yesterday10,
      upper: todayMidnight + 59_999,
    });
  } finally {
    await browser.close();
  }
}, 15_000);

test("known sticky day anchors a disjoint newly surfaced Chat row", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const extract = createChatMessageExtractor(page);
    const [todayMidnight, today10] = await pageLocalEpochs(page, [
      { kind: "offset", dayOffset: 0, hours: 0, minutes: 0 },
      { kind: "offset", dayOffset: 0, hours: 10, minutes: 0 },
    ]);

    await page.setContent(chatScroller([
      chatSeparator(0, "Today"),
      modernChatRow(UUID_A, 60, "Retained row", "10:00 AM"),
    ].join("\n")));
    const firstRound = await extract();
    assertStrictEquals(firstRound[0]!.date, today10);

    // This round shares no row UUID with the retained window. The repeated
    // sticky day is still an anchor: B belongs after Today and before A.
    await page.setContent(chatScroller([
      chatSeparator(0, "Today"),
      `<div data-testid="message-${UUID_B}" style="position:absolute;top:60px;left:0;width:420px;">
        <a href="/alice/status/123456789">Shared preview</a>
      </div>`,
    ].join("\n")));
    const secondRound = await extract();
    assertEquals(secondRound.length, 1);
    assertStrictEquals(secondRound[0]!.date, null);
    assertEquals(extract.boundsOf(secondRound[0]!), {
      lower: todayMidnight,
      upper: today10 + 59_999,
    });
  } finally {
    await browser.close();
  }
}, 15_000);

test("contradictory Chat overlap does not commit an unmerged day separator", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const extract = createChatMessageExtractor(page);
    const [yesterdayMidnight, yesterday9, todayMidnight] = await pageLocalEpochs(page, [
      { kind: "offset", dayOffset: -1, hours: 0, minutes: 0 },
      { kind: "offset", dayOffset: -1, hours: 9, minutes: 0 },
      { kind: "offset", dayOffset: 0, hours: 0, minutes: 0 },
    ]);

    await page.setContent(chatScroller([
      chatSeparator(0, "Today"),
      modernChatRow(UUID_A, 60, "First retained", "10:00 AM"),
      modernChatRow(UUID_C, 120, "Second retained", "12:00 PM"),
    ].join("\n")));
    const firstRound = await extract();

    // The new Yesterday key is observed before the retained rows contradict
    // their established A/C order. Reject the round without poisoning the
    // key set used by the valid retry.
    await page.setContent(chatScroller([
      chatSeparator(0, "Yesterday"),
      modernChatRow(UUID_C, 60, "Second retained", "12:00 PM"),
      chatSeparator(120, "Today"),
      modernChatRow(UUID_A, 180, "First retained", "10:00 AM"),
    ].join("\n")));
    await assertRejects(
      () => extract(),
      Error,
      "contradictory visual order",
    );

    await page.setContent(chatScroller([
      chatSeparator(0, "Yesterday"),
      modernChatRow(UUID_0, 60, "Valid older row", "9:00 AM"),
      chatSeparator(120, "Today"),
      modernChatRow(UUID_A, 180, "First retained", "10:00 AM"),
      modernChatRow(UUID_C, 240, "Second retained", "12:00 PM"),
    ].join("\n")));
    const retryRound = await extract();
    assertEquals(retryRound.length, 3);
    assertStrictEquals(retryRound[0]!.date, yesterday9);
    assertStrictEquals(retryRound[1], firstRound[0]);
    assertStrictEquals(retryRound[2], firstRound[1]);
    assertEquals(extract.boundsOf(retryRound[0]!), {
      lower: yesterdayMidnight,
      upper: todayMidnight + 59_999,
    });
  } finally {
    await browser.close();
  }
}, 15_000);

test("a newly surfaced older sticky day precedes retained later-day markers", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const extract = createChatMessageExtractor(page);
    const [yesterdayMidnight, yesterday9, todayMidnight, today10] =
      await pageLocalEpochs(page, [
        { kind: "offset", dayOffset: -1, hours: 0, minutes: 0 },
        { kind: "offset", dayOffset: -1, hours: 9, minutes: 0 },
        { kind: "offset", dayOffset: 0, hours: 0, minutes: 0 },
        { kind: "offset", dayOffset: 0, hours: 10, minutes: 0 },
      ]);

    await page.setContent(chatScroller([
      chatSeparator(0, "Today"),
      `<div data-testid="message-${UUID_A}" style="position:absolute;top:60px;left:0;width:420px;">
        <a href="/alice/status/123456789">Shared preview</a>
      </div>`,
      modernChatRow(UUID_C, 120, "Today anchor", "10:00 AM"),
    ].join("\n")));
    const firstRound = await extract();
    assertStrictEquals(firstRound[0]!.date, null);
    assertEquals(extract.boundsOf(firstRound[0]!), {
      lower: todayMidnight,
      upper: today10 + 59_999,
    });

    // A sole newly rendered Yesterday label is sticky context for the
    // upward round. Its whole segment belongs before the retained Today
    // marker immediately above rich-row anchor A.
    await page.setContent(chatScroller([
      chatSeparator(0, "Yesterday"),
      modernChatRow(UUID_0, 60, "Older row", "9:00 AM"),
      `<div data-testid="message-${UUID_A}" style="position:absolute;top:120px;left:0;width:420px;">
        <a href="/alice/status/123456789">Shared preview</a>
      </div>`,
    ].join("\n")));
    const secondRound = await extract();
    assertStrictEquals(secondRound[0]!.date, yesterday9);
    assertStrictEquals(secondRound[1], firstRound[0]);
    assertEquals(extract.boundsOf(secondRound[0]!), {
      lower: yesterdayMidnight,
      upper: todayMidnight + 59_999,
    });
    assertEquals(extract.boundsOf(secondRound[1]!), {
      lower: todayMidnight,
      upper: today10 + 59_999,
    });
  } finally {
    await browser.close();
  }
}, 15_000);

test("Chat scroll rounds backfill retained records once a day context is discovered", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const extract = createChatMessageExtractor(page);

    // No date labels render at all: every row stays observable with a null
    // date instead of vanishing.
    await page.setContent(chatScroller([
      modernChatRow(UUID_A, 0, "First row", "10:00 AM"),
      modernChatRow(UUID_B, 60, "Second row", "11:00 AM"),
      modernChatRow(UUID_C, 120, "Third row", "12:00 PM"),
      modernChatRow(UUID_D, 180, "Fourth row", "1:00 PM"),
      modernChatRow(UUID_E, 240, "Fifth row", "2:00 PM"),
    ].join("\n")));
    const firstRound = await extract();
    assertEquals(firstRound.length, 5);
    for (const row of firstRound) {
      assertStrictEquals(row.date, null);
      assertEquals(row.platformId !== null && row.platformId !== "", true);
      assertEquals(row.text.length > 0, true);
    }

    // Scrolled-up window with a small suffix overlap ([M1, M2] re-render at
    // the bottom): the "Yesterday" boundary appears above the previously
    // returned rows. Rows still rendered are dated by the round's sticky
    // day context, and the contiguous retained segment below the boundary
    // backfills the records that already scrolled out (M3..M5) using each
    // record's retained time-of-day.
    await page.setContent(chatScroller([
      chatSeparator(0, "Yesterday"),
      modernChatRow(UUID_0, 40, "Oldest yesterday", "9:00 AM"),
      modernChatRow(UUID_A, 100, "First row", "10:00 AM"),
      modernChatRow(UUID_B, 160, "Second row", "11:00 AM"),
    ].join("\n")));
    const secondRound = await extract();
    assertEquals(secondRound.length, 3);
    // Yesterday 9:00 AM through 2:00 PM — resolved against the page's own
    // local calendar (the extractor's date source).
    const [yesterday9, yesterday10, yesterday11, yesterday12, yesterday13, yesterday14] =
      await pageLocalEpochs(page, [
        { kind: "offset", dayOffset: -1, hours: 9, minutes: 0 },
        { kind: "offset", dayOffset: -1, hours: 10, minutes: 0 },
        { kind: "offset", dayOffset: -1, hours: 11, minutes: 0 },
        { kind: "offset", dayOffset: -1, hours: 12, minutes: 0 },
        { kind: "offset", dayOffset: -1, hours: 13, minutes: 0 },
        { kind: "offset", dayOffset: -1, hours: 14, minutes: 0 },
      ]);
    assertStrictEquals(secondRound[0]!.date, yesterday9);
    assertStrictEquals(secondRound[1], firstRound[0]);
    assertStrictEquals(secondRound[2], firstRound[1]);
    assertEquals(firstRound[0]!.date, yesterday10);
    assertEquals(firstRound[1]!.date, yesterday11);
    assertEquals(firstRound[2]!.date, yesterday12);
    assertEquals(firstRound[3]!.date, yesterday13);
    assertEquals(firstRound[4]!.date, yesterday14);

    // A third overlapping round is idempotent: same records, no new state.
    await page.setContent(chatScroller([
      chatSeparator(0, "Yesterday"),
      modernChatRow(UUID_0, 40, "Oldest yesterday", "9:00 AM"),
      modernChatRow(UUID_A, 100, "First row", "10:00 AM"),
      modernChatRow(UUID_B, 160, "Second row", "11:00 AM"),
    ].join("\n")));
    const thirdRound = await extract();
    assertEquals(thirdRound.length, 3);
    assertStrictEquals(thirdRound[0], secondRound[0]);
    assertStrictEquals(thirdRound[1], secondRound[1]);
  } finally {
    await browser.close();
  }
}, 15_000);

test("unresolved modern Chat rows remain observable and duplicate UUIDs dedupe", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // No date separators are rendered at all: every row stays a record with
    // a null date instead of vanishing, and the duplicated UUID collapses.
    await page.setContent(chatScroller([
      modernChatRow(UUID_A, 0, "First unresolved", "9:00 AM"),
      modernChatRow(UUID_B, 100, "Second unresolved", "10:00 AM"),
      modernChatRow(UUID_B, 100, "Second unresolved", "10:00 AM"),
    ].join("\n")));

    const expected = [
      {
        platformId: UUID_A,
        date: null,
        text: "First unresolved",
        author: null,
        reactions: [],
      },
      {
        platformId: UUID_B,
        date: null,
        text: "Second unresolved",
        author: null,
        reactions: [],
      },
    ];

    const extract = createChatMessageExtractor(page);
    assertEquals(await extract(), expected);
    assertEquals(await extractChatMessages(page), expected);
  } finally {
    await browser.close();
  }
}, 15_000);

test("modern Chat rows without a body span stay observable with empty text", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // The message-text container holds only the visible time (no
    // span[dir="auto"] body): the row must surface with empty text rather
    // than normalizing timestamp-contaminated container text, while the
    // visible time still dates it.
    await page.setContent(chatScroller([
      chatSeparator(0, "Today"),
      `<div data-testid="message-${UUID_A}" style="position:absolute;top:40px;left:0;width:420px;">
        <div data-testid="message-text-${UUID_A}">
          <span style="display:block;color:gray;">10:03 PM</span>
        </div>
      </div>`,
    ].join("\n")));

    // The visible "10:03 PM" time, resolved against the page's calendar.
    const [today2203] = await pageLocalEpochs(page, [
      { kind: "offset", dayOffset: 0, hours: 22, minutes: 3 },
    ]);
    const expected = [{
      platformId: UUID_A,
      date: today2203,
      text: "",
      author: null,
      reactions: [],
    }];

    assertEquals(await extractChatMessages(page), expected);
    assertEquals(await createChatMessageExtractor(page)(), expected);
  } finally {
    await browser.close();
  }
}, 15_000);

test("legacy and modern Chat rows coexist in visual order without body or avatar artifacts", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(chatScroller([
      modernChatRow(UUID_C, 200, "Modern middle", "9:15 AM"),
      `<section data-event-id="legacy-2" data-author="Bob" data-timestamp="1700000000" style="position:absolute;top:400px;left:0;"><p role="paragraph">Legacy second</p></section>`,
      `<section data-testid="messageEntry" data-message-id="legacy-1" data-sender-name="Alice" style="position:absolute;top:0;left:0;"><time datetime="2026-07-27T09:00:00.000Z"></time><p data-testid="messageText">Legacy first</p></section>`,
      chatSeparator(160, "Today"),
    ].join("\n")));

    // "Modern middle" 9:15 AM, resolved against the page's calendar.
    const [modernMiddleDate] = await pageLocalEpochs(page, [
      { kind: "offset", dayOffset: 0, hours: 9, minutes: 15 },
    ]);
    const expected = [
      {
        platformId: "legacy-1",
        date: Date.parse("2026-07-27T09:00:00.000Z"),
        text: "Legacy first",
        author: "Alice",
        reactions: [],
      },
      {
        platformId: UUID_C,
        date: modernMiddleDate,
        text: "Modern middle",
        author: null,
        reactions: [],
      },
      {
        platformId: "legacy-2",
        date: 1_700_000_000_000,
        text: "Legacy second",
        author: "Bob",
        reactions: [],
      },
    ];

    // Exactly the three rows: message-text bodies and message-avatar
    // artifacts must never become rows themselves.
    assertEquals(await extractChatMessages(page), expected);
    const extract = createChatMessageExtractor(page);
    assertEquals(await extract(), expected);
  } finally {
    await browser.close();
  }
}, 15_000);

test("Chat date separators resolve weekday, month/day, and year boundaries without message-text false positives", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // "Today" as message body and "Yesterday" as a sender label live inside
    // rows and must not be treated as date boundaries; row E carries the
    // fake "Yesterday" label above row F to prove the exclusion.
    await page.setContent(chatScroller([
      chatSeparator(0, "August 9, 2025"),
      modernChatRow(UUID_A, 40, "Old dated", "10:00 AM"),
      chatSeparator(120, "Monday"),
      modernChatRow(UUID_B, 160, "Weekday dated", "3:30 PM"),
      chatSeparator(260, "December 25"),
      modernChatRow(UUID_C, 300, "Holiday dated", "11:59 PM"),
      chatSeparator(400, "Today"),
      modernChatRow(UUID_D, 440, "Today", "12:01 AM"),
      modernChatRow(UUID_E, 500, "Body says today", "8:00 AM", "Yesterday"),
      modernChatRow(UUID_F, 560, "Labeled yesterday", "9:00 AM"),
    ].join("\n")));

    // Each separator's calendar date resolves inside the page under test:
    // "Monday" is the most recent Monday strictly before the page's local
    // today, "December 25" is this year when already past (otherwise last
    // year), and "August 9, 2025" is an explicit local calendar date.
    const [oldDate, mondayDate, holidayDate, today001, today800, today900] =
      await pageLocalEpochs(page, [
        { kind: "date", year: 2025, month: 7, day: 9, hours: 10, minutes: 0 },
        { kind: "weekday", weekday: 1, hours: 15, minutes: 30 },
        { kind: "monthDay", month: 11, day: 25, hours: 23, minutes: 59 },
        { kind: "offset", dayOffset: 0, hours: 0, minutes: 1 },
        { kind: "offset", dayOffset: 0, hours: 8, minutes: 0 },
        { kind: "offset", dayOffset: 0, hours: 9, minutes: 0 },
      ]);

    const expected = [
      {
        platformId: UUID_A,
        date: oldDate,
        text: "Old dated",
        author: null,
        reactions: [],
      },
      {
        platformId: UUID_B,
        date: mondayDate,
        text: "Weekday dated",
        author: null,
        reactions: [],
      },
      {
        platformId: UUID_C,
        date: holidayDate,
        text: "Holiday dated",
        author: null,
        reactions: [],
      },
      {
        platformId: UUID_D,
        date: today001,
        text: "Today",
        author: null,
        reactions: [],
      },
      {
        platformId: UUID_E,
        date: today800,
        text: "Body says today",
        author: null,
        reactions: [],
      },
      {
        platformId: UUID_F,
        date: today900,
        text: "Labeled yesterday",
        author: null,
        reactions: [],
      },
    ];

    // Rows E and F keep TODAY's date; a misread "Yesterday" sender label or
    // "Today" body text would have shifted F (and E) to yesterday.
    assertEquals(await extractChatMessages(page), expected);
    assertEquals(await createChatMessageExtractor(page)(), expected);
  } finally {
    await browser.close();
  }
}, 15_000);

test("sticky Today rendered between same-day rows still dates both sides", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // The sticky header can sit between rows of its own day: two rows render
    // above the label and two below, with no other label in the round. The
    // single distinct rendered day is context for the whole round.
    await page.setContent(chatScroller([
      modernChatRow(UUID_A, 0, "Above one", "8:00 AM"),
      modernChatRow(UUID_B, 60, "Above two", "9:00 AM"),
      chatSeparator(120, "Today"),
      modernChatRow(UUID_C, 180, "Below one", "10:00 AM"),
      modernChatRow(UUID_D, 240, "Below two", "11:00 AM"),
    ].join("\n")));

    // 8:00 AM through 11:00 AM today — resolved against the page's calendar.
    const [today800, today900, today1000, today1100] = await pageLocalEpochs(page, [
      { kind: "offset", dayOffset: 0, hours: 8, minutes: 0 },
      { kind: "offset", dayOffset: 0, hours: 9, minutes: 0 },
      { kind: "offset", dayOffset: 0, hours: 10, minutes: 0 },
      { kind: "offset", dayOffset: 0, hours: 11, minutes: 0 },
    ]);
    const expected = [
      {
        platformId: UUID_A,
        date: today800,
        text: "Above one",
        author: null,
        reactions: [],
      },
      {
        platformId: UUID_B,
        date: today900,
        text: "Above two",
        author: null,
        reactions: [],
      },
      {
        platformId: UUID_C,
        date: today1000,
        text: "Below one",
        author: null,
        reactions: [],
      },
      {
        platformId: UUID_D,
        date: today1100,
        text: "Below two",
        author: null,
        reactions: [],
      },
    ];

    assertEquals(await extractChatMessages(page), expected);
    assertEquals(await createChatMessageExtractor(page)(), expected);
  } finally {
    await browser.close();
  }
}, 15_000);

test("nested duplicate date labels dedupe before boundary assignment", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();

    // Two nested copies of the same sticky "Today" label at different tops
    // still expose exactly one distinct rendered day: every timed row in the
    // round is dated today regardless of where the copies render.
    await page.setContent(chatScroller([
      modernChatRow(UUID_A, 0, "Above", "8:00 AM"),
      chatSeparator(40, "Today"),
      modernChatRow(UUID_B, 100, "Middle", "9:00 AM"),
      chatSeparator(160, "Today"),
      modernChatRow(UUID_C, 220, "Below", "10:00 AM"),
    ].join("\n")));
    // First round: today 8:00 AM, 9:00 AM, 10:00 AM. Second round: yesterday
    // 11:00 PM and today 12:01 AM / 1:00 AM. All resolved against the page's
    // own local calendar.
    const [today800, today900, today1000, yesterday2300, today0001, today0100] =
      await pageLocalEpochs(page, [
        { kind: "offset", dayOffset: 0, hours: 8, minutes: 0 },
        { kind: "offset", dayOffset: 0, hours: 9, minutes: 0 },
        { kind: "offset", dayOffset: 0, hours: 10, minutes: 0 },
        { kind: "offset", dayOffset: -1, hours: 23, minutes: 0 },
        { kind: "offset", dayOffset: 0, hours: 0, minutes: 1 },
        { kind: "offset", dayOffset: 0, hours: 1, minutes: 0 },
      ]);
    assertEquals(await extractChatMessages(page), [
      {
        platformId: UUID_A,
        date: today800,
        text: "Above",
        author: null,
        reactions: [],
      },
      {
        platformId: UUID_B,
        date: today900,
        text: "Middle",
        author: null,
        reactions: [],
      },
      {
        platformId: UUID_C,
        date: today1000,
        text: "Below",
        author: null,
        reactions: [],
      },
    ]);

    // With genuinely distinct days, the surviving topmost copy of each day
    // provides the visual boundary: the duplicate Today copy below row B
    // must not create a second boundary that would misdate row C.
    await page.setContent(chatScroller([
      chatSeparator(0, "Yesterday"),
      modernChatRow(UUID_D, 40, "Yesterday row", "11:00 PM"),
      chatSeparator(120, "Today"),
      modernChatRow(UUID_E, 180, "Today row one", "12:01 AM"),
      chatSeparator(240, "Today"),
      modernChatRow(UUID_F, 300, "Today row two", "1:00 AM"),
    ].join("\n")));
    assertEquals(await extractChatMessages(page), [
      {
        platformId: UUID_D,
        date: yesterday2300,
        text: "Yesterday row",
        author: null,
        reactions: [],
      },
      {
        platformId: UUID_E,
        date: today0001,
        text: "Today row one",
        author: null,
        reactions: [],
      },
      {
        platformId: UUID_F,
        date: today0100,
        text: "Today row two",
        author: null,
        reactions: [],
      },
    ]);
  } finally {
    await browser.close();
  }
}, 15_000);

test("a sole midnight separator between 11:59 PM and 12:00 AM stays a boundary, not sticky context", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const extract = createChatMessageExtractor(page);

    // The single distinct rendered label floats between a timed row above
    // (11:59 PM) and a timed row below (12:00 AM): parsed minutes-of-day
    // strictly decrease across the label, so it is a real midnight boundary
    // at its visual top. The upper row must not be dated August 10; the
    // lower row is dated by the label day. Explicit-year labels keep the
    // expectations stable on any run date.
    await page.setContent(chatScroller([
      modernChatRow(UUID_A, 40, "Upper row", "11:59 PM"),
      chatSeparator(100, "August 10, 2025"),
      modernChatRow(UUID_B, 160, "Lower row", "12:00 AM"),
    ].join("\n")));
    const firstRound = await extract();
    assertEquals(firstRound.length, 2);
    // August 9 11:59 PM, August 10 12:00 AM, August 9 12:00 AM — resolved
    // against the page's own local calendar (the extractor's date source).
    const [aug9_2359, aug10_0000, aug9_0000] = await pageLocalEpochs(page, [
      { kind: "date", year: 2025, month: 7, day: 9, hours: 23, minutes: 59 },
      { kind: "date", year: 2025, month: 7, day: 10, hours: 0, minutes: 0 },
      { kind: "date", year: 2025, month: 7, day: 9, hours: 0, minutes: 0 },
    ]);
    assertStrictEquals(firstRound[0]!.date, null);
    assertStrictEquals(firstRound[1]!.date, aug10_0000);
    // The upper row stays on the unknown prior day (no lower bound, upper
    // bound at the boundary day's start); the lower row is bounded below by
    // the boundary. Neither row has contradictory bounds.
    assertEquals(extract.boundsOf(firstRound[0]!), { lower: null, upper: aug10_0000 + 59_999 });
    assertEquals(extract.boundsOf(firstRound[1]!), { lower: aug10_0000, upper: null });

    // Scrolled-up overlapping window: the prior-day label now renders above
    // the upper row while the boundary label stays between the rows. The
    // upper row backfills to August 9 11:59 PM; the lower row keeps its
    // August 10 midnight date and bounds stay noncontradictory.
    await page.setContent(chatScroller([
      chatSeparator(0, "August 9, 2025"),
      modernChatRow(UUID_A, 40, "Upper row", "11:59 PM"),
      chatSeparator(100, "August 10, 2025"),
      modernChatRow(UUID_B, 160, "Lower row", "12:00 AM"),
    ].join("\n")));
    const secondRound = await extract();
    assertEquals(secondRound.length, 2);
    assertStrictEquals(secondRound[0], firstRound[0]);
    assertStrictEquals(secondRound[1], firstRound[1]);
    assertStrictEquals(secondRound[0]!.date, aug9_2359);
    assertStrictEquals(secondRound[1]!.date, aug10_0000);
    // Noncontradictory bounds: the upper row is now bounded by August 9
    // midnight below and the boundary day's start above; the lower row keeps
    // its boundary lower bound with no upper bound. Each finite lower bound
    // never exceeds its finite upper bound.
    assertEquals(extract.boundsOf(secondRound[0]!), { lower: aug9_0000, upper: aug10_0000 + 59_999 });
    assertEquals(extract.boundsOf(secondRound[1]!), { lower: aug10_0000, upper: null });
    const noncontradictory = (bounds: { lower: number | null; upper: number | null }): boolean =>
      bounds.lower === null || bounds.upper === null || bounds.lower <= bounds.upper;
    assertEquals(noncontradictory(extract.boundsOf(secondRound[0]!)), true);
    assertEquals(noncontradictory(extract.boundsOf(secondRound[1]!)), true);
  } finally {
    await browser.close();
  }
}, 15_000);

test("sticky single-day round then multi-day overlap keeps one separator per day with a trailing rich row", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const extract = createChatMessageExtractor(page);
    // Today 10:00 AM, 11:00 AM, today's midnight, yesterday 9:00 AM, and
    // yesterday's midnight — resolved against the page's own local calendar
    // (the extractor's date source).
    const [today1000, today1100, todayMidnight, yesterday900, yesterdayMidnight] =
      await pageLocalEpochs(page, [
        { kind: "offset", dayOffset: 0, hours: 10, minutes: 0 },
        { kind: "offset", dayOffset: 0, hours: 11, minutes: 0 },
        { kind: "offset", dayOffset: 0, hours: 0, minutes: 0 },
        { kind: "offset", dayOffset: -1, hours: 9, minutes: 0 },
        { kind: "offset", dayOffset: -1, hours: 0, minutes: 0 },
      ]);

    // Round 1: a single sticky "Today" label (rendered between the timed
    // rows and the trailing rich row) dates every timed row; the trailing
    // shared-post row has no time and stays undated. The sticky day's key
    // is recorded when its separator first enters the global order.
    await page.setContent(chatScroller([
      modernChatRow(UUID_A, 40, "First today", "10:00 AM"),
      modernChatRow(UUID_B, 100, "Second today", "11:00 AM"),
      chatSeparator(160, "Today"),
      `<div data-testid="message-${UUID_C}" style="position:absolute;top:220px;left:0;width:420px;">
        <a href="/alice/status/123456789?s=20&amp;lang=en"><span dir="auto">Shared post preview</span></a>
      </div>`,
    ].join("\n")));
    const firstRound = await extract();
    assertEquals(firstRound.length, 3);
    assertStrictEquals(firstRound[0]!.date, today1000);
    assertStrictEquals(firstRound[1]!.date, today1100);
    assertStrictEquals(firstRound[2]!.date, null);
    assertEquals(firstRound[2]!.text, "[Shared post] https://x.com/alice/status/123456789");
    // The rich row is an undated successor: it must not fabricate an upper
    // bound for the dated row above it.
    assertEquals(extract.boundsOf(firstRound[0]!), { lower: todayMidnight, upper: today1100 + 59_999 });
    assertEquals(extract.boundsOf(firstRound[1]!), { lower: today1000, upper: null });
    assertEquals(extract.boundsOf(firstRound[2]!), { lower: today1100, upper: null });

    // Round 2: a multi-day window (Yesterday above the overlap, Today
    // between the timed rows and the rich row) is not sticky. The retained
    // Today separator is skipped instead of being appended after the
    // anchors, so the order keeps exactly one separator per browser-local
    // day: the row above the rich row keeps no successor bound and the rich
    // row keeps exactly one day context with noncontradictory bounds.
    await page.setContent(chatScroller([
      chatSeparator(0, "Yesterday"),
      modernChatRow(UUID_0, 40, "Oldest yesterday", "9:00 AM"),
      modernChatRow(UUID_A, 100, "First today", "10:00 AM"),
      modernChatRow(UUID_B, 160, "Second today", "11:00 AM"),
      chatSeparator(220, "Today"),
      `<div data-testid="message-${UUID_C}" style="position:absolute;top:280px;left:0;width:420px;">
        <a href="/alice/status/123456789?s=20&amp;lang=en"><span dir="auto">Shared post preview</span></a>
      </div>`,
    ].join("\n")));
    const secondRound = await extract();
    assertEquals(secondRound.length, 4);
    assertStrictEquals(secondRound[0]!.date, yesterday900);
    assertStrictEquals(secondRound[1], firstRound[0]);
    assertStrictEquals(secondRound[2], firstRound[1]);
    assertStrictEquals(secondRound[3], firstRound[2]);
    assertStrictEquals(secondRound[1]!.date, today1000);
    assertStrictEquals(secondRound[2]!.date, today1100);
    assertStrictEquals(secondRound[3]!.date, null);
    // The new yesterday row is bounded by yesterday's midnight below and
    // the retained Today separator's midnight above.
    assertEquals(extract.boundsOf(secondRound[0]!), { lower: yesterdayMidnight, upper: todayMidnight + 59_999 });
    // No duplicate Today separator after the anchors: the dated row above
    // the rich row still has no finite successor, and every bound follows
    // the single retained separator per day.
    assertEquals(extract.boundsOf(secondRound[1]!), { lower: todayMidnight, upper: today1100 + 59_999 });
    assertEquals(extract.boundsOf(secondRound[2]!), { lower: today1000, upper: null });
    assertEquals(extract.boundsOf(secondRound[3]!), { lower: today1100, upper: null });
  } finally {
    await browser.close();
  }
}, 15_000);

test("exact timestamp hydration moves neighbor lower bounds off stale separator-derived dates", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const extract = createChatMessageExtractor(page);
    // August 9 9:00 AM, August 10 midnight / 10:00 AM / 11:00 AM / 12:00 PM
    // — resolved against the page's own local calendar.
    const [aug9_0900, aug10_0000, aug10_1000, aug10_1100, aug10_1200] =
      await pageLocalEpochs(page, [
        { kind: "date", year: 2025, month: 7, day: 9, hours: 9, minutes: 0 },
        { kind: "date", year: 2025, month: 7, day: 10, hours: 0, minutes: 0 },
        { kind: "date", year: 2025, month: 7, day: 10, hours: 10, minutes: 0 },
        { kind: "date", year: 2025, month: 7, day: 10, hours: 11, minutes: 0 },
        { kind: "date", year: 2025, month: 7, day: 10, hours: 12, minutes: 0 },
      ]);

    // Round 1: the sticky August 10 label dates every timed row, so rA's
    // date is separator-derived.
    await page.setContent(chatScroller([
      chatSeparator(0, "August 10, 2025"),
      modernChatRow(UUID_A, 40, "First row", "10:00 AM"),
      modernChatRow(UUID_B, 100, "Second row", "11:00 AM"),
      modernChatRow(UUID_C, 160, "Third row", "12:00 PM"),
    ].join("\n")));
    const firstRound = await extract();
    assertEquals(firstRound.length, 3);
    assertStrictEquals(firstRound[0]!.date, aug10_1000);
    assertStrictEquals(firstRound[1]!.date, aug10_1100);
    assertStrictEquals(firstRound[2]!.date, aug10_1200);
    assertEquals(extract.boundsOf(firstRound[0]!), { lower: aug10_0000, upper: aug10_1100 + 59_999 });
    assertEquals(extract.boundsOf(firstRound[1]!), { lower: aug10_1000, upper: aug10_1200 + 59_999 });
    assertEquals(extract.boundsOf(firstRound[2]!), { lower: aug10_1100, upper: null });

    // Round 2: rA now renders its exact ms timestamp on the earlier day.
    // The exact date wins over the separator-derived one, and bounds are
    // recomputed from the current order: rB's lower bound moves earlier to
    // rA's exact date instead of keeping the stale separator-derived
    // interval (the former wholly-contained interval is gone), while rB's
    // upper bound still ends at the next finite successor's minute.
    await page.setContent(chatScroller([
      chatSeparator(0, "August 10, 2025"),
      `<div data-testid="message-${UUID_A}" data-created-at-ms="${aug9_0900}" style="position:absolute;top:40px;left:0;width:420px;">
        <div data-testid="message-text-${UUID_A}">
          <span dir="auto">First row</span>
          <span style="display:block;color:gray;">10:00 AM</span>
        </div>
      </div>`,
      modernChatRow(UUID_B, 100, "Second row", "11:00 AM"),
      modernChatRow(UUID_C, 160, "Third row", "12:00 PM"),
    ].join("\n")));
    const secondRound = await extract();
    assertEquals(secondRound.length, 3);
    assertStrictEquals(secondRound[0], firstRound[0]);
    assertStrictEquals(secondRound[1], firstRound[1]);
    assertStrictEquals(secondRound[2], firstRound[2]);
    // Exact hydration replaces the separator-derived date on the retained
    // record itself; the later rows never regress.
    assertStrictEquals(secondRound[0]!.date, aug9_0900);
    assertStrictEquals(secondRound[1]!.date, aug10_1100);
    assertStrictEquals(secondRound[2]!.date, aug10_1200);
    // The retained August 10 separator still bounds rA from below, and rB's
    // lower bound follows the hydrated earlier predecessor. rC keeps its
    // dated predecessor bound.
    assertEquals(extract.boundsOf(secondRound[0]!), { lower: aug10_0000, upper: aug10_1100 + 59_999 });
    assertEquals(extract.boundsOf(secondRound[1]!), { lower: aug9_0900, upper: aug10_1200 + 59_999 });
    assertEquals(extract.boundsOf(secondRound[2]!), { lower: aug10_1100, upper: null });
  } finally {
    await browser.close();
  }
}, 15_000);

test("completeTopBoundary converts the prior-day group above a verified midnight separator", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const extract = createChatMessageExtractor(page);
    // August 9 midnight / 11:50 PM / 11:55 PM and August 10 midnight /
    // 12:01 AM / 12:05 AM — resolved against the page's own local calendar
    // (the extractor's date source).
    const [aug9_0000, aug9_2350, aug9_2355, aug10_0000, aug10_0001, aug10_0005] =
      await pageLocalEpochs(page, [
        { kind: "date", year: 2025, month: 7, day: 9, hours: 0, minutes: 0 },
        { kind: "date", year: 2025, month: 7, day: 9, hours: 23, minutes: 50 },
        { kind: "date", year: 2025, month: 7, day: 9, hours: 23, minutes: 55 },
        { kind: "date", year: 2025, month: 7, day: 10, hours: 0, minutes: 0 },
        { kind: "date", year: 2025, month: 7, day: 10, hours: 0, minutes: 1 },
        { kind: "date", year: 2025, month: 7, day: 10, hours: 0, minutes: 5 },
      ]);

    // The conversation opens with the previous day's 23:xx group and X
    // renders no label above it. The sole "August 10" label floats between
    // the 11:55 PM row and the 12:01 AM row: the strict minutes descent
    // proves a real midnight boundary, so the leading rows stay undated
    // after the round while the boundary-day rows date normally.
    await page.setContent(chatScroller([
      modernChatRow(UUID_A, 40, "First prior", "11:50 PM"),
      modernChatRow(UUID_B, 100, "Second prior", "11:55 PM"),
      chatSeparator(160, "August 10, 2025"),
      modernChatRow(UUID_C, 220, "First new", "12:01 AM"),
      modernChatRow(UUID_D, 280, "Second new", "12:05 AM"),
    ].join("\n")));
    const round = await extract();
    assertEquals(round.length, 4);
    assertStrictEquals(round[0]!.date, null);
    assertStrictEquals(round[1]!.date, null);
    assertStrictEquals(round[2]!.date, aug10_0001);
    assertStrictEquals(round[3]!.date, aug10_0005);
    assertEquals(extract.boundsOf(round[0]!), { lower: null, upper: aug10_0000 + 59_999 });
    assertEquals(extract.boundsOf(round[1]!), { lower: null, upper: aug10_0000 + 59_999 });

    // The proven top boundary finalizes the leading group as the
    // immediately previous local day in a single page evaluate, inserts
    // that day's context ahead of the leading rows, and recomputes bounds.
    await extract.completeTopBoundary();
    assertStrictEquals(round[0]!.date, aug9_2350);
    assertStrictEquals(round[1]!.date, aug9_2355);
    assertEquals(extract.boundsOf(round[0]!), { lower: aug9_0000, upper: aug9_2355 + 59_999 });
    assertEquals(extract.boundsOf(round[1]!), { lower: aug9_2350, upper: aug10_0000 + 59_999 });
    // Boundary-day rows are untouched.
    assertEquals(extract.boundsOf(round[2]!), { lower: aug10_0000, upper: aug10_0005 + 59_999 });
    assertEquals(extract.boundsOf(round[3]!), { lower: aug10_0001, upper: null });

    // Finalizing twice is a no-op: the leading rows now carry dates.
    await extract.completeTopBoundary();
    assertStrictEquals(round[0]!.date, aug9_2350);
    assertStrictEquals(round[1]!.date, aug9_2355);
  } finally {
    await browser.close();
  }
}, 15_000);

test("completeTopBoundary derives the previous local day across month ends and leap years", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // Leap year: March 1, 2024 rolls back to February 29, 2024. Non-leap:
    // March 1, 2025 rolls back to February 28, 2025. Every expectation
    // resolves against the page's own local calendar.
    const [feb29_0000, feb29_2350, feb29_2355, mar1_0000, mar1_0001] =
      await pageLocalEpochs(page, [
        { kind: "date", year: 2024, month: 1, day: 29, hours: 0, minutes: 0 },
        { kind: "date", year: 2024, month: 1, day: 29, hours: 23, minutes: 50 },
        { kind: "date", year: 2024, month: 1, day: 29, hours: 23, minutes: 55 },
        { kind: "date", year: 2024, month: 2, day: 1, hours: 0, minutes: 0 },
        { kind: "date", year: 2024, month: 2, day: 1, hours: 0, minutes: 1 },
      ]);
    const [feb28_0000, feb28_2350, feb28_2355, mar1b_0000, mar1b_0001] =
      await pageLocalEpochs(page, [
        { kind: "date", year: 2025, month: 1, day: 28, hours: 0, minutes: 0 },
        { kind: "date", year: 2025, month: 1, day: 28, hours: 23, minutes: 50 },
        { kind: "date", year: 2025, month: 1, day: 28, hours: 23, minutes: 55 },
        { kind: "date", year: 2025, month: 2, day: 1, hours: 0, minutes: 0 },
        { kind: "date", year: 2025, month: 2, day: 1, hours: 0, minutes: 1 },
      ]);

    const marchFirstDom = (year: number) => chatScroller([
      modernChatRow(UUID_A, 40, "First prior", "11:50 PM"),
      modernChatRow(UUID_B, 100, "Second prior", "11:55 PM"),
      chatSeparator(160, `March 1, ${year}`),
      modernChatRow(UUID_C, 220, "First new", "12:01 AM"),
    ].join("\n"));

    await page.setContent(marchFirstDom(2024));
    const leapExtract = createChatMessageExtractor(page);
    const leapRound = await leapExtract();
    assertStrictEquals(leapRound[0]!.date, null);
    assertStrictEquals(leapRound[1]!.date, null);
    await leapExtract.completeTopBoundary();
    assertStrictEquals(leapRound[0]!.date, feb29_2350);
    assertStrictEquals(leapRound[1]!.date, feb29_2355);
    assertStrictEquals(leapRound[2]!.date, mar1_0001);
    assertEquals(leapExtract.boundsOf(leapRound[0]!), { lower: feb29_0000, upper: feb29_2355 + 59_999 });
    assertEquals(leapExtract.boundsOf(leapRound[1]!), { lower: feb29_2350, upper: mar1_0000 + 59_999 });

    await page.setContent(marchFirstDom(2025));
    const commonExtract = createChatMessageExtractor(page);
    const commonRound = await commonExtract();
    assertStrictEquals(commonRound[0]!.date, null);
    assertStrictEquals(commonRound[1]!.date, null);
    await commonExtract.completeTopBoundary();
    assertStrictEquals(commonRound[0]!.date, feb28_2350);
    assertStrictEquals(commonRound[1]!.date, feb28_2355);
    assertStrictEquals(commonRound[2]!.date, mar1b_0001);
    assertEquals(commonExtract.boundsOf(commonRound[0]!), { lower: feb28_0000, upper: feb28_2355 + 59_999 });
    assertEquals(commonExtract.boundsOf(commonRound[1]!), { lower: feb28_2350, upper: mar1b_0000 + 59_999 });
  } finally {
    await browser.close();
  }
}, 15_000);

test("completeTopBoundary never finalizes nonmonotonic leading times", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const extract = createChatMessageExtractor(page);
    const [aug10_0000, aug10_0001] = await pageLocalEpochs(page, [
      { kind: "date", year: 2025, month: 7, day: 10, hours: 0, minutes: 0 },
      { kind: "date", year: 2025, month: 7, day: 10, hours: 0, minutes: 1 },
    ]);

    // The sole label still classifies as a midnight boundary (1:30 AM
    // above, 12:01 AM below is a minutes descent), but the leading group
    // itself is not one prior-day group: 11:30 PM then 1:30 AM strictly
    // decreases, so the finalizer must not infer a previous day.
    await page.setContent(chatScroller([
      modernChatRow(UUID_A, 40, "First prior", "11:30 PM"),
      modernChatRow(UUID_B, 100, "Second prior", "1:30 AM"),
      chatSeparator(160, "August 10, 2025"),
      modernChatRow(UUID_C, 220, "First new", "12:01 AM"),
    ].join("\n")));
    const round = await extract();
    assertStrictEquals(round[0]!.date, null);
    assertStrictEquals(round[1]!.date, null);
    assertStrictEquals(round[2]!.date, aug10_0001);
    assertEquals(extract.boundsOf(round[0]!), { lower: null, upper: aug10_0000 + 59_999 });

    await extract.completeTopBoundary();
    assertStrictEquals(round[0]!.date, null);
    assertStrictEquals(round[1]!.date, null);
    assertEquals(extract.boundsOf(round[0]!), { lower: null, upper: aug10_0000 + 59_999 });
    assertEquals(extract.boundsOf(round[1]!), { lower: null, upper: aug10_0000 + 59_999 });
  } finally {
    await browser.close();
  }
}, 15_000);

test("completeTopBoundary fails closed without sole-separator midnight evidence", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const extract = createChatMessageExtractor(page);
    const [aug9_0000, aug9_2355, aug10_0001] = await pageLocalEpochs(page, [
      { kind: "date", year: 2025, month: 7, day: 9, hours: 0, minutes: 0 },
      { kind: "date", year: 2025, month: 7, day: 9, hours: 23, minutes: 55 },
      { kind: "date", year: 2025, month: 7, day: 10, hours: 0, minutes: 1 },
    ]);

    // Two rendered days: no sole-separator classification ran, so no
    // midnight-descent evidence exists for any retained day item. The row
    // above every separator stays undated and the finalizer does nothing.
    await page.setContent(chatScroller([
      modernChatRow(UUID_A, 40, "First prior", "11:50 PM"),
      chatSeparator(100, "August 9, 2025"),
      modernChatRow(UUID_B, 160, "Second prior", "11:55 PM"),
      chatSeparator(220, "August 10, 2025"),
      modernChatRow(UUID_C, 280, "First new", "12:01 AM"),
    ].join("\n")));
    const round = await extract();
    assertStrictEquals(round[0]!.date, null);
    assertStrictEquals(round[1]!.date, aug9_2355);
    assertStrictEquals(round[2]!.date, aug10_0001);
    assertEquals(extract.boundsOf(round[0]!), { lower: null, upper: aug9_0000 + 59_999 });

    await extract.completeTopBoundary();
    assertStrictEquals(round[0]!.date, null);
    assertEquals(extract.boundsOf(round[0]!), { lower: null, upper: aug9_0000 + 59_999 });
    assertStrictEquals(round[1]!.date, aug9_2355);
    assertStrictEquals(round[2]!.date, aug10_0001);
  } finally {
    await browser.close();
  }
}, 15_000);

test("completeTopBoundary accepts midnight proven by the retained order across disjoint rounds", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const extract = createChatMessageExtractor(page);
    // August 9 midnight / 11:50 PM / 11:55 PM and August 10 midnight /
    // 12:01 AM / 12:05 AM — resolved against the page's own local calendar
    // (the extractor's date source).
    const [aug9_0000, aug9_2350, aug9_2355, aug10_0000, aug10_0001, aug10_0005] =
      await pageLocalEpochs(page, [
        { kind: "date", year: 2025, month: 7, day: 9, hours: 0, minutes: 0 },
        { kind: "date", year: 2025, month: 7, day: 9, hours: 23, minutes: 50 },
        { kind: "date", year: 2025, month: 7, day: 9, hours: 23, minutes: 55 },
        { kind: "date", year: 2025, month: 7, day: 10, hours: 0, minutes: 0 },
        { kind: "date", year: 2025, month: 7, day: 10, hours: 0, minutes: 1 },
        { kind: "date", year: 2025, month: 7, day: 10, hours: 0, minutes: 5 },
      ]);

    // Round 1 is one-sided: the sole August 10 label renders with only
    // rows below it (12:01 AM, 12:05 AM), so no strict descent is observed
    // in the round and no midnight evidence is recorded; the label is
    // sticky context and dates those rows.
    await page.setContent(chatScroller([
      chatSeparator(0, "August 10, 2025"),
      modernChatRow(UUID_C, 220, "First new", "12:01 AM"),
      modernChatRow(UUID_D, 280, "Second new", "12:05 AM"),
    ].join("\n")));
    const firstRound = await extract();
    assertStrictEquals(firstRound[0]!.date, aug10_0001);
    assertStrictEquals(firstRound[1]!.date, aug10_0005);

    // Round 2 is one-sided the other way: only the prior-day rows render
    // with no label at all, so again no round-level descent exists. The
    // final retained order, however, carries the 23:xx rows before the
    // August 10 day item and the 00:xx rows after it: the strict minutes
    // descent across the boundary in the order independently proves the
    // midnight boundary.
    await page.setContent(chatScroller([
      modernChatRow(UUID_A, 40, "First prior", "11:50 PM"),
      modernChatRow(UUID_B, 100, "Second prior", "11:55 PM"),
      modernChatRow(UUID_C, 160, "First new", "12:01 AM"),
    ].join("\n")));
    const secondRound = await extract();
    assertStrictEquals(secondRound[0]!.date, null);
    assertStrictEquals(secondRound[1]!.date, null);
    assertStrictEquals(secondRound[2], firstRound[0]);

    await extract.completeTopBoundary();
    assertStrictEquals(secondRound[0]!.date, aug9_2350);
    assertStrictEquals(secondRound[1]!.date, aug9_2355);
    assertStrictEquals(secondRound[2]!.date, aug10_0001);
    assertEquals(extract.boundsOf(secondRound[0]!), { lower: aug9_0000, upper: aug9_2355 + 59_999 });
    assertEquals(extract.boundsOf(secondRound[1]!), { lower: aug9_2350, upper: aug10_0000 + 59_999 });
    assertEquals(extract.boundsOf(secondRound[2]!), { lower: aug10_0000, upper: aug10_0005 + 59_999 });
    assertEquals(extract.boundsOf(firstRound[1]!), { lower: aug10_0001, upper: null });
  } finally {
    await browser.close();
  }
}, 15_000);

test("completeTopBoundary repairs a sticky day displaced behind a prepended finite row", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const extract = createChatMessageExtractor(page);
    const [
      aug9_0000,
      aug9_2350,
      aug9_2355,
      aug10_0000,
      aug10_0005,
      aug10_0013,
      aug10_0020,
      aug10_0030,
    ] = await pageLocalEpochs(page, [
      { kind: "date", year: 2025, month: 7, day: 9, hours: 0, minutes: 0 },
      { kind: "date", year: 2025, month: 7, day: 9, hours: 23, minutes: 50 },
      { kind: "date", year: 2025, month: 7, day: 9, hours: 23, minutes: 55 },
      { kind: "date", year: 2025, month: 7, day: 10, hours: 0, minutes: 0 },
      { kind: "date", year: 2025, month: 7, day: 10, hours: 0, minutes: 5 },
      { kind: "date", year: 2025, month: 7, day: 10, hours: 0, minutes: 13 },
      { kind: "date", year: 2025, month: 7, day: 10, hours: 0, minutes: 20 },
      { kind: "date", year: 2025, month: 7, day: 10, hours: 0, minutes: 30 },
    ]);

    // First retain the current-day sticky context and two dated rows.
    await page.setContent(chatScroller([
      chatSeparator(0, "August 10, 2025"),
      modernChatRow(UUID_C, 220, "First retained", "12:20 AM"),
      modernChatRow(UUID_D, 280, "Second retained", "12:30 AM"),
    ].join("\n")));
    const firstRound = await extract();
    assertStrictEquals(firstRound[0]!.date, aug10_0020);
    assertStrictEquals(firstRound[1]!.date, aug10_0030);

    // The next upward window prepends prior-day 23:xx rows, undated
    // current-day 00:xx rows, and a newly discovered exact 12:13 AM row
    // before the retained 12:20 AM anchor. The global merge temporarily
    // leaves all five new rows before the retained August 10 sticky item —
    // the live shape that must not block proven-top completion.
    await page.setContent(chatScroller([
      modernChatRow(UUID_A, 40, "First prior", "11:50 PM"),
      modernChatRow(UUID_B, 100, "Second prior", "11:55 PM"),
      modernChatRow(UUID_F, 160, "First current", "12:00 AM"),
      modernChatRow(UUID_G, 220, "Second current", "12:05 AM"),
      `<div data-testid="message-${UUID_E}" data-created-at-ms="${aug10_0013}" style="position:absolute;top:280px;left:0;width:420px;">
        <div data-testid="message-text-${UUID_E}">
          <span dir="auto">Finite anchor</span>
          <span style="display:block;color:gray;">12:13 AM</span>
        </div>
      </div>`,
      modernChatRow(UUID_C, 340, "First retained", "12:20 AM"),
    ].join("\n")));
    const secondRound = await extract();
    assertStrictEquals(secondRound[0]!.date, null);
    assertStrictEquals(secondRound[1]!.date, null);
    assertStrictEquals(secondRound[2]!.date, null);
    assertStrictEquals(secondRound[3]!.date, null);
    assertStrictEquals(secondRound[4]!.date, aug10_0013);
    assertStrictEquals(secondRound[5], firstRound[0]);
    assertEquals(extract.boundsOf(secondRound[0]!), { lower: null, upper: aug10_0013 + 59_999 });
    assertEquals(extract.boundsOf(secondRound[4]!), { lower: null, upper: aug10_0000 + 59_999 });

    await extract.completeTopBoundary();
    assertStrictEquals(secondRound[0]!.date, aug9_2350);
    assertStrictEquals(secondRound[1]!.date, aug9_2355);
    assertStrictEquals(secondRound[2]!.date, aug10_0000);
    assertStrictEquals(secondRound[3]!.date, aug10_0005);
    assertStrictEquals(secondRound[4]!.date, aug10_0013);
    assertEquals(extract.boundsOf(secondRound[0]!), {
      lower: aug9_0000,
      upper: aug9_2355 + 59_999,
    });
    assertEquals(extract.boundsOf(secondRound[1]!), {
      lower: aug9_2350,
      upper: aug10_0000 + 59_999,
    });
    // Moving (not duplicating) the current-day context to the observed
    // midnight split dates the prepended 00:xx rows and repairs every
    // formerly contradictory neighbor bound.
    assertEquals(extract.boundsOf(secondRound[2]!), {
      lower: aug10_0000,
      upper: aug10_0005 + 59_999,
    });
    assertEquals(extract.boundsOf(secondRound[3]!), {
      lower: aug10_0000,
      upper: aug10_0013 + 59_999,
    });
    assertEquals(extract.boundsOf(secondRound[4]!), {
      lower: aug10_0005,
      upper: aug10_0020 + 59_999,
    });
    assertEquals(extract.boundsOf(secondRound[5]!), {
      lower: aug10_0013,
      upper: aug10_0030 + 59_999,
    });
  } finally {
    await browser.close();
  }
}, 15_000);

test("completeTopBoundary still refuses when the retained order shows no descent across the earliest day", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const extract = createChatMessageExtractor(page);
    const [aug10_0000, aug10_1000, aug10_1005, aug10_1100, aug10_1105] =
      await pageLocalEpochs(page, [
        { kind: "date", year: 2025, month: 7, day: 10, hours: 0, minutes: 0 },
        { kind: "date", year: 2025, month: 7, day: 10, hours: 10, minutes: 0 },
        { kind: "date", year: 2025, month: 7, day: 10, hours: 10, minutes: 5 },
        { kind: "date", year: 2025, month: 7, day: 10, hours: 11, minutes: 0 },
        { kind: "date", year: 2025, month: 7, day: 10, hours: 11, minutes: 5 },
      ]);

    // Same disjoint shape, but the leading rows are 10:00 AM and the
    // boundary-day rows 11:00 AM: the nearest timed minutes across the
    // August 10 day item do not strictly descend, so the boundary is not
    // proven and the leading rows stay unresolved.
    await page.setContent(chatScroller([
      chatSeparator(0, "August 10, 2025"),
      modernChatRow(UUID_C, 220, "First new", "11:00 AM"),
      modernChatRow(UUID_D, 280, "Second new", "11:05 AM"),
    ].join("\n")));
    const firstRound = await extract();
    assertStrictEquals(firstRound[0]!.date, aug10_1100);
    assertStrictEquals(firstRound[1]!.date, aug10_1105);

    await page.setContent(chatScroller([
      modernChatRow(UUID_A, 40, "First prior", "10:00 AM"),
      modernChatRow(UUID_B, 100, "Second prior", "10:05 AM"),
      modernChatRow(UUID_C, 160, "First new", "11:00 AM"),
    ].join("\n")));
    const secondRound = await extract();
    assertStrictEquals(secondRound[0]!.date, null);
    assertStrictEquals(secondRound[1]!.date, null);
    assertStrictEquals(secondRound[2], firstRound[0]);

    await extract.completeTopBoundary();
    assertStrictEquals(secondRound[0]!.date, null);
    assertStrictEquals(secondRound[1]!.date, null);
    assertEquals(extract.boundsOf(secondRound[0]!), { lower: null, upper: aug10_0000 + 59_999 });
    assertEquals(extract.boundsOf(secondRound[1]!), { lower: null, upper: aug10_0000 + 59_999 });
    assertStrictEquals(secondRound[2]!.date, aug10_1100);
  } finally {
    await browser.close();
  }
}, 15_000);

test("modern Chat rows bind to their own message-text UUID against nested decoys", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // UUID_A owns no message-text container: a nested message-text-OTHER,
    // a preview <time datetime>, and time-like card text must never supply
    // its body, time, or date. UUID_B owns its container but also carries a
    // nested OTHER and an outside preview card: only its own container's
    // body and time count. UUID_C carries a row-owned ms timestamp that
    // wins over its visible time.
    await page.setContent(chatScroller([
      chatSeparator(0, "Today"),
      `<div data-testid="message-${UUID_A}" style="position:absolute;top:40px;left:0;width:420px;">
        <div data-testid="message-text-OTHER">
          <span dir="auto">Decoy body</span>
          <span style="display:block;color:gray;">11:59 PM</span>
        </div>
        <a href="https://x.com/preview"><time datetime="2026-01-02T03:04:05.000Z"></time><span>10:03 PM</span></a>
      </div>`,
      `<div data-testid="message-${UUID_B}" style="position:absolute;top:100px;left:0;width:420px;">
        <div data-testid="message-text-${UUID_B}">
          <span dir="auto">Real body</span>
          <span style="display:block;color:gray;">9:30 AM</span>
        </div>
        <div data-testid="message-text-OTHER">
          <span dir="auto">Nested decoy</span>
          <span style="display:block;color:gray;">11:59 PM</span>
        </div>
        <a href="https://x.com/preview"><time datetime="2026-01-02T03:04:05.000Z"></time><span>10:03 PM</span></a>
      </div>`,
      `<div data-testid="message-${UUID_C}" data-created-at-ms="1767225600000" style="position:absolute;top:160px;left:0;width:420px;">
        <div data-testid="message-text-${UUID_C}">
          <span dir="auto">Attributed body</span>
          <span style="display:block;color:gray;">8:00 AM</span>
        </div>
      </div>`,
    ].join("\n")));

    // UUID_B's visible "9:30 AM" time, resolved against the page's calendar.
    const [today930] = await pageLocalEpochs(page, [
      { kind: "offset", dayOffset: 0, hours: 9, minutes: 30 },
    ]);
    const expected = [
      {
        platformId: UUID_A,
        date: null,
        text: "",
        author: null,
        reactions: [],
      },
      {
        platformId: UUID_B,
        date: today930,
        text: "Real body",
        author: null,
        reactions: [],
      },
      {
        platformId: UUID_C,
        date: 1_767_225_600_000,
        text: "Attributed body",
        author: null,
        reactions: [],
      },
    ];

    // Exactly the three rows: nested message-text-OTHER bodies and preview
    // cards never become rows themselves.
    assertEquals(await extractChatMessages(page), expected);
    assertEquals(await createChatMessageExtractor(page)(), expected);
  } finally {
    await browser.close();
  }
}, 15_000);

test("rich Chat rows surface structural placeholders with conservative neighbor bounds", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // Rich rows B, D, and E have no matching message-text container: the
    // shared-post row B and image row D surface structural placeholders,
    // while the avatar-only row E stays empty (its image is nested in a
    // same-origin profile link). Only conservative neighbor bounds may
    // describe them; their dates are never invented.
    await page.setContent(chatScroller([
      chatSeparator(0, "Today"),
      modernChatRow(UUID_A, 40, "First", "10:00 AM"),
      `<div data-testid="message-${UUID_B}" style="position:absolute;top:100px;left:0;width:420px;">
        <a href="/alice/status/123456789?s=20&amp;lang=en"><span dir="auto">Shared post preview</span></a>
      </div>`,
      modernChatRow(UUID_C, 160, "Third", "11:30 AM"),
      `<div data-testid="message-${UUID_D}" style="position:absolute;top:220px;left:0;width:420px;">
        <time datetime="2026-01-02T03:04:05.000Z"></time>
        <img src="https://example.com/photo.png" alt="Photo">
      </div>`,
      `<div data-testid="message-${UUID_E}" style="position:absolute;top:280px;left:0;width:420px;">
        <a href="/alice"><img src="https://example.com/avatar.png" alt="Alice"></a>
      </div>`,
      `<section data-event-id="legacy-1" data-author="Alice" data-timestamp="1700000000" style="position:absolute;top:340px;left:0;"><p role="paragraph">Legacy row</p></section>`,
    ].join("\n")));

    const extract = createChatMessageExtractor(page);
    const round = await extract();
    // Today 10:00 AM, 11:30 AM, and today's midnight — resolved against the
    // page's own local calendar (the extractor's date source).
    const [today1000, today1130, todayMidnight] = await pageLocalEpochs(page, [
      { kind: "offset", dayOffset: 0, hours: 10, minutes: 0 },
      { kind: "offset", dayOffset: 0, hours: 11, minutes: 30 },
      { kind: "offset", dayOffset: 0, hours: 0, minutes: 0 },
    ]);
    assertEquals(round.length, 6);
    assertEquals(round[0]!.date, today1000);
    assertEquals(round[1], {
      platformId: UUID_B,
      date: null,
      text: "[Shared post] https://x.com/alice/status/123456789",
      author: null,
      reactions: [],
    });
    assertEquals(round[2]!.date, today1130);
    assertEquals(round[3], {
      platformId: UUID_D,
      date: null,
      text: "[Image]",
      author: null,
      reactions: [],
    });
    assertEquals(round[4], {
      platformId: UUID_E,
      date: null,
      text: "",
      author: null,
      reactions: [],
    });
    assertEquals(round[5]!.date, 1_700_000_000_000);

    // The stickied Today label bounds every row of the round from below at
    // midnight; the next finite successor (row C) expands the upper bound
    // through the final millisecond of its displayed minute.
    const predecessorDate = today1000;
    const successorDate = today1130;
    assertEquals(extract.boundsOf(round[0]!), {
      lower: todayMidnight,
      upper: successorDate + 59_999,
    });
    assertEquals(extract.boundsOf(round[1]!), {
      lower: predecessorDate,
      upper: successorDate + 59_999,
    });
    assertEquals(extract.boundsOf(round[2]!), {
      lower: predecessorDate,
      upper: 1_700_000_000_000 + 59_999,
    });
    assertEquals(extract.boundsOf(round[3]!), {
      lower: successorDate,
      upper: 1_700_000_000_000 + 59_999,
    });
    assertEquals(extract.boundsOf(round[4]!), {
      lower: successorDate,
      upper: 1_700_000_000_000 + 59_999,
    });
    // Stable legacy rows participate in the same visual order as modern rows,
    // so their exact timestamp supplies predecessor evidence without losing
    // conservative bounds.
    assertEquals(extract.boundsOf(round[5]!), {
      lower: successorDate,
      upper: null,
    });
    // Bounds never become fabricated item dates, even for a fresh extractor.
    assertEquals(await createChatMessageExtractor(page)(), round);
  } finally {
    await browser.close();
  }
}, 15_000);

test("stable undated legacy Chat rows inherit conservative modern-neighbor bounds", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(chatScroller([
      chatSeparator(0, "Today"),
      modernChatRow(UUID_A, 40, "Before", "10:00 AM"),
      `<section data-event-id="legacy-undated" style="position:absolute;top:100px;left:0;">
        <p role="paragraph">Legacy body</p>
      </section>`,
      modernChatRow(UUID_B, 160, "After", "10:30 AM"),
    ].join("\n")));

    const [today1000, today1030] = await pageLocalEpochs(page, [
      { kind: "offset", dayOffset: 0, hours: 10, minutes: 0 },
      { kind: "offset", dayOffset: 0, hours: 10, minutes: 30 },
    ]);
    const extract = createChatMessageExtractor(page);
    const firstRound = await extract();
    assertEquals(firstRound[1], {
      platformId: "legacy-undated",
      date: null,
      text: "Legacy body",
      author: null,
      reactions: [],
    });
    assertEquals(extract.boundsOf(firstRound[1]!), {
      lower: today1000,
      upper: today1030 + 59_999,
    });

    const secondRound = await extract();
    assertStrictEquals(secondRound[1], firstRound[1]);
    assertEquals(extract.boundsOf(secondRound[1]!), {
      lower: today1000,
      upper: today1030 + 59_999,
    });
  } finally {
    await browser.close();
  }
}, 15_000);

test("legacy and modern Chat IDs cannot collide in retained timestamp state", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(chatScroller([
      chatSeparator(0, "Today"),
      modernChatRow(UUID_A, 40, "Modern body", "10:00 AM"),
      `<section data-event-id="${UUID_A}" style="position:absolute;top:100px;left:0;">
        <p role="paragraph">Legacy body</p>
      </section>`,
      modernChatRow(UUID_B, 160, "After", "10:30 AM"),
    ].join("\n")));

    const [today1000, today1030] = await pageLocalEpochs(page, [
      { kind: "offset", dayOffset: 0, hours: 10, minutes: 0 },
      { kind: "offset", dayOffset: 0, hours: 10, minutes: 30 },
    ]);
    const extract = createChatMessageExtractor(page);
    const round = await extract();
    assertEquals(round.map((item) => item.text), [
      "Modern body",
      "Legacy body",
      "After",
    ]);
    assertEquals(extract.boundsOf(round[0]!), {
      lower: (await pageLocalEpochs(page, [
        { kind: "offset", dayOffset: 0, hours: 0, minutes: 0 },
      ]))[0],
      upper: today1030 + 59_999,
    });
    assertEquals(extract.boundsOf(round[1]!), {
      lower: today1000,
      upper: today1030 + 59_999,
    });
  } finally {
    await browser.close();
  }
}, 15_000);

test("legacy and modern Chat IDs remain distinct through normalization", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const [legacyEpoch] = await pageLocalEpochs(page, [
      { kind: "offset", dayOffset: 0, hours: 10, minutes: 15 },
    ]);
    await page.setContent(chatScroller([
      chatSeparator(0, "Today"),
      modernChatRow(UUID_A, 40, "Modern body", "10:00 AM"),
      `<section data-event-id="${UUID_A}" data-created-at-ms="${legacyEpoch}" style="position:absolute;top:100px;left:0;">
        <p role="paragraph">Legacy body</p>
      </section>`,
    ].join("\n")));

    const extract = createChatMessageExtractor(page);
    const round = await extract();
    const dates = round
      .map((item) => item.date)
      .filter((date): date is number => date !== null);
    const from = Math.min(...dates) - 1;
    const to = Math.max(...dates) + 1;
    const normalized = normalizeCollectedChatMessages(
      round,
      { kind: "chat", conversationId: "fixture" },
      from,
      to,
      (item) => extract.boundsOf(item),
    );

    assertEquals(normalized.length, 2);
    assertEquals(
      new Set(normalized.map((item) => item.externalId)).size,
      2,
    );
    assertEquals(
      normalized.map((item) => item.externalId).sort(),
      [UUID_A, `legacy:${UUID_A}`].sort(),
    );
  } finally {
    await browser.close();
  }
}, 15_000);

test("modern rich Chat rows fall back to placeholders only from row-owned structural evidence", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // A owns exact body text that must win over its status anchor and
    // image. B is a shared-post row: the same-origin status anchor yields
    // the canonical queryless placeholder even with query/hash. C's only
    // image lives inside an external status-lookalike anchor: never a
    // shared post, so the image rule applies. D's anchors only resemble
    // status links (external origin, non-numeric id, extra segment,
    // i/web shape) and their preview text must never become body. E's
    // avatar image sits inside a same-origin profile link and stays empty.
    // F owns a profile avatar plus a bare photo: the photo yields
    // "[Image]". G is an unknown link card with no image or status anchor
    // and stays empty.
    await page.setContent(chatScroller([
      chatSeparator(0, "Today"),
      `<div data-testid="message-${UUID_A}" style="position:absolute;top:40px;left:0;width:420px;">
        <a href="/alice/status/111?s=1"><span dir="auto">Preview text</span></a>
        <img src="https://example.com/pic.png" alt="Pic">
        <div data-testid="message-text-${UUID_A}">
          <span dir="auto">Exact body</span>
          <span style="display:block;color:gray;">10:00 AM</span>
        </div>
      </div>`,
      `<div data-testid="message-${UUID_B}" style="position:absolute;top:100px;left:0;width:420px;">
        <a href="/alice/status/222?s=20&amp;lang=en#frag"><span dir="auto">Shared post preview</span></a>
      </div>`,
      `<div data-testid="message-${UUID_C}" style="position:absolute;top:160px;left:0;width:420px;">
        <a href="https://example.com/bob/status/333"><img src="https://example.com/external.png" alt="External"></a>
      </div>`,
      `<div data-testid="message-${UUID_D}" style="position:absolute;top:220px;left:0;width:420px;">
        <a href="/alice/status/abc"><span dir="auto">Bad id</span></a>
        <a href="/alice/status/444/photo"><span dir="auto">Extra segment</span></a>
        <a href="/i/web/status/555"><span dir="auto">i/web shape</span></a>
        <a href="https://example.com/bob/status/333"><span dir="auto">External lookalike</span></a>
      </div>`,
      `<div data-testid="message-${UUID_E}" style="position:absolute;top:280px;left:0;width:420px;">
        <a href="/alice?tab=1"><img src="https://example.com/avatar.png" alt="Alice"></a>
      </div>`,
      `<div data-testid="message-${UUID_F}" style="position:absolute;top:340px;left:0;width:420px;">
        <a href="/bob"><img src="https://example.com/avatar.png" alt="Bob"></a>
        <img src="https://example.com/photo.png" alt="Photo">
      </div>`,
      `<div data-testid="message-${UUID_G}" style="position:absolute;top:400px;left:0;width:420px;">
        <a href="https://example.com/article"><span dir="auto">Article preview text</span></a>
      </div>`,
    ].join("\n")));

    // A's visible "10:00 AM" time, resolved against the page's calendar.
    const [today1000] = await pageLocalEpochs(page, [
      { kind: "offset", dayOffset: 0, hours: 10, minutes: 0 },
    ]);
    const expected = [
      {
        platformId: UUID_A,
        date: today1000,
        text: "Exact body",
        author: null,
        reactions: [],
      },
      {
        platformId: UUID_B,
        date: null,
        text: "[Shared post] https://x.com/alice/status/222",
        author: null,
        reactions: [],
      },
      {
        platformId: UUID_C,
        date: null,
        text: "[Image]",
        author: null,
        reactions: [],
      },
      {
        platformId: UUID_D,
        date: null,
        text: "",
        author: null,
        reactions: [],
      },
      {
        platformId: UUID_E,
        date: null,
        text: "",
        author: null,
        reactions: [],
      },
      {
        platformId: UUID_F,
        date: null,
        text: "[Image]",
        author: null,
        reactions: [],
      },
      {
        platformId: UUID_G,
        date: null,
        text: "",
        author: null,
        reactions: [],
      },
    ];

    assertEquals(await extractChatMessages(page), expected);
    assertEquals(await createChatMessageExtractor(page)(), expected);
  } finally {
    await browser.close();
  }
}, 15_000);

test("large emoji-only Chat bubbles use a placeholder without accepting UI or preview glyphs", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(chatScroller([
      `<div data-testid="message-${UUID_A}" style="position:absolute;top:40px;left:0;width:420px;">
        <div><span style="font-size:64px;line-height:64px;">😀</span></div>
        <div>6:51 AM</div>
      </div>`,
      `<div data-testid="message-${UUID_B}" style="position:absolute;top:110px;left:0;width:420px;">
        <span style="font-size:64px;line-height:64px;">👍🏽👨‍👩‍👧‍👦</span>
      </div>`,
      `<div data-testid="message-${UUID_C}" style="position:absolute;top:180px;left:0;width:420px;">
        <div data-testid="message-avatar-${UUID_C}">
          <span style="font-size:64px;line-height:64px;">😀</span>
        </div>
      </div>`,
      `<div data-testid="message-${UUID_D}" style="position:absolute;top:250px;left:0;width:420px;">
        <a href="/alice"><span style="font-size:64px;line-height:64px;">😀</span></a>
      </div>`,
      `<div data-testid="message-${UUID_E}" style="position:absolute;top:320px;left:0;width:420px;">
        <a href="https://example.com/article"><span style="font-size:64px;line-height:64px;">🔥</span></a>
      </div>`,
      `<div data-testid="message-${UUID_F}" style="position:absolute;top:390px;left:0;width:420px;">
        <div data-testid="message-text-OTHER">
          <span style="font-size:64px;line-height:64px;">🔥</span>
        </div>
      </div>`,
      `<div data-testid="message-${UUID_G}" style="position:absolute;top:460px;left:0;width:420px;">
        <time><span style="font-size:64px;line-height:64px;">🕛</span></time>
      </div>`,
      `<div data-testid="message-${UUID_H}" style="position:absolute;top:530px;left:0;width:420px;">
        <button data-testid="reaction"><span style="font-size:64px;line-height:64px;">👍</span></button>
      </div>`,
      `<div data-testid="message-${UUID_I}" style="position:absolute;top:600px;left:0;width:420px;">
        <span style="font-size:64px;line-height:64px;">Launch 🚀</span>
      </div>`,
      `<div data-testid="message-${UUID_J}" style="position:absolute;top:670px;left:0;width:420px;">
        <span style="font-size:16px;line-height:20px;">🔥</span>
      </div>`,
      `<div data-testid="message-${UUID_0}" style="position:absolute;top:740px;left:0;width:420px;">
        <span style="font-size:64px;line-height:64px;">${"😀".repeat(17)}</span>
      </div>`,
    ].join("\n"), 800));

    const rows = await extractChatMessages(page);
    assertEquals(
      rows.map((row) => ({ platformId: row.platformId, text: row.text })),
      [
        { platformId: UUID_A, text: "[Emoji]" },
        { platformId: UUID_B, text: "[Emoji]" },
        { platformId: UUID_C, text: "" },
        { platformId: UUID_D, text: "" },
        { platformId: UUID_E, text: "" },
        { platformId: UUID_F, text: "" },
        { platformId: UUID_G, text: "" },
        { platformId: UUID_H, text: "" },
        { platformId: UUID_I, text: "" },
        { platformId: UUID_J, text: "" },
        { platformId: UUID_0, text: "" },
      ],
    );
  } finally {
    await browser.close();
  }
}, 15_000);

test("very tall accumulated Chat list bounds old-history rounds to the scroller viewport window", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // X keeps its whole accumulated DM list laid out (live ~192,705px), so
    // far-offscreen rows still report client rects. Parked at old history,
    // the round must contain only the nearby Yesterday block: the laid-out
    // latest Today block 50 viewports below must never enter rows,
    // separator dedupe, sticky-day context, or the order merge. The rows
    // between the newest-yesterday block and the Today block sit 450px
    // apart (one half-viewport step at clientHeight 900), so consecutive
    // upward rounds overlap on the shared rows while each advance surfaces
    // exactly the rows just beyond the prior extraction window: with a 0.5x
    // overscan they enter one round at a time, whereas a 1.5x overscan
    // would pre-collect them all four advances early.
    await page.setContent(chatScroller([
      chatSeparator(0, "Yesterday"),
      modernChatRow(UUID_A, 40, "Oldest yesterday", "10:42 AM"),
      modernChatRow(UUID_B, 100, "Middle yesterday", "11:05 PM"),
      modernChatRow(UUID_C, 160, "Newest yesterday", "11:59 PM"),
      modernChatRow(UUID_F, 400, "Late yesterday", "10:00 PM"),
      modernChatRow(UUID_G, 850, "Later yesterday", "10:30 PM"),
      modernChatRow(UUID_H, 1300, "Latest late yesterday", "11:00 PM"),
      chatSeparator(1750, "Yesterday"),
      modernChatRow(UUID_I, 1800, "Yesterday evening", "11:40 PM"),
      modernChatRow(UUID_J, 2250, "Yesterday dusk", "11:45 PM"),
      chatSeparator(45_000, "Today"),
      modernChatRow(UUID_D, 45_040, "Latest today", "12:01 AM"),
      modernChatRow(UUID_E, 45_100, "Second today", "1:00 AM"),
    ].join("\n"), 900));
    const extract = createChatMessageExtractor(page);
    // Every expected epoch resolves inside the page under test against the
    // page's local calendar (the extractor's date source), so the
    // assertions hold in any test-runner timezone.
    const [cutoff, today0001, today0100, yesterday1042, yesterday2200, yesterday2230, yesterday2300, yesterday2305, yesterday2340, yesterday2345, yesterday2359] =
      await pageLocalEpochs(page, [
        { kind: "offset", dayOffset: 0, hours: 0, minutes: 0 },
        { kind: "offset", dayOffset: 0, hours: 0, minutes: 1 },
        { kind: "offset", dayOffset: 0, hours: 1, minutes: 0 },
        { kind: "offset", dayOffset: -1, hours: 10, minutes: 42 },
        { kind: "offset", dayOffset: -1, hours: 22, minutes: 0 },
        { kind: "offset", dayOffset: -1, hours: 22, minutes: 30 },
        { kind: "offset", dayOffset: -1, hours: 23, minutes: 0 },
        { kind: "offset", dayOffset: -1, hours: 23, minutes: 5 },
        { kind: "offset", dayOffset: -1, hours: 23, minutes: 40 },
        { kind: "offset", dayOffset: -1, hours: 23, minutes: 45 },
        { kind: "offset", dayOffset: -1, hours: 23, minutes: 59 },
      ]);
    const setScrollTop = (top: number) => page.evaluate((value) => {
      const scroller = document.querySelector<HTMLElement>('[data-testid="dm-message-scroller"]')!;
      scroller.scrollTop = value;
    }, top);

    // Bottom window: only the newest block sits in the scroller window; the
    // far-above Yesterday block never enters the round either.
    const scrollable = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('[data-testid="dm-message-scroller"]')!;
      return scroller.scrollHeight - scroller.clientHeight;
    });
    await setScrollTop(scrollable);
    const bottomRound = await extract();
    assertEquals(bottomRound.length, 2);
    assertEquals(bottomRound[0]!.platformId, UUID_D);
    assertEquals(bottomRound[1]!.platformId, UUID_E);
    assertEquals(bottomRound[0]!.date, today0001);
    assertEquals(bottomRound[1]!.date, today0100);
    // A current-day round cannot satisfy the before-window predicate.
    assertEquals(
      bottomRound.every((item) => item.date !== null && Number.isFinite(item.date) && item.date < cutoff),
      false,
    );

    // One half-viewport up: the shared rows stay in the round as the
    // identical retained records, so overlap reconciliation is stable.
    await setScrollTop(scrollable - 450);
    const adjacentRound = await extract();
    assertEquals(adjacentRound.length, 2);
    assertStrictEquals(adjacentRound[0], bottomRound[0]);
    assertStrictEquals(adjacentRound[1], bottomRound[1]);

    // The dense old-history region sits just above the newest-yesterday
    // block. Parked one viewport below its top, the 0.5x overscan window
    // reaches 490px above the viewport: rows I and J (450px apart, the
    // first only 140px above the viewport) are in, while H — a full
    // half-viewport advance higher — is not.
    await setScrollTop(1940);
    const lateRound = await extract();
    assertEquals(lateRound.length, 2);
    assertEquals(lateRound[0]!.platformId, UUID_I);
    assertEquals(lateRound[1]!.platformId, UUID_J);
    assertEquals(lateRound[0]!.date, yesterday2340);
    assertEquals(lateRound[1]!.date, yesterday2345);

    // One half-viewport up: H — just beyond the prior window, 640px above
    // the prior viewport — becomes visible, and the shared I/J rows stay in
    // the round as the identical retained records. A 1.5x overscan would
    // have pre-collected H, G, and F back in the previous round.
    await setScrollTop(1490);
    const surfacedRound = await extract();
    assertEquals(surfacedRound.length, 3);
    assertEquals(surfacedRound[0]!.platformId, UUID_H);
    assertStrictEquals(surfacedRound[1], lateRound[0]);
    assertStrictEquals(surfacedRound[2], lateRound[1]);
    assertEquals(surfacedRound[0]!.date, yesterday2300);

    // Another half-viewport up: G surfaces — still one new row per
    // advance instead of the four future advances a 1.5x overscan
    // pre-collects.
    await setScrollTop(1040);
    const nextSurfacedRound = await extract();
    assertEquals(nextSurfacedRound.length, 4);
    assertEquals(nextSurfacedRound[0]!.platformId, UUID_G);
    assertEquals(nextSurfacedRound[0]!.date, yesterday2230);
    assertStrictEquals(nextSurfacedRound[1], surfacedRound[0]);
    assertStrictEquals(nextSurfacedRound[2], surfacedRound[1]);
    assertStrictEquals(nextSurfacedRound[3], surfacedRound[2]);

    // Old history (top): only the nearby Yesterday rows and headers are in
    // the round (the second Yesterday label dedupes into the retained
    // separator), every row is datable, and the whole round precedes the
    // today-midnight cutoff even though the Today block is laid out far
    // below.
    await setScrollTop(0);
    const topRound = await extract();
    assertEquals(topRound.length, 6);
    assertEquals(topRound.map((item) => item.platformId), [
      UUID_A,
      UUID_B,
      UUID_C,
      UUID_F,
      UUID_G,
      UUID_H,
    ]);
    assertEquals(topRound[0]!.date, yesterday1042);
    assertEquals(topRound[1]!.date, yesterday2305);
    assertEquals(topRound[2]!.date, yesterday2359);
    assertEquals(topRound[3]!.date, yesterday2200);
    assertEquals(topRound[4]!.date, yesterday2230);
    assertEquals(topRound[5]!.date, yesterday2300);
    assertEquals(
      topRound.every((item) => item.date !== null && Number.isFinite(item.date) && item.date < cutoff),
      true,
    );
    // The far-offscreen Today block never tightens conservative bounds: the
    // previous finite row bounds the last yesterday row from below, and the
    // newly surfaced H row is bounded by its predecessor G.
    assertEquals(extract.boundsOf(topRound[2]!).lower, yesterday2305);
    assertEquals(extract.boundsOf(topRound[5]!).lower, yesterday2230);

    // A fresh extractor sees the identical bounded round.
    assertEquals(await extractChatMessages(page), [
      {
        platformId: UUID_A,
        date: yesterday1042,
        text: "Oldest yesterday",
        author: null,
        reactions: [],
      },
      {
        platformId: UUID_B,
        date: yesterday2305,
        text: "Middle yesterday",
        author: null,
        reactions: [],
      },
      {
        platformId: UUID_C,
        date: yesterday2359,
        text: "Newest yesterday",
        author: null,
        reactions: [],
      },
      {
        platformId: UUID_F,
        date: yesterday2200,
        text: "Late yesterday",
        author: null,
        reactions: [],
      },
      {
        platformId: UUID_G,
        date: yesterday2230,
        text: "Later yesterday",
        author: null,
        reactions: [],
      },
      {
        platformId: UUID_H,
        date: yesterday2300,
        text: "Latest late yesterday",
        author: null,
        reactions: [],
      },
    ]);
  } finally {
    await browser.close();
  }
}, 15_000);

test("explicit Chat scroller owns accepted rows; sibling panels and conversations stay out; main fallback persists without a scroller", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // The explicit scroller owns every accepted row. A matching modern row
    // in a sibling panel (same main, outside the scroller) and a sibling
    // conversation (second main) must never enter the round — the panel
    // copy even reuses UUID_A, so its decoy text must never reach the
    // retained record of the owned row.
    await page.setContent(`
      <main role="main">
        <div data-testid="dm-message-scroller" style="position:relative;height:800px;overflow-y:auto;width:480px;">
          <div data-testid="message-${UUID_A}" style="position:absolute;top:40px;left:0;width:420px;">
            <div data-testid="message-text-${UUID_A}">
              <span dir="auto">Owned scroller row</span>
              <span style="display:block;color:gray;">10:00 AM</span>
            </div>
          </div>
        </div>
        <div data-testid="message-${UUID_A}" style="position:absolute;top:40px;left:0;width:420px;">
          <div data-testid="message-text-${UUID_A}">
            <span dir="auto">Panel decoy text</span>
            <span style="display:block;color:gray;">9:00 AM</span>
          </div>
        </div>
      </main>
      <main role="main">
        <div data-testid="message-${UUID_C}" style="position:absolute;top:40px;left:0;width:420px;">
          <div data-testid="message-text-${UUID_C}">
            <span dir="auto">Sibling conversation row</span>
            <span style="display:block;color:gray;">8:00 AM</span>
          </div>
        </div>
      </main>
    `);
    // Exactly the owned row: the sibling panel copy and the sibling
    // conversation never become content.
    assertEquals(await extractChatMessages(page), [
      {
        platformId: UUID_A,
        date: null,
        text: "Owned scroller row",
        author: null,
        reactions: [],
      },
    ]);

    // Without an explicit scroller the legacy main fallback applies: rows
    // from every main in the document are accepted in visual order.
    await page.setContent(`
      <main role="main">
        <div data-testid="message-${UUID_D}" style="position:absolute;top:40px;left:0;width:420px;">
          <div data-testid="message-text-${UUID_D}">
            <span dir="auto">First fallback row</span>
          </div>
        </div>
      </main>
      <main role="main">
        <div data-testid="message-${UUID_E}" style="position:absolute;top:40px;left:0;width:420px;">
          <div data-testid="message-text-${UUID_E}">
            <span dir="auto">Second fallback row</span>
          </div>
        </div>
      </main>
    `);
    assertEquals(await extractChatMessages(page), [
      {
        platformId: UUID_D,
        date: null,
        text: "First fallback row",
        author: null,
        reactions: [],
      },
      {
        platformId: UUID_E,
        date: null,
        text: "Second fallback row",
        author: null,
        reactions: [],
      },
    ]);
  } finally {
    await browser.close();
  }
}, 15_000);

test("rich Chat placeholders come only from entry-owned evidence against nested rows, foreign bodies, and avatar artifacts", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // UUID_A owns nothing: its avatar subtree holds a status-lookalike
    // anchor and an unlinked image, its nested message-text-OTHER body
    // holds a status link and an image, and a nested foreign message-DECOY
    // row holds another status link and image — none of these may become
    // placeholders. UUID_B owns a same-origin status anchor and yields the
    // canonical shared-post placeholder. UUID_C owns a bare image and
    // yields "[Image]". UUID_D owns exact body text that wins over its own
    // status anchor and image.
    await page.setContent(chatScroller([
      chatSeparator(0, "Today"),
      `<div data-testid="message-${UUID_A}" style="position:absolute;top:40px;left:0;width:420px;">
        <div data-testid="message-avatar-${UUID_A}" style="position:absolute;top:0;left:0;">
          <a href="/mallory/status/888?s=1"><img src="https://example.com/avatar-linked.png" alt="Avatar"></a>
          <img src="https://example.com/avatar-bare.png" alt="Avatar">
        </div>
        <div data-testid="message-text-OTHER">
          <a href="/bob/status/999?s=1"><span dir="auto">Foreign shared post</span></a>
          <img src="https://example.com/foreign.png" alt="Foreign photo">
        </div>
        <div data-testid="message-DECOY" style="position:absolute;top:0;left:0;">
          <a href="/carol/status/777"><span dir="auto">Nested row shared post</span></a>
          <img src="https://example.com/nested.png" alt="Nested photo">
        </div>
      </div>`,
      `<div data-testid="message-${UUID_B}" style="position:absolute;top:100px;left:0;width:420px;">
        <a href="/alice/status/123456789?s=20&amp;lang=en"><span dir="auto">Shared post preview</span></a>
      </div>`,
      `<div data-testid="message-${UUID_C}" style="position:absolute;top:160px;left:0;width:420px;">
        <img src="https://example.com/photo.png" alt="Photo">
      </div>`,
      `<div data-testid="message-${UUID_D}" style="position:absolute;top:220px;left:0;width:420px;">
        <div data-testid="message-text-${UUID_D}">
          <span dir="auto">Exact body wins</span>
          <span style="display:block;color:gray;">10:00 AM</span>
        </div>
        <a href="/dave/status/555?s=1"><span dir="auto">Card preview</span></a>
        <img src="https://example.com/deco.png" alt="Deco">
      </div>`,
    ].join("\n")));

    // UUID_D's visible "10:00 AM" time, resolved against the page's calendar.
    const [today1000] = await pageLocalEpochs(page, [
      { kind: "offset", dayOffset: 0, hours: 10, minutes: 0 },
    ]);
    const expected = [
      {
        platformId: UUID_A,
        date: null,
        text: "",
        author: null,
        reactions: [],
      },
      {
        platformId: UUID_B,
        date: null,
        text: "[Shared post] https://x.com/alice/status/123456789",
        author: null,
        reactions: [],
      },
      {
        platformId: UUID_C,
        date: null,
        text: "[Image]",
        author: null,
        reactions: [],
      },
      {
        platformId: UUID_D,
        date: today1000,
        text: "Exact body wins",
        author: null,
        reactions: [],
      },
    ];

    // The nested message-DECOY never becomes a row, and no foreign body,
    // nested row, or avatar artifact supplies placeholders.
    assertEquals(await extractChatMessages(page), expected);
    assertEquals(await createChatMessageExtractor(page)(), expected);
  } finally {
    await browser.close();
  }
}, 15_000);

// Modern rows with defensible bubble geometry: the message-text body is
// 140px wide, so incoming bodies end before the 480px scroller center
// (240px) and outgoing bodies begin after it. An optional sender label
// renders as the body's direct previousElementSibling (the synthetic
// pairing shape); an optional avatar profile link renders inside the row's
// avatar subtree.
function modernChatRowSide(
  uuid: string,
  top: number,
  side: "incoming" | "outgoing",
  body: string,
  time: string,
  senderLabel?: string,
  avatarHref?: string,
): string {
  const avatar = avatarHref === undefined
    ? `<div data-testid="message-avatar-${uuid}" style="position:absolute;top:0;left:0;width:32px;height:32px;">avatar</div>`
    : `<div data-testid="message-avatar-${uuid}" style="position:absolute;top:0;left:0;width:32px;height:32px;"><a href="${avatarHref}"><img src="https://example.com/avatar.png" alt="Avatar"></a></div>`;
  const label = senderLabel === undefined
    ? ""
    : `<span style="display:block;color:gray;height:20px;">${senderLabel}</span>`;
  if (side === "incoming") {
    return `
    <div data-testid="message-${uuid}" style="position:absolute;top:${top}px;left:0;width:480px;height:60px;">
      ${avatar}
      <div style="margin-left:48px;">
        ${label}
        <div data-testid="message-text-${uuid}" style="width:140px;">
          <span dir="auto">${body}</span>
          <span style="display:block;color:gray;">${time}</span>
        </div>
      </div>
    </div>`;
  }
  return `
    <div data-testid="message-${uuid}" style="position:absolute;top:${top}px;left:0;width:480px;height:60px;">
      ${avatar}
      <div style="display:flex;justify-content:flex-end;">
        <div>
          ${label}
          <div data-testid="message-text-${uuid}" style="width:140px;">
            <span dir="auto">${body}</span>
            <span style="display:block;color:gray;">${time}</span>
          </div>
        </div>
      </div>
    </div>`;
}

// Wide bubbles that span the 480px scroller center: neither side is
// defensible, so these rows must fail closed with no author.
function modernChatRowWide(
  uuid: string,
  top: number,
  side: "incoming" | "outgoing",
  body: string,
  time: string,
  senderLabel?: string,
): string {
  const label = senderLabel === undefined
    ? ""
    : `<span style="display:block;color:gray;height:20px;">${senderLabel}</span>`;
  if (side === "incoming") {
    return `
    <div data-testid="message-${uuid}" style="position:absolute;top:${top}px;left:0;width:480px;height:60px;">
      <div style="margin-left:48px;">
        ${label}
        <div data-testid="message-text-${uuid}" style="width:420px;">
          <span dir="auto">${body}</span>
          <span style="display:block;color:gray;">${time}</span>
        </div>
      </div>
    </div>`;
  }
  return `
    <div data-testid="message-${uuid}" style="position:absolute;top:${top}px;left:0;width:480px;height:60px;">
      <div style="display:flex;justify-content:flex-end;">
        <div data-testid="message-text-${uuid}" style="width:420px;">
          <span dir="auto">${body}</span>
          <span style="display:block;color:gray;">${time}</span>
        </div>
      </div>
    </div>`;
}

test("modern Chat rows carry paired sender labels, sticky incoming continuation, avatar handles, and You for outgoing rows", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(chatScroller([
      modernChatRowSide(UUID_A, 0, "incoming", "First group", "10:00 AM", "Al\u202Eice"),
      modernChatRowSide(UUID_B, 60, "incoming", "Continuation", "10:01 AM"),
      modernChatRowSide(UUID_C, 120, "outgoing", "My reply", "10:02 AM", "Owner label"),
      modernChatRowSide(UUID_D, 180, "outgoing", "Another reply", "10:03 AM", undefined, "/owner"),
      modernChatRowSide(UUID_E, 240, "incoming", "Back to you", "10:04 AM"),
      modernChatRowSide(UUID_F, 300, "incoming", "New group", "10:05 AM", "Bob"),
      modernChatRowSide(UUID_G, 360, "incoming", "Bob continuation", "10:06 AM"),
      modernChatRowSide(UUID_H, 420, "incoming", "Handle row", "10:07 AM", undefined, "/mallory?s=1"),
      modernChatRowSide(UUID_I, 480, "incoming", "Handle continuation", "10:08 AM"),
      `<div data-testid="message-${UUID_J}" style="position:absolute;top:540px;left:0;width:480px;height:60px;">
        <div style="margin-left:48px;"><span style="font-size:64px;line-height:64px;">😀</span></div>
      </div>`,
      `<div data-testid="message-${UUID_0}" style="position:absolute;top:600px;left:0;width:480px;height:60px;">
        <div style="display:flex;justify-content:flex-end;"><a href="/alice/status/999?s=1"><span dir="auto">Shared post</span></a></div>
      </div>`,
    ].join("\n")));

    const rows = await extractChatMessages(page);
    assertEquals(rows.map((row) => row.author), [
      "Alice",      // A: paired sender label
      "Alice",      // B: contiguous incoming continuation
      "You",        // C: defensibly right-aligned outgoing
      "You",        // D
      null,         // E: outgoing rows break incoming attribution continuity
      "Bob",        // F: a new visible label starts a new incoming group
      "Bob",        // G
      "@mallory",   // H: exact avatar profile link, query stripped
      "@mallory",   // I: contiguous incoming handle
      "@mallory",   // J: rich emoji bubble, contiguous incoming side
      "You",        // K: rich shared-post bubble, outgoing side
    ]);
    assertEquals(
      rows.map((row) => row.viewerAuthored === true),
      [false, false, true, true, false, false, false, false, false, false, true],
    );
    assertEquals(
      rows.map((row) => row.platformId),
      [UUID_A, UUID_B, UUID_C, UUID_D, UUID_E, UUID_F, UUID_G, UUID_H, UUID_I, UUID_J, UUID_0],
    );
  } finally {
    await browser.close();
  }
}, 15_000);

test("modern Chat sender labels come only from immediately paired siblings; decoys and foreign authors stay null", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // Every decoy is the exact previousElementSibling of the row below it.
    // Only the first wrapper is a real sender label. Any rejected wrapper or
    // legacy row breaks structural continuity rather than risking carryover.
    await page.setContent(chatScroller([
      `<div style="position:absolute;top:0px;left:0;"><span style="color:gray;">Carol</span></div>`,
      modernChatRowSide(UUID_A, 24, "incoming", "Real pair", "10:00 AM"),
      chatSeparator(60, "Today"),
      modernChatRowSide(UUID_B, 100, "incoming", "After date", "10:01 AM"),
      `<div style="position:absolute;top:140px;left:0;"><a href="/bob/status/9?s=1"><span>Shared preview</span></a></div>`,
      modernChatRowSide(UUID_C, 184, "incoming", "After status", "10:02 AM"),
      `<div style="position:absolute;top:224px;left:0;"><span data-testid="reaction">👍 2</span></div>`,
      modernChatRowSide(UUID_D, 268, "incoming", "After reaction", "10:03 AM"),
      `<div data-testid="message-avatar-Z" style="position:absolute;top:308px;left:0;">avatar</div>`,
      modernChatRowSide(UUID_E, 352, "incoming", "After avatar", "10:04 AM"),
      `<div style="position:absolute;top:392px;left:0;height:100px;"><span>Tall block</span></div>`,
      modernChatRowSide(UUID_F, 536, "incoming", "After tall", "10:05 AM"),
      `<div style="position:absolute;top:576px;left:0;"><span>10:42 AM</span></div>`,
      modernChatRowSide(UUID_G, 620, "incoming", "After time", "10:06 AM"),
      `<div style="position:absolute;top:660px;left:0;"><button>Send</button></div>`,
      modernChatRowSide(UUID_H, 704, "incoming", "After control", "10:07 AM"),
      `<div style="position:absolute;top:744px;left:0;"><img src="https://example.com/pic.png" alt="Pic"></div>`,
      modernChatRowSide(UUID_I, 788, "incoming", "After media", "10:08 AM"),
      `<div style="position:absolute;top:828px;left:0;"><span>${"word ".repeat(12).trim()}</span></div>`,
      modernChatRowSide(UUID_J, 872, "incoming", "After long", "10:09 AM"),
      `<section data-event-id="legacy-x" style="position:absolute;top:912px;left:0;"><p role="paragraph">Legacy text</p></section>`,
      modernChatRowSide(UUID_0, 960, "incoming", "After legacy", "10:10 AM"),
      `<div style="position:absolute;top:1000px;left:0;"><span>Aug 9</span></div>`,
      modernChatRowSide(UUID_K, 1044, "incoming", "After month day", "10:11 AM"),
    ].join("\n")));

    const rows = await extractChatMessages(page);
    assertEquals(
      rows.map((row) => row.author),
      [
        "Carol", null, null, null, null, null, null,
        null, null, null, null, null, null,
      ],
    );
    assertEquals(
      rows.map((row) => row.platformId),
      [UUID_A, UUID_B, UUID_C, UUID_D, UUID_E, UUID_F, UUID_G, UUID_H, UUID_I, UUID_J, "legacy-x", UUID_0, UUID_K],
    );

    // Avatar handles come only from this row's own avatar subtree: status
    // links, external links, and nested foreign rows never become handles.
    await page.setContent(chatScroller([
      `<div data-testid="message-${UUID_A}" style="position:absolute;top:40px;left:0;width:480px;height:60px;">
        <div data-testid="message-avatar-${UUID_A}" style="position:absolute;top:0;left:0;"><a href="/alice/status/5"><img src="https://example.com/a.png" alt="A"></a></div>
        <div style="margin-left:48px;">
          <div data-testid="message-text-${UUID_A}" style="width:140px;"><span dir="auto">Status avatar</span></div>
        </div>
      </div>`,
      `<div data-testid="message-${UUID_B}" style="position:absolute;top:100px;left:0;width:480px;height:60px;">
        <div data-testid="message-avatar-${UUID_B}" style="position:absolute;top:0;left:0;"><a href="https://example.com/alice"><img src="https://example.com/a.png" alt="A"></a></div>
        <div style="margin-left:48px;">
          <div data-testid="message-text-${UUID_B}" style="width:140px;"><span dir="auto">External avatar</span></div>
        </div>
      </div>`,
      `<div data-testid="message-${UUID_C}" style="position:absolute;top:160px;left:0;width:480px;height:60px;">
        <div data-testid="message-avatar-${UUID_C}" style="position:absolute;top:0;left:0;"><a href="/alice"><img src="https://example.com/a.png" alt="A"></a></div>
        <div style="margin-left:48px;">
          <div data-testid="message-text-${UUID_C}" style="width:140px;"><span dir="auto">Exact avatar</span></div>
        </div>
      </div>`,
      `<div data-testid="message-${UUID_D}" style="position:absolute;top:220px;left:0;width:480px;height:60px;">
        <div data-testid="message-DECOY-D" style="position:absolute;top:0;left:0;">
          <div data-testid="message-avatar-DECOY-D"><a href="/eve"><img src="https://example.com/a.png" alt="E"></a></div>
        </div>
        <div style="margin-left:48px;">
          <div data-testid="message-text-${UUID_D}" style="width:140px;"><span dir="auto">Nested foreign avatar</span></div>
        </div>
      </div>`,
    ].join("\n")));

    const avatarRows = await extractChatMessages(page);
    // The nested foreign avatar never becomes its own handle; touching,
    // directly adjacent row hosts prove the continuation from C to D.
    assertEquals(avatarRows.map((row) => row.author), [null, null, "@alice", "@alice"]);
    assertEquals(
      avatarRows.map((row) => row.platformId),
      [UUID_A, UUID_B, UUID_C, UUID_D],
    );
  } finally {
    await browser.close();
  }
}, 15_000);

test("retained Chat author evidence keeps stable handles and fails closed on conflicts", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const extract = createChatMessageExtractor(page);

    await page.setContent(chatScroller([
      modernChatRowSide(UUID_A, 0, "incoming", "First", "10:00 AM"),
      modernChatRowSide(UUID_B, 60, "incoming", "Second", "10:01 AM", "Alice"),
      modernChatRowSide(UUID_C, 120, "incoming", "Third", "10:02 AM"),
    ].join("\n")));
    const firstRound = await extract();
    assertEquals(firstRound.map((row) => row.author), [null, "Alice", "Alice"]);

    // A's label scrolls into view; B's label scrolls away. Retained records
    // keep their established authors, and A's newly observed label updates
    // its record in place.
    await page.setContent(chatScroller([
      modernChatRowSide(UUID_A, 0, "incoming", "First", "10:00 AM", "Alice"),
      modernChatRowSide(UUID_B, 60, "incoming", "Second", "10:01 AM"),
      modernChatRowSide(UUID_C, 120, "incoming", "Third", "10:02 AM"),
    ].join("\n")));
    const secondRound = await extract();
    assertStrictEquals(secondRound[0], firstRound[0]);
    assertStrictEquals(secondRound[1], firstRound[1]);
    assertStrictEquals(secondRound[2], firstRound[2]);
    assertEquals(secondRound.map((row) => row.author), ["Alice", "Alice", "Alice"]);

    // Conflicting exact labels for the same retained UUID are not
    // last-write-wins; both rows and their continuation fail closed.
    await page.setContent(chatScroller([
      modernChatRowSide(UUID_A, 0, "incoming", "First", "10:00 AM", "Bob"),
      modernChatRowSide(UUID_B, 60, "incoming", "Second", "10:01 AM", "Bob"),
      modernChatRowSide(UUID_C, 120, "incoming", "Third", "10:02 AM"),
    ].join("\n")));
    const thirdRound = await extract();
    assertStrictEquals(thirdRound[0], firstRound[0]);
    assertEquals(thirdRound.map((row) => row.author), [null, null, null]);

    // Stable avatar handles are stronger than conflicting display labels.
    await page.setContent(chatScroller([
      modernChatRowSide(UUID_A, 0, "incoming", "First", "10:00 AM", undefined, "/alice"),
      modernChatRowSide(UUID_B, 60, "incoming", "Second", "10:01 AM", undefined, "/alice"),
      modernChatRowSide(UUID_C, 120, "incoming", "Third", "10:02 AM"),
    ].join("\n")));
    const fourthRound = await extract();
    assertEquals(
      fourthRound.map((row) => row.author),
      ["@alice", "@alice", "@alice"],
    );

    // Contradictory handles are irreconcilable and permanently clear the
    // affected run rather than falling back to weaker label evidence.
    await page.setContent(chatScroller([
      modernChatRowSide(UUID_A, 0, "incoming", "First", "10:00 AM", undefined, "/mallory"),
      modernChatRowSide(UUID_B, 60, "incoming", "Second", "10:01 AM", undefined, "/mallory"),
      modernChatRowSide(UUID_C, 120, "incoming", "Third", "10:02 AM"),
    ].join("\n")));
    const fifthRound = await extract();
    assertEquals(fifthRound.map((row) => row.author), [null, null, null]);
  } finally {
    await browser.close();
  }
}, 15_000);

test("conflicting retained Chat sides clear exact and viewer attribution", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const extract = createChatMessageExtractor(page);

    await page.setContent(chatScroller(
      modernChatRowSide(
        UUID_A,
        0,
        "incoming",
        "Incoming observation",
        "10:00 AM",
        "Alice",
      ),
    ));
    const firstRound = await extract();
    assertEquals(firstRound[0].author, "Alice");

    await page.setContent(chatScroller(
      modernChatRowSide(
        UUID_A,
        0,
        "outgoing",
        "Conflicting observation",
        "10:00 AM",
        "Owner label",
      ),
    ));
    const secondRound = await extract();
    assertStrictEquals(secondRound[0], firstRound[0]);
    assertEquals(secondRound[0].author, null);
    assertEquals(secondRound[0].viewerAuthored, undefined);
  } finally {
    await browser.close();
  }
}, 15_000);

test("overlapping Chat rounds propagate a newly surfaced group label through retained continuations", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const extract = createChatMessageExtractor(page);

    // The bottom window starts inside an incoming group, so neither retained
    // continuation has enough evidence yet.
    await page.setContent(chatScroller([
      modernChatRowSide(UUID_B, 0, "incoming", "Second", "10:01 AM"),
      modernChatRowSide(UUID_C, 60, "incoming", "Third", "10:02 AM"),
    ].join("\n")));
    const firstRound = await extract();
    assertEquals(firstRound.map((row) => row.author), [null, null]);

    // Scrolling up reveals the labeled group start and overlaps B. The A→B
    // and previously observed B→C adjacency edges prove one incoming run,
    // so the retained C record updates even though it is now offscreen.
    await page.setContent(chatScroller([
      modernChatRowSide(UUID_A, 0, "incoming", "First", "10:00 AM", "Alice"),
      modernChatRowSide(UUID_B, 60, "incoming", "Second", "10:01 AM"),
    ].join("\n")));
    const secondRound = await extract();
    assertEquals(secondRound.map((row) => row.author), ["Alice", "Alice"]);
    assertEquals(firstRound[1]!.author, "Alice");
  } finally {
    await browser.close();
  }
}, 15_000);


test("retained Chat author inference resets at newly observed day boundaries", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const extract = createChatMessageExtractor(page);

    await page.setContent(chatScroller([
      modernChatRowSide(UUID_A, 0, "incoming", "First", "10:00 AM", "Alice"),
      modernChatRowSide(UUID_B, 60, "incoming", "Second", "10:01 AM"),
    ].join("\n")));
    const firstRound = await extract();
    assertEquals(firstRound.map((row) => row.author), ["Alice", "Alice"]);

    await page.setContent(chatScroller([
      chatSeparator(0, "Today"),
      modernChatRowSide(UUID_B, 60, "incoming", "Second", "10:01 AM"),
    ].join("\n")));
    const secondRound = await extract();
    assertEquals(secondRound[0]!.author, null);
    assertEquals(firstRound[1]!.author, null);
  } finally {
    await browser.close();
  }
}, 15_000);

test("unretained legacy Chat rows invalidate one-sided retained author continuity", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const extract = createChatMessageExtractor(page);

    await page.setContent(chatScroller([
      modernChatRowSide(UUID_A, 0, "incoming", "First", "10:00 AM", "Alice"),
      modernChatRowSide(UUID_B, 60, "incoming", "Second", "10:01 AM"),
    ].join("\n")));
    const firstRound = await extract();
    assertEquals(firstRound.map((row) => row.author), ["Alice", "Alice"]);

    await page.setContent(chatScroller([
      `<section data-event-id="${"x".repeat(257)}" style="position:absolute;top:0;left:0;">
        <p role="paragraph">Legacy boundary</p>
      </section>`,
      modernChatRowSide(UUID_B, 60, "incoming", "Second", "10:01 AM"),
    ].join("\n")));
    const secondRound = await extract();
    assertEquals(secondRound[0]!.author, null);
    assertEquals(firstRound[1]!.author, null);
  } finally {
    await browser.close();
  }
}, 15_000);
test("modern Chat rows spanning the scroller center fail closed instead of fabricating authors", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(chatScroller([
      modernChatRowSide(UUID_A, 0, "incoming", "Group start", "10:00 AM", "Alice"),
      modernChatRowWide(UUID_B, 60, "incoming", "Long incoming message", "10:01 AM"),
      modernChatRowWide(UUID_C, 120, "outgoing", "Long outgoing message", "10:02 AM"),
      modernChatRowSide(UUID_D, 180, "outgoing", "Short reply", "10:03 AM"),
    ].join("\n")));
    const rows = await extractChatMessages(page);
    assertEquals(rows.map((row) => row.author), ["Alice", null, null, "You"]);
  } finally {
    await browser.close();
  }
}, 15_000);
