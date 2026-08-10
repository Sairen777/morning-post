import type { Page } from "playwright";

import { abortableDelay, throwIfAborted } from "./abort.ts";

const MAX_SCROLL_ROUNDS = 72;
const MAX_NO_PROGRESS_ROUNDS = 4;
const MAX_COLLECTED_ITEMS = 5_000;
const PRODUCTIVE_WAIT_MS = 1_000;
const NO_NEW_WINDOW_WAIT_MS: readonly number[] = [1_500, 2_500, 4_000];
const MAX_NO_NEW_WAIT_INDEX = NO_NEW_WINDOW_WAIT_MS.length - 1;
const EDGE_EVALUATE_TIMEOUT_MS = 5_000;

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
  | "no_progress"
  | "max_rounds"
  | "max_items";

export type XVirtualScrollWait = (
  milliseconds: number,
  signal?: AbortSignal,
) => Promise<void>;

export interface XVirtualScrollResult<T> {
  items: T[];
  stopReason: XVirtualScrollStopReason;
}


export async function collectVirtualizedItems<T>(
  page: Page,
  options: XVirtualScrollOptions<T>,
  signal?: AbortSignal,
  wait: XVirtualScrollWait = abortableDelay,
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
  let hasAdvanced = false;
  let movedIntoCurrentWindow = false;
  let consecutiveNoNewWindows = 0;
  let sawMovementInNoNewStreak = false;
  let noNewStreakStartedBeforeAdvance = false;
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

    if (added === 0) {
      if (consecutiveNoNewWindows === 0 && !hasAdvanced) {
        noNewStreakStartedBeforeAdvance = true;
      }
      consecutiveNoNewWindows += 1;
      if (hasAdvanced) {
        sawMovementInNoNewStreak ||= movedIntoCurrentWindow;
      }
    } else {
      consecutiveNoNewWindows = 0;
      sawMovementInNoNewStreak = false;
      noNewStreakStartedBeforeAdvance = false;
      boundaryStallRounds = 0;
    }
    const settledNoNewWindows = noNewStreakStartedBeforeAdvance
      ? consecutiveNoNewWindows - 1
      : consecutiveNoNewWindows;
    if (
      hasAdvanced &&
      settledNoNewWindows >= maxNoProgressRounds &&
      sawMovementInNoNewStreak
    ) {
      if (
        movedIntoCurrentWindow ||
        boundaryStallRounds + 1 < maxNoProgressRounds
      ) {
        return { items: collected, stopReason: "no_progress" };
      }
      // The most recent windows stopped moving and one more probe would
      // prove a boundary: issue that pending probe before concluding. A
      // non-moving probe proves the boundary; a moving one still fails
      // closed as no_progress because the rendered window was never
      // proven complete, so consumers must discard the collection.
      const moved = await advanceVirtualScroller(
        page,
        options.itemSelector,
        direction,
        signal,
      );
      return {
        items: collected,
        stopReason: moved ? "no_progress" : "boundary",
      };
    }

    const isFinalRound = round + 1 >= maxRounds;
    const moved = await advanceVirtualScroller(
      page,
      options.itemSelector,
      direction,
      signal,
    );
    hasAdvanced = true;
    movedIntoCurrentWindow = moved;
    boundaryStallRounds = added === 0 && !moved
      ? boundaryStallRounds + 1
      : 0;
    if (boundaryStallRounds >= maxNoProgressRounds) {
      return { items: collected, stopReason: "boundary" };
    }
    if (isFinalRound) {
      break;
    }
    await wait(
      added > 0
        ? PRODUCTIVE_WAIT_MS
        : NO_NEW_WINDOW_WAIT_MS[
          Math.min(consecutiveNoNewWindows - 1, MAX_NO_NEW_WAIT_INDEX)
        ],
      signal,
    );
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
    // No scrollIntoViewIfNeeded here: virtualized windows re-render on
    // scroll and can detach the edge element while Playwright is still
    // acting on it. The synchronous ancestor walk below both locates the
    // scroller and advances it in one atomic evaluation.
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
            top: scrollSign * Math.max(ancestor.clientHeight * 0.5, 240),
            behavior: "instant",
          });
          return Math.abs(ancestor.scrollTop - before) > 1;
        }
        ancestor = ancestor.parentElement;
      }
      const before = window.scrollY;
      window.scrollBy({
        top: scrollSign * Math.max(window.innerHeight * 0.5, 320),
        behavior: "instant",
      });
      return Math.abs(window.scrollY - before) > 1;
    }, sign, { timeout: EDGE_EVALUATE_TIMEOUT_MS });
    throwIfAborted(signal);
    return moved;
  }
  const moved = await page.evaluate((scrollSign) => {
    const before = window.scrollY;
    window.scrollBy({
      top: scrollSign * Math.max(window.innerHeight * 0.5, 320),
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
