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
  extractChatMessages,
  extractPageHeading,
  extractVisibleMainText,
  extractTimelineItems,
} from "./dom-extractors.ts";
import type { XDomChatMessage, XDomTimelineItem } from "./dom-extractors.ts";
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
} from "./virtual-scroll.ts";

const TARGET_READY_ATTEMPTS = 24;
const TARGET_READY_POLL_MS = 250;
const POST_BOUNDARY_CONFIRMATION_ROUNDS = 4;
const TARGET_ERROR_TEXT = /(?:this (?:page|list|conversation) doesn.?t exist|(?:list|conversation) (?:isn.?t|is not) available|you (?:aren.?t|are not) authorized|you don.?t have access)/i;
const EMPTY_FOLLOWING_TEXT = /(?:welcome to x|follow some accounts to see posts|your timeline is empty)/i;
const EMPTY_LIST_TEXT = /(?:this list hasn.?t posted|no posts in this list)/i;
const EMPTY_CHAT_TEXT = /(?:no messages yet|start (?:a|the) conversation)/i;

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
): Promise<XRawFeedData> {
  const feed = await resolveXTargetOnPage(page, target, signal);
  throwIfAborted(signal);

  if (target.kind === "chat") {
    const collection = await collectVirtualizedItems(page, {
      itemSelector: X_DOM.chatMessage,
      direction: "up",
      mergeOverlappingWindows: true,
      extractRound: async () => await extractChatMessages(page),
      identityOf: chatDomIdentity,
      identityIsStable: (item) => item.platformId !== null,
      shouldStop: (roundItems) => renderedWindowPrecedes(roundItems, from),
    }, signal);
    assertRenderedTimestamps(collection.items, "X Chat message");
    await requireCompleteCollection(page, target, collection.stopReason);
    const items = normalizeCollectedChatMessages(
      collection.items,
      target,
      from,
      to,
    );
    return { feed, target, items };
  }

  const collection = await collectVirtualizedItems(page, {
    itemSelector: X_DOM.timelinePost,
    direction: "down",
    extractRound: async () => await extractTimelineItems(page),
    identityOf: timelineDomIdentity,
    shouldStop: createPostBoundaryPredicate(from),
  }, signal);
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
): XRawChatMessage[] {
  const fallbackOccurrences = new Map<string, number>();
  return collected
    .filter((item) =>
      item.date !== null &&
      item.date >= from &&
      item.date <= to &&
      item.text !== ""
    )
    .map((item) => {
      if (item.platformId !== null) return toRawChatMessage(item, target, null);
      const identity = chatDomIdentity(item);
      const occurrence = fallbackOccurrences.get(identity) ?? 0;
      fallbackOccurrences.set(identity, occurrence + 1);
      return toRawChatMessage(item, target, occurrence);
    })
    .sort((left, right) =>
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
        await page.locator(X_DOM.chatComposer).count() > 0
      ) {
        return;
      }
    } else if (await page.locator(X_DOM.timelinePost).count() > 0) {
      return;
    }

    const visibleText = await extractVisibleMainText(page);
    if (
      target.kind === "chat"
        ? EMPTY_CHAT_TEXT.test(visibleText)
        : target.kind === "following"
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
  const renderedDates = items
    .map((item) => item.date)
    .filter((date): date is number => date !== null && Number.isFinite(date));
  return renderedDates.length > 0 &&
    renderedDates.every((date) => date < from);
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
  fallbackOccurrence: number | null,
): XRawChatMessage {
  const date = requireDate(item.date);
  return {
    kind: "chat_message",
    externalId: item.platformId ?? fallbackIdentity(
      "chat_message",
      date,
      item.author,
      item.text,
      formatXFeedExternalId(target),
      fallbackOccurrence,
    ),
    platformId: item.platformId,
    date,
    text: item.text,
    author: item.author,
    url: formatXTargetUrl(target),
    reactions: item.reactions,
  };
}

function timelineDomIdentity(item: XDomTimelineItem): string {
  return item.platformId ?? fallbackIdentity("post", item.date, item.author, item.text, item.url);
}

function chatDomIdentity(item: XDomChatMessage): string {
  return item.platformId ?? fallbackIdentity("chat_message", item.date, item.author, item.text, null);
}

function fallbackIdentity(
  kind: "post" | "chat_message",
  date: number | null,
  author: string | null,
  text: string,
  location: string | null,
  occurrence: number | null = null,
): string {
  const identityParts: unknown[] = [kind, date, author, text, location];
  if (occurrence !== null) identityParts.push(occurrence);
  const digest = createHash("sha256")
    .update(JSON.stringify(identityParts))
    .digest("hex");
  return `fallback:${digest}`;
}

function requireDate(value: number | null): number {
  if (value === null || !Number.isFinite(value)) throw new Error("X item has no rendered timestamp");
  return value;
}
