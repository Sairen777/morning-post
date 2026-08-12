import { createHash } from "node:crypto";
import type { Page } from "playwright";

import type { AvailableFeed } from "../connector.types.ts";
import { abortableDelay, throwIfAborted } from "./abort.ts";
import {
  navigateXTarget,
  selectFollowingTimeline,
} from "./browser-session.ts";
import {
  requireXAuthentication,
  requireXChatUnlocked,
} from "./connection-state.ts";
import {
  createChatMessageExtractor,
  extractPageHeading,
  extractVisibleMainText,
  extractTimelineItems,
} from "./dom-extractors.ts";
import type {
  XChatMessageExtractor,
  XDomChatMessage,
  XDomTimelineItem,
} from "./dom-extractors.ts";
import { X_DOM } from "./dom-selectors.ts";
import {
  formatXFeedExternalId,
  formatXTargetUrl,
  isExpectedTargetUrl,
} from "./targets.ts";
import type {
  XRawChatMessage,
  XRawFeedData,
  XRawPost,
  XTarget,
} from "./x.types.ts";
import {
  collectVirtualizedItems,
  type XVirtualScrollStopReason,
  type XVirtualScrollWait,
} from "./virtual-scroll.ts";

const TARGET_READY_ATTEMPTS = 24;
const TARGET_READY_POLL_MS = 250;
const POST_BOUNDARY_CONFIRMATION_ROUNDS = 4;
const TARGET_ERROR_TEXT = /(?:this (?:page|list|conversation) doesn.?t exist|(?:list|conversation) (?:isn.?t|is not) available|you (?:aren.?t|are not) authorized|you don.?t have access)/i;
const EMPTY_FOLLOWING_TEXT = /(?:welcome to x|follow some accounts to see posts|your timeline is empty)/i;
const EMPTY_LIST_TEXT = /(?:this list hasn.?t posted|no posts in this list)/i;
// Empty-conversation certification requires the dedicated structural empty
// state to consist of exactly one of these phrases; ordinary heading or
// message prose that merely contains the phrase never counts.
const EMPTY_CHAT_STATE_TEXT = /^(?:no messages yet|start (?:a|the) conversation)$/i;

export async function resolveXTargetOnPage(
  page: Page,
  target: XTarget,
  signal?: AbortSignal,
): Promise<AvailableFeed> {
  await navigateXTarget(page, target, signal);
  await requireXAuthentication(page, signal);
  if (!isExpectedTargetUrl(page.url(), target)) {
    throw new Error("X did not remain on the requested canonical target");
  }

  if (target.kind === "following") {
    await selectFollowingTimeline(page, signal);
  } else if (target.kind === "chat") {
    await requireXChatUnlocked(page, signal);
  }
  await requireXTargetEvidence(page, target, signal);

  const heading = await extractPageHeading(page);
  return {
    externalId: formatXFeedExternalId(target),
    name: target.kind === "following"
      ? "Following"
      : heading ?? (target.kind === "list"
        ? `List ${target.listId}`
        : `Chat ${target.conversationId}`),
    kind: target.kind === "chat" ? "discussion" : "news",
  };
}

