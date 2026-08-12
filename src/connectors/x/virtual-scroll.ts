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
  /**
   * Optional exact scroller element. When supplied, every advance moves
   * this element directly (measured by its own scrollTop) instead of
   * walking rendered items for a nearer scrollable ancestor, and the
   * boundary proof comes from its real top/bottom. An absent, ambiguous,
   * or unusable configured scroller fails closed instead of certifying a
   * partial boundary.
   */
  scrollerSelector?: string;
  /**
   * When true (requires scrollerSelector), each explicit-mode advance first
   * dispatches a deterministic wheel-intent signal on the exact scroller
   * so an app that re-pins programmatic scrolls (X Chat's DM list) treats
   * the movement as user-initiated and leaves it in place.
   */
  dispatchWheelIntent?: boolean;
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

interface XVirtualScrollAdvance {
  moved: boolean;
  atEdgeIntent: boolean;
}


export async function collectVirtualizedItems<T>(
  page: Page,
  options: XVirtualScrollOptions<T>,
  signal?: AbortSignal,
  wait: XVirtualScrollWait = abortableDelay,
): Promise<XVirtualScrollResult<T>> {
  if (options.dispatchWheelIntent === true && options.scrollerSelector === undefined) {
    throw new Error(
      "X virtual scroll wheel intent requires an explicit scrollerSelector; refusing to scroll an implicit scroller",
    );
  }
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
  let atEdgeIntentSettled = false;

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
      atEdgeIntentSettled = false;
    }
    const settledNoNewWindows = noNewStreakStartedBeforeAdvance
      ? consecutiveNoNewWindows - 1
      : consecutiveNoNewWindows;
    if (
      hasAdvanced &&
      settledNoNewWindows >= maxNoProgressRounds &&
      sawMovementInNoNewStreak
    ) {
      // The current round already extracted and settled the moved window.
      // A non-moving probe proves the boundary only after any first wheel
      // intent dispatched at that edge has received one waited extraction.
      const advance = await advanceVirtualScroller(
        page,
        options.itemSelector,
        direction,
        signal,
        options.scrollerSelector,
        options.dispatchWheelIntent === true,
      );
      if (!advance.moved) {
        if (advance.atEdgeIntent && !atEdgeIntentSettled) {
          atEdgeIntentSettled = true;
          movedIntoCurrentWindow = false;
          boundaryStallRounds = 0;
          if (round + 1 >= maxRounds) break;
          await wait(NO_NEW_WINDOW_WAIT_MS[MAX_NO_NEW_WAIT_INDEX], signal);
          continue;
        }
        return { items: collected, stopReason: "boundary" };
      }
      atEdgeIntentSettled = false;
      // The deciding probe moved. In explicit mode such a move can be an
      // async top-reflow offset being corrected back to the real edge:
      // verify the configured scroller's real directional edge before
      // failing closed. A mid-list or pinned scroller is not at its real
      // edge and still fails closed as no_progress.
      if (
        options.scrollerSelector === undefined ||
        !(await explicitScrollerAtRealEdge(
          page,
          options.scrollerSelector,
          direction,
          signal,
        ))
      ) {
        return { items: collected, stopReason: "no_progress" };
      }
      // The probe itself reached the real edge, so the edge window was
      // never extracted: record the moved state and settle so the next
      // round extracts that window. Its deciding probe then proves the
      // boundary if it does not move; new rows reset to progress; renewed
      // non-edge movement still fails closed as no_progress.
      movedIntoCurrentWindow = true;
      hasAdvanced = true;
      boundaryStallRounds = 0;
      if (round + 1 >= maxRounds) {
        break;
      }
      await wait(NO_NEW_WINDOW_WAIT_MS[MAX_NO_NEW_WAIT_INDEX], signal);
      continue;
    }

    const isFinalRound = round + 1 >= maxRounds;
    const advance = await advanceVirtualScroller(
      page,
      options.itemSelector,
      direction,
      signal,
      options.scrollerSelector,
      options.dispatchWheelIntent === true,
    );
    hasAdvanced = true;
    const needsEdgeIntentSettlement = !advance.moved &&
      advance.atEdgeIntent &&
      !atEdgeIntentSettled;
    if (advance.moved) {
      atEdgeIntentSettled = false;
    } else if (needsEdgeIntentSettlement) {
      atEdgeIntentSettled = true;
    }
    movedIntoCurrentWindow = advance.moved;
    boundaryStallRounds = needsEdgeIntentSettlement
      ? 0
      : added === 0 && !advance.moved
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
  scrollerSelector?: string,
  dispatchWheelIntent = false,
): Promise<XVirtualScrollAdvance> {
  throwIfAborted(signal);
  const sign = direction === "up" ? -1 : 1;
  if (scrollerSelector !== undefined) {
    const scroller = page.locator(scrollerSelector);
    const scrollerCount = await scroller.count();
    if (scrollerCount === 0) {
      throw new Error(
        `X virtual scroll scroller selector "${scrollerSelector}" matched no element; refusing to certify a partial boundary`,
      );
    }
    if (scrollerCount !== 1) {
      throw new Error(
        `X virtual scroll scroller selector "${scrollerSelector}" matched ${scrollerCount} elements; expected exactly one`,
      );
    }
    const items = page.locator(itemSelector);
    const itemCount = await items.count();
    const edgeIndex = direction === "up" ? 0 : Math.max(0, itemCount - 1);
    const moved = await scroller.evaluate((element, config) => {
      if (!(element instanceof HTMLElement)) {
        throw new Error(
          "X virtual scroll scroller selector matched a non-HTMLElement; refusing to scroll it",
        );
      }
      const before = element.scrollTop;
      const range = element.scrollHeight - element.clientHeight;
      const style = getComputedStyle(element);
      const overflowScrolls = /auto|scroll/.test(style.overflowY);
      // An element whose content overflows but that cannot itself scroll
      // (hidden, clip, or visible overflow) can never reach or prove a
      // boundary: the overflowing rows are unreachable, so the
      // configuration is unusable and must fail closed rather than treat
      // the clipped content as a full-fit boundary.
      if (range > 2 && !overflowScrolls) {
        throw new Error(
          `X virtual scroll scroller selector matched an unusable scroller: content overflows but computed overflowY is "${style.overflowY}", not auto/scroll; refusing to certify a partial boundary`,
        );
      }
      // Fail closed before any boundary claim: the configured element must
      // contain the rendered items. An unrelated element must never
      // certify completeness, even when it is itself at a real edge.
      if (config.hasItems) {
        const edge = document.querySelectorAll(config.itemSelector)[config.edgeIndex];
        if (!(edge instanceof Element) || !element.contains(edge)) {
          throw new Error(
            "X virtual scroll scroller selector matched an element that does not contain the rendered items; refusing to certify a partial boundary",
          );
        }
        // A positive-range auto/scroll configured element owns the rows:
        // explicit mode moves it directly, so nearer nested scrollable
        // decoys are intentionally overridden. Only when the configured
        // element itself cannot scroll (range <= 2) does a nested element
        // with real scrollable overflow prove that it, not the configured
        // element, actually scrolls the items; certifying a full-fit
        // boundary then would silently drop the rest of the conversation,
        // so the configuration must fail closed.
        if (!(range > 2 && overflowScrolls)) {
          let ancestor = edge.parentElement;
          while (ancestor && ancestor !== element) {
            const ancestorStyle = getComputedStyle(ancestor);
            if (
              ancestor.scrollHeight > ancestor.clientHeight + 2 &&
              /auto|scroll/.test(ancestorStyle.overflowY)
            ) {
              throw new Error(
                "X virtual scroll scroller selector matched an element with no scrollable overflow while a nested element actually scrolls the items; refusing to certify a partial boundary",
              );
            }
            ancestor = ancestor.parentElement;
          }
        }
      }
      const step = config.sign * Math.max(element.clientHeight * 0.5, 240);
      const atEdgeBeforeIntent = range > 2 && overflowScrolls
        ? config.sign < 0
          ? before <= 1
          : range - before <= 1
        : true;
      if (config.dispatchWheelIntent) {
        // Dispatch intent even at the real edge. X may fetch and prepend an
        // older Chat page only after an upward wheel reaches that edge; a
        // no-movement probe that omits the event would certify the currently
        // loaded segment as the conversation boundary too early.
        element.dispatchEvent(new WheelEvent("wheel", {
          deltaY: step,
          bubbles: true,
          cancelable: true,
        }));
      }
      // A synchronous edge handler may have prepended content and adjusted
      // scroll anchoring, so measure the owner again after wheel intent.
      const currentRange = element.scrollHeight - element.clientHeight;
      if (currentRange > 2 && overflowScrolls) {
        const beforeScroll = element.scrollTop;
        // At the validated owner's own real top/bottom no movement is
        // possible. The caller settles a first at-edge intent through one
        // more waited extraction before accepting a repeated edge as proof.
        if (config.sign < 0 ? beforeScroll <= 1 : currentRange - beforeScroll <= 1) {
          return {
            moved: false,
            atEdgeIntent: config.dispatchWheelIntent && atEdgeBeforeIntent,
          };
        }
        element.scrollBy({ top: step, behavior: "instant" });
        return {
          moved: Math.abs(element.scrollTop - beforeScroll) > 1,
          atEdgeIntent: false,
        };
      }
      // Range <= 2 with a validated owner: only a genuine full-fit
      // boundary is acceptable after a first edge intent has settled.
      return {
        moved: false,
        atEdgeIntent: config.dispatchWheelIntent && atEdgeBeforeIntent,
      };
    }, {
      sign,
      itemSelector,
      edgeIndex,
      hasItems: itemCount > 0,
      dispatchWheelIntent,
    }, { timeout: EDGE_EVALUATE_TIMEOUT_MS });
    throwIfAborted(signal);
    return moved;
  }
  const items = page.locator(itemSelector);
  const count = await items.count();
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
    return { moved, atEdgeIntent: false };
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
  return { moved, atEdgeIntent: false };
}

// Explicit-mode edge verification for a deciding probe that moved: an
// async top reflow can drift scrollTop away from the real edge, and a
// move that lands on the configured scroller's real directional edge is
// that drift being corrected, not renewed content movement. Returns false
// (fail closed) unless exactly one HTMLElement matched and it sits at the
// real directional edge.
async function explicitScrollerAtRealEdge(
  page: Page,
  scrollerSelector: string,
  direction: "down" | "up",
  signal?: AbortSignal,
): Promise<boolean> {
  const scroller = page.locator(scrollerSelector);
  const scrollerCount = await scroller.count();
  if (scrollerCount !== 1) {
    return false;
  }
  const atEdge = await scroller.evaluate((element, scrollDirection) => {
    if (!(element instanceof HTMLElement)) {
      return false;
    }
    const range = element.scrollHeight - element.clientHeight;
    return scrollDirection === "up"
      ? element.scrollTop <= 1
      : range - element.scrollTop <= 1;
  }, direction, { timeout: EDGE_EVALUATE_TIMEOUT_MS });
  throwIfAborted(signal);
  return atEdge;
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
