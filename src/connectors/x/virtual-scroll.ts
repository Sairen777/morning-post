import type { Page } from "playwright";

import { abortableDelay, throwIfAborted } from "./abort.ts";

const MAX_SCROLL_ROUNDS = 72;
const MAX_NO_PROGRESS_ROUNDS = 4;
const MAX_COLLECTED_ITEMS = 5_000;
const SCROLL_SETTLE_MS = 350;
const SCROLL_ACTION_TIMEOUT_MS = 5_000;

export interface XVirtualScrollOptions<T> {
  itemSelector: string;
  extractRound: () => Promise<T[]>;
  identityOf: (item: T) => string;
  direction?: "down" | "up";
  shouldStop?: (roundItems: T[], collectedItems: T[]) => boolean;
  maxRounds?: number;
  maxNoProgressRounds?: number;
  maxItems?: number;
  mergeOverlappingWindows?: boolean;
  identityIsStable?: (item: T) => boolean;
}

export type XVirtualScrollStopReason =
  | "condition"
  | "boundary"
  | "max_rounds"
  | "max_items";

export interface XVirtualScrollResult<T> {
  items: T[];
  stopReason: XVirtualScrollStopReason;
}


export async function collectVirtualizedItems<T>(
  page: Page,
  options: XVirtualScrollOptions<T>,
  signal?: AbortSignal,
): Promise<XVirtualScrollResult<T>> {
  const maxRounds = boundedPositiveInteger(options.maxRounds, MAX_SCROLL_ROUNDS, 1, MAX_SCROLL_ROUNDS);
  const maxNoProgressRounds = boundedPositiveInteger(
    options.maxNoProgressRounds,
    MAX_NO_PROGRESS_ROUNDS,
    1,
    MAX_NO_PROGRESS_ROUNDS,
  );
  const maxItems = boundedPositiveInteger(options.maxItems, MAX_COLLECTED_ITEMS, 1, MAX_COLLECTED_ITEMS);
  const direction = options.direction ?? "down";
  const seen = new Set<string>();
  const collected: T[] = [];
  let previousWindowIdentities: string[] = [];
  let movedIntoCurrentWindow = false;
  let boundaryStallRounds = 0;

  for (let round = 0; round < maxRounds; round += 1) {
    throwIfAborted(signal);
    const roundItems = await options.extractRound();
    const roundIdentities = options.mergeOverlappingWindows
      ? roundItems.map(options.identityOf)
      : [];
    const overlapResult = options.mergeOverlappingWindows
      ? orderedWindowOverlap(
        roundIdentities,
        previousWindowIdentities,
        direction,
      )
      : { length: 0, candidateCount: 0 };
    const overlap = overlapResult.length;
    const hasUnstableIdentity = !roundItems.every((item) =>
      options.identityIsStable?.(item) === true
    );
    if (
      options.mergeOverlappingWindows &&
      movedIntoCurrentWindow &&
      hasUnstableIdentity &&
      (
        overlapResult.candidateCount > 1 ||
        (
          roundItems.length > 0 &&
          overlap === roundItems.length &&
          overlap === previousWindowIdentities.length
        )
      )
    ) {
      throw new Error(
        "Virtualized collection could not reconcile a moved window without stable item identifiers",
      );
    }
    const firstNewIndex = direction === "down" ? overlap : 0;
    const endNewIndex = direction === "up"
      ? roundItems.length - overlap
      : roundItems.length;
    previousWindowIdentities = roundIdentities;

    let added = 0;
    let hitItemLimit = false;
    for (let index = firstNewIndex; index < endNewIndex; index += 1) {
      const item = roundItems[index]!;
      const identity = options.mergeOverlappingWindows
        ? roundIdentities[index]!
        : options.identityOf(item);
      if (
        !options.mergeOverlappingWindows ||
        options.identityIsStable?.(item) === true
      ) {
        if (seen.has(identity)) continue;
        seen.add(identity);
      }
      collected.push(item);
      added += 1;
      if (collected.length >= maxItems) {
        hitItemLimit = true;
        break;
      }
    }

    if (options.shouldStop?.(roundItems, collected) === true) {
      return { items: collected, stopReason: "condition" };
    }
    if (hitItemLimit) {
      return { items: collected, stopReason: "max_items" };
    }

    const moved = await advanceVirtualScroller(
      page,
      options.itemSelector,
      direction,
      signal,
    );
    await abortableDelay(SCROLL_SETTLE_MS, signal);
    movedIntoCurrentWindow = moved;
    boundaryStallRounds = added === 0 && !moved
      ? boundaryStallRounds + 1
      : 0;
    if (boundaryStallRounds >= maxNoProgressRounds) {
      return { items: collected, stopReason: "boundary" };
    }
  }
  return { items: collected, stopReason: "max_rounds" };
}

function orderedWindowOverlap(
  current: string[],
  previous: string[],
  direction: "down" | "up",
): { length: number; candidateCount: number } {
  const maximum = Math.min(current.length, previous.length);
  let length = 0;
  let candidateCount = 0;
  for (let overlap = 1; overlap <= maximum; overlap += 1) {
    let matches = true;
    for (let index = 0; index < overlap; index += 1) {
      const currentIndex = direction === "up"
        ? current.length - overlap + index
        : index;
      const previousIndex = direction === "up"
        ? index
        : previous.length - overlap + index;
      if (current[currentIndex] !== previous[previousIndex]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    length = overlap;
    candidateCount += 1;
  }
  return { length, candidateCount };
}

async function advanceVirtualScroller(
  page: Page,
  itemSelector: string,
  direction: "down" | "up",
  signal?: AbortSignal,
): Promise<boolean> {
  throwIfAborted(signal);
  const items = page.locator(itemSelector);
  const count = await items.count();
  const sign = direction === "up" ? -1 : 1;
  if (count > 0) {
    const edgeItem = items.nth(direction === "up" ? 0 : count - 1);
    await edgeItem.scrollIntoViewIfNeeded({ timeout: SCROLL_ACTION_TIMEOUT_MS });
    const moved = await edgeItem.evaluate((element, scrollSign) => {
      let ancestor = element.parentElement;
      while (ancestor) {
        const style = getComputedStyle(ancestor);
        if (
          ancestor.scrollHeight > ancestor.clientHeight + 2 &&
          /auto|scroll/.test(style.overflowY)
        ) {
          const before = ancestor.scrollTop;
          ancestor.scrollBy({
            top: scrollSign * Math.max(ancestor.clientHeight * 0.8, 320),
            behavior: "instant",
          });
          return Math.abs(ancestor.scrollTop - before) > 1;
        }
        ancestor = ancestor.parentElement;
      }
      const before = window.scrollY;
      window.scrollBy({
        top: scrollSign * Math.max(window.innerHeight * 0.8, 480),
        behavior: "instant",
      });
      return Math.abs(window.scrollY - before) > 1;
    }, sign);
    throwIfAborted(signal);
    return moved;
  }
  const moved = await page.evaluate((scrollSign) => {
    const before = window.scrollY;
    window.scrollBy({
      top: scrollSign * Math.max(window.innerHeight * 0.8, 480),
      behavior: "instant",
    });
    return Math.abs(window.scrollY - before) > 1;
  }, sign);
  throwIfAborted(signal);
  return moved;
}

function boundedPositiveInteger(
  requested: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (requested === undefined) return fallback;
  if (!Number.isSafeInteger(requested)) throw new Error("X scroll limit must be a safe integer");
  return Math.min(maximum, Math.max(minimum, requested));
}