export async function collectXTarget(
  page: Page,
  target: XTarget,
  from: number,
  to: number,
  signal?: AbortSignal,
  wait?: XVirtualScrollWait,
): Promise<XRawFeedData> {
  const feed = await resolveXTargetOnPage(page, target, signal);
  throwIfAborted(signal);

  if (target.kind === "chat") {
    const extractor: XChatMessageExtractor = createChatMessageExtractor(page);
    // Extractor silence after content is never acceptable: a round that
    // rendered messages followed by an empty round means the DOM lost the
    // window mid-scroll, and virtual scrolling would otherwise certify a
    // boundary for a partial collection.
    let sawNonEmptyRound = false;
    const extractRound = async (): Promise<XDomChatMessage[]> => {
      const roundItems = await extractor();
      if (roundItems.length > 0) {
        sawNonEmptyRound = true;
      } else if (sawNonEmptyRound) {
        throw new Error(
          "X Chat extractor returned an empty round after rendering content; refusing to certify a partial collection",
        );
      }
      return roundItems;
    };
    const collection = await collectVirtualizedItems(page, {
      itemSelector: X_DOM.chatMessage,
      direction: "up",
      mergeOverlappingWindows: true,
      scrollerSelector: X_DOM.chatMessageScroller,
      dispatchWheelIntent: true,
      extractRound,
      identityOf: chatDomIdentity,
      identityIsStable: (item) => item.identityKey !== null && item.identityKey !== undefined,
      shouldStop: (roundItems) =>
        renderedChatWindowPrecedes(roundItems, from, (item) => extractor.boundsOf(item)),
    }, signal, wait);
    await requireCompleteCollection(page, target, collection.stopReason);
    if (collection.stopReason === "boundary") {
      // Only a proven scroll boundary may finalize the top prior-day group:
      // a condition stop means the window predicate ended the collection,
      // and no_progress/max_* mean completeness was never proven, so the
      // leading rows above a verified midnight separator stay undated and
      // fail closed instead of being inferred.
      await extractor.completeTopBoundary();
    }
    await requireChatMessagesOrExplicitEmpty(page, collection.items);
    const items = normalizeCollectedChatMessages(
      collection.items,
      target,
      from,
      to,
      (item) => extractor.boundsOf(item),
    );
    return { feed, target, items };
  }

  const collection = await collectVirtualizedItems(page, {
    itemSelector: X_DOM.timelinePost,
    direction: "down",
    extractRound: async () => await extractTimelineItems(page),
    identityOf: timelineDomIdentity,
    shouldStop: createPostBoundaryPredicate(from),
  }, signal, wait);
  assertRenderedTimestamps(collection.items, "X post");
  await requireCompleteCollection(page, target, collection.stopReason);
  const items = collection.items
    .filter((item) => item.date !== null && item.date >= from && item.date <= to && item.text !== "")
    .map(toRawPost)
    .sort((left, right) => right.date - left.date || left.externalId.localeCompare(right.externalId));
  return { feed, target, items };
}

export function normalizeCollectedChatMessages(
  collected: XDomChatMessage[],
  target: Extract<XTarget, { kind: "chat" }>,
  from: number,
  to: number,
  boundsOf?: (item: XDomChatMessage) => { lower: number | null; upper: number | null },
): XRawChatMessage[] {
  const fallbackOccurrences = new Map<string, number>();
  const normalized: XRawChatMessage[] = [];
  for (const item of collected) {
    const date = chatMessageWindowDate(item, from, to, boundsOf);
    if (date === null) continue;
    if (item.text.trim() === "") {
      throw new Error("X Chat message has empty or unrepresentable body text");
    }
    if (item.identityKey !== null && item.identityKey !== undefined) {
      normalized.push(toRawChatMessage(item, target, date, null));
      continue;
    }
    // The fallback identity is derived from the resolved window date, not the
    // extractor record: undated rows that resolve through their bounds must
    // hash the surrogate timestamp so occurrence tracking and the emitted
    // fallback ID stay in lockstep across identical rows.
    const identity = fallbackIdentity(
      "chat_message",
      date,
      item.author,
      item.text,
      null,
      null,
      item.viewerAuthored === true,
    );
    const occurrence = fallbackOccurrences.get(identity) ?? 0;
    fallbackOccurrences.set(identity, occurrence + 1);
    normalized.push(toRawChatMessage(item, target, date, occurrence));
  }
  return normalized.sort((left, right) =>
    right.date - left.date ||
    left.externalId.localeCompare(right.externalId)
  );
}

export async function requireXTargetEvidence(
  page: Page,
  target: XTarget,
  signal?: AbortSignal,
): Promise<void> {
  for (let attempt = 0; attempt < TARGET_READY_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal);
    if (target.kind === "chat") {
      if (
        await page.locator(X_DOM.chatMessage).count() > 0 ||
        await page.locator(X_DOM.chatComposer).count() > 0 ||
        await hasExplicitChatEmptyState(page)
      ) {
        return;
      }
    } else if (await page.locator(X_DOM.timelinePost).count() > 0) {
      return;
    }

    const visibleText = await extractVisibleMainText(page);
    if (
      target.kind === "following"
        ? EMPTY_FOLLOWING_TEXT.test(visibleText)
        : EMPTY_LIST_TEXT.test(visibleText)
    ) {
      return;
    }
    if (TARGET_ERROR_TEXT.test(visibleText)) {
      throw new Error("X target is unavailable or inaccessible");
    }
    await abortableDelay(TARGET_READY_POLL_MS, signal);
  }
  throw new Error("X target did not render recognizable content before the deadline");
}

function createPostBoundaryPredicate(
  from: number,
): (items: XDomTimelineItem[]) => boolean {
  const seenOldItems = new Set<string>();
  let confirmedRounds = 0;
  return (items) => {
    if (!renderedWindowPrecedes(items, from)) {
      confirmedRounds = 0;
      return false;
    }
    let discoveredOlderItem = false;
    for (const item of items) {
      const identity = timelineDomIdentity(item);
      if (seenOldItems.has(identity)) continue;
      seenOldItems.add(identity);
      discoveredOlderItem = true;
    }
    if (!discoveredOlderItem) return false;
    confirmedRounds += 1;
    return confirmedRounds >= POST_BOUNDARY_CONFIRMATION_ROUNDS;
  };
}

function renderedWindowPrecedes(
  items: Array<{ date: number | null }>,
  from: number,
): boolean {
  return items.length > 0 &&
    items.every((item) =>
      item.date !== null &&
      Number.isFinite(item.date) &&
      item.date < from
    );
}

function renderedChatWindowPrecedes(
  items: XDomChatMessage[],
  from: number,
  boundsOf: (item: XDomChatMessage) => { lower: number | null; upper: number | null },
): boolean {
  if (items.length === 0) return false;
  return items.every((item) => {
    if (item.date !== null && Number.isFinite(item.date)) {
      return item.date < from;
    }
    const upper = boundsOf(item).upper;
    return upper !== null && upper < from;
  });
}

function assertRenderedTimestamps(
  items: Array<{ date: number | null; text: string }>,
  itemKind: string,
): void {
  if (
    items.some((item) =>
      item.text.trim() !== "" &&
      (item.date === null || !Number.isFinite(item.date))
    )
  ) {
    throw new Error(`${itemKind} has content but no reliable rendered timestamp`);
  }
}

export async function requireCompleteCollection(
  page: Page,
  _target: XTarget,
  stopReason: XVirtualScrollStopReason,
): Promise<void> {
  if (stopReason === "condition") return;
  if (stopReason === "boundary") {
    const progressIndicators = page.getByRole("progressbar");
    const count = Math.min(await progressIndicators.count(), 10);
    for (let index = 0; index < count; index += 1) {
      if (await progressIndicators.nth(index).isVisible()) {
        throw new Error(
          "X collection stopped at a scroll boundary while content was still loading",
        );
      }
    }
    return;
  }
  throw new Error(
    `X collection could not prove the requested time-window boundary (${stopReason})`,
  );
}

function toRawPost(item: XDomTimelineItem): XRawPost {
  const date = requireDate(item.date);
  return {
    kind: "post",
    externalId: item.platformId ?? fallbackIdentity("post", date, item.author, item.text, item.url),
    platformId: item.platformId,
    date,
    text: item.text,
    author: item.author,
    url: item.url,
    replyCount: item.replyCount,
    repostCount: item.repostCount,
    likeCount: item.likeCount,
    viewCount: item.viewCount,
  };
}

function toRawChatMessage(
  item: XDomChatMessage,
  target: XTarget,
  date: number,
  fallbackOccurrence: number | null,
): XRawChatMessage {
  return {
    kind: "chat_message",
    externalId: item.identityKey ?? fallbackIdentity(
      "chat_message",
      date,
      item.author,
      item.text,
      formatXFeedExternalId(target),
      fallbackOccurrence,
      item.viewerAuthored === true,
    ),
    platformId: item.platformId,
    date,
    text: item.text,
    author: item.author,
    url: formatXTargetUrl(target),
    reactions: item.reactions,
    ...(item.viewerAuthored === true ? { viewerAuthored: true as const } : {}),
  };
}

function timelineDomIdentity(item: XDomTimelineItem): string {
  return item.platformId ?? fallbackIdentity("post", item.date, item.author, item.text, item.url);
}

function chatDomIdentity(item: XDomChatMessage): string {
  return item.identityKey ?? fallbackIdentity(
    "chat_message",
    item.date,
    item.author,
    item.text,
    null,
    null,
    item.viewerAuthored === true,
  );
}

function fallbackIdentity(
  kind: "post" | "chat_message",
  date: number | null,
  author: string | null,
  text: string,
  location: string | null,
  occurrence: number | null = null,
  viewerAuthored = false,
): string {
  const identityParts: unknown[] = [kind, date, author, text, location];
  if (occurrence !== null) identityParts.push(occurrence);
  if (viewerAuthored) identityParts.push("viewer");
  const digest = createHash("sha256")
    .update(JSON.stringify(identityParts))
    .digest("hex");
  return `fallback:${digest}`;
}

function requireDate(value: number | null): number {
  if (value === null || !Number.isFinite(value)) throw new Error("X item has no rendered timestamp");
  return value;
}

function chatMessageWindowDate(
  item: XDomChatMessage,
  from: number,
  to: number,
  boundsOf: ((item: XDomChatMessage) => { lower: number | null; upper: number | null }) | undefined,
): number | null {
  if (item.date !== null && Number.isFinite(item.date)) {
    return item.date >= from && item.date <= to ? item.date : null;
  }
  // Undated rows (unsupported rich/media/link records) resolve only from
  // conservative order-derived bounds. Non-finite or contradictory bounds are
  // invalid evidence and fail; wholly-outside finite bounds prove exclusion;
  // fully-contained finite bounds prove membership and resolve to their lower
  // bound as a deterministic surrogate timestamp; anything straddling,
  // one-sided, or otherwise possibly in-window fails closed.
  const bounds = boundsOf?.(item) ?? { lower: null, upper: null };
  const { lower, upper } = bounds;
  if (
    (lower !== null && !Number.isFinite(lower)) ||
    (upper !== null && !Number.isFinite(upper))
  ) {
    throw new Error("X Chat message has no reliable rendered timestamp");
  }
  if (lower !== null && upper !== null && lower > upper) {
    throw new Error("X Chat message has no reliable rendered timestamp");
  }
  if (upper !== null && upper < from) return null;
  if (lower !== null && lower > to) return null;
  if (lower !== null && upper !== null && lower >= from && upper <= to) {
    return lower;
  }
  throw new Error("X Chat message has no reliable rendered timestamp");
}

async function requireChatMessagesOrExplicitEmpty(
  page: Page,
  items: XDomChatMessage[],
): Promise<void> {
  if (items.length > 0) return;
  if (await hasExplicitChatEmptyState(page)) return;
  throw new Error(
    "X Chat rendered no messages and no explicit empty-conversation state; refusing to treat extractor silence as an empty conversation",
  );
}

// Empty-conversation evidence must come from a dedicated visible structural
// element (empty-state testid or semantic status/live region) whose own
// cleaned text is exactly a known empty phrase, never from flattened main
// text or from prose inside message rows or the composer.
async function hasExplicitChatEmptyState(page: Page): Promise<boolean> {
  const elements = page.locator(X_DOM.chatEmptyState);
  const count = Math.min(await elements.count(), 20);
  for (let index = 0; index < count; index += 1) {
    const element = elements.nth(index);
    if (!(await element.isVisible())) continue;
    const qualifies = await element.evaluate((node, config) => {
      if (
        node.closest(config.row) !== null ||
        node.closest(config.composer) !== null
      ) {
        return false;
      }
      const raw = typeof HTMLElement !== "undefined" && node instanceof HTMLElement
        ? node.innerText
        : node.textContent ?? "";
      return config.emptyText.test(raw.replace(/\s+/g, " ").trim());
    }, {
      row: X_DOM.chatMessageRow,
      composer: X_DOM.chatComposer,
      emptyText: EMPTY_CHAT_STATE_TEXT,
    });
    if (qualifies) return true;
  }
  return false;
}
