import { ConnectorId } from "../../constants.ts";
import type {
  AvailableFeed,
  Connector,
  NormalizedData,
  NormalizedItem,
} from "../connector.types.ts";
import type {
  XContentCache,
  XContentPageProgress,
  XTimeRange,
} from "../../repositories/x-content-cache-repository.ts";
import { combineAbortSignals, throwIfAborted } from "./abort.ts";
import {
  formatXFeedExternalId,
  parseXFeedExternalId,
} from "./targets.ts";
import type { XApiClient } from "./twex-api-client.ts";
import type {
  TwexConversation,
  XConnectorRawData,
  XRawFeedData,
  XRawItem,
  XTarget,
} from "./x.types.ts";

const MAX_SELECTED_FEEDS = 250;
export { MAX_SELECTED_FEEDS as MAX_X_ACTIVE_FEEDS };
const MAX_SEARCHED_LISTS = 100;
const MAX_LIST_PAGE_COUNT = 500;
const MAX_CHAT_PAGE_COUNT = 2;

/**
 * Default tolerated edge-sliver width for cache coverage. A tolerated sliver
 * is an uncovered head/tail range touching a requested window edge whose
 * inclusive duration does not exceed this value, and only when some coverage
 * exists inside the window; tolerated slivers are skipped without a provider
 * call. Zero disables the policy entirely.
 */
export const DEFAULT_X_CACHE_COVERAGE_TOLERANCE_MS = 600_000;

/**
 * Fixed local error for a list page whose next cursor repeats a cursor seen
 * earlier in the same range walk (same-cursor or A-B-A cycle). The successful
 * page is paid data and is durably recorded with a terminal block before this
 * error is raised, so no later operation can purchase another page of the
 * range until the account is disconnected and reconnected (which clears
 * retained progress).
 */
const X_REPEATED_CURSOR_BLOCKED_ERROR =
  "X list pagination detected a repeated cursor; the successful page was saved " +
  "and progress for this range is now blocked. Disconnect and reconnect the X " +
  "account to reset the retained progress before retrying";

/**
 * Fixed local error for any pending range whose progress is terminally
 * blocked (repeated cursor, missing cursor, or mismatched conversation): the
 * range can never be resumed, so operations whose current-window required
 * gaps intersect it fail locally before any provider request.
 */
const X_BLOCKED_PROGRESS_ERROR =
  "X progress for this range is blocked and cannot be resumed; disconnect and " +
  "reconnect the X account to reset the retained progress before retrying";

const X_MISMATCHED_CONVERSATION_ERROR =
  "X chat history answered for a different conversation; no items were kept " +
  "and progress for this range is now blocked. Disconnect and reconnect the X " +
  "account to reset the retained progress before retrying";

function missingCursorBlockedError(target: XTarget): string {
  return (
    `X ${target.kind} page was incomplete without a resume cursor; the successful ` +
    "page was saved and progress for this range is now blocked. Disconnect and " +
    "reconnect the X account to reset the retained progress before retrying"
  );
}

export class XConnector implements Connector<XConnectorRawData> {
  private readonly lifetime = new AbortController();
  private readonly activeOperations = new Set<Promise<unknown>>();
  private disposed = false;

  constructor(
    private readonly client: XApiClient,
    private readonly cache: XContentCache,
    private readonly listQuery: string,
    private readonly cacheCoverageToleranceMs =
      DEFAULT_X_CACHE_COVERAGE_TOLERANCE_MS,
  ) {}

  public async getRawData(
    from: number,
    to: number,
    feedExternalIds?: string[],
    signal?: AbortSignal,
  ): Promise<XConnectorRawData> {
    validateWindow(from, to);
    const explicitTargets = feedExternalIds === undefined
      ? undefined
      : parseSelectedTargets(feedExternalIds);
    if (explicitTargets?.length === 0) {
      this.assertUsable();
      throwIfAborted(signal);
      return {};
    }

    return await this.track(signal, async (operationSignal) => {
      const availableFeeds = explicitTargets === undefined
        ? await this.resolveAvailableFeeds(operationSignal)
        : explicitTargets.map(fallbackFeed);
      if (availableFeeds.length > MAX_SELECTED_FEEDS) {
        throw new Error(`X collection is limited to ${MAX_SELECTED_FEEDS} feeds per batch`);
      }

      const result: XConnectorRawData = {};
      for (const feed of availableFeeds) {
        throwIfAborted(operationSignal);
        const target = parseXFeedExternalId(feed.externalId);
        result[feed.externalId] = await this.collectTarget(
          target,
          feed,
          from,
          to,
          operationSignal,
        );
      }
      return result;
    });
  }

  public async getNormalizedData(
    from: number,
    to: number,
    feedExternalIds?: string[],
    signal?: AbortSignal,
  ): Promise<NormalizedData> {
    const rawData = await this.getRawData(from, to, feedExternalIds, signal);
    throwIfAborted(combineAbortSignals(signal, this.lifetime.signal));
    const result: NormalizedData = {};
    for (const [feedExternalId, feedData] of Object.entries(rawData)) {
      result[feedExternalId] = feedData.items
        .filter((item) => item.date >= from && item.date <= to)
        .map((item) => normalizeItem(feedExternalId, item));
    }
    return result;
  }

  public async listAvailableFeeds(signal?: AbortSignal): Promise<AvailableFeed[]> {
    return await this.track(signal, async (operationSignal) => {
      return await this.resolveAvailableFeeds(operationSignal);
    });
  }

  public async dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      this.lifetime.abort(new DOMException("X connector disposed", "AbortError"));
    }
    await Promise.allSettled(Array.from(this.activeOperations));
  }

  private async resolveAvailableFeeds(signal: AbortSignal): Promise<AvailableFeed[]> {
    const discoveryController = new AbortController();
    const discoverySignal = combineAbortSignals(
      signal,
      discoveryController.signal,
    ) ?? signal;
    let firstFailure: unknown;
    let hasFailure = false;
    const listsPromise = Promise.resolve()
      .then(() =>
        this.client.searchLists(
          this.listQuery,
          MAX_SEARCHED_LISTS,
          discoverySignal,
        )
      )
      .catch((error) => {
        if (!hasFailure) {
          hasFailure = true;
          firstFailure = error;
          discoveryController.abort(error);
        }
        throw error;
      });
    const conversationsPromise = Promise.resolve()
      .then(() => this.client.getConversations(discoverySignal))
      .catch((error) => {
        if (!hasFailure) {
          hasFailure = true;
          firstFailure = error;
          discoveryController.abort(error);
        }
        throw error;
      });
    const [listsResult, conversationsResult] = await Promise.allSettled([
      listsPromise,
      conversationsPromise,
    ]);
    if (hasFailure) throw firstFailure;
    if (listsResult.status === "rejected") throw listsResult.reason;
    if (conversationsResult.status === "rejected") {
      throw conversationsResult.reason;
    }
    const lists = listsResult.value;
    const conversations = conversationsResult.value;

    const feeds: AvailableFeed[] = [];
    const seen = new Set<string>();
    for (const list of lists) {
      const externalId = formatXFeedExternalId({ kind: "list", listId: list.id });
      if (seen.has(externalId)) continue;
      seen.add(externalId);
      feeds.push({ externalId, name: list.name, kind: "news" });
    }
    for (const conversation of conversations) {
      if (conversation.type !== "group") continue;
      const externalId = formatXFeedExternalId({
        kind: "chat",
        conversationId: conversation.conversation_id,
      });
      if (seen.has(externalId)) continue;
      seen.add(externalId);
      feeds.push({
        externalId,
        name: groupLabel(conversation),
        kind: "discussion",
      });
    }
    return feeds.sort(compareFeeds);
  }

  private async collectTarget(
    target: XTarget,
    feed: AvailableFeed,
    from: number,
    to: number,
    signal: AbortSignal,
  ): Promise<XRawFeedData> {
    const externalId = feed.externalId;
    let chatRequests = 0;
    // Tolerance-filtered gaps of the requested window. Pending progress is
    // resumed only when it intersects one of these: uncovered portions of
    // pending ranges outside this digest must never force a provider call.
    let requiredGaps = applyCacheCoverageTolerance(
      this.cache.missingRanges(externalId, from, to),
      from,
      to,
      this.cacheCoverageToleranceMs,
    );
    const pending = this.cache.pendingRanges(externalId, from, to);
    // Pre-scan the whole pending set before any provider request: a blocked
    // row intersecting a required gap of this window must fail locally first,
    // so an earlier resumable row is never purchased before the block is
    // reported. Rows that do not intersect a required gap (fully covered or
    // tolerance-suppressed windows) never trigger this and stay zero-call.
    this.assertNoBlockedPending(pending, requiredGaps, signal);
    for (const progress of pending) {
      throwIfAborted(signal);
      if (requiredGaps.length === 0) continue;
      if (!requiredGaps.some((gap) => rangesOverlap(gap, progress.range))) {
        continue;
      }
      this.throwIfChatQuotaExceeded(target, chatRequests);
      await this.collectRange(
        target,
        externalId,
        progress.range,
        progress.nextCursor,
        progress.pageCount,
        signal,
      );
      if (target.kind === "chat") chatRequests += 1;
      // A completed pending range may cover whole required gaps; re-derive
      // before deciding whether any remaining pending row still needs work.
      requiredGaps = applyCacheCoverageTolerance(
        this.cache.missingRanges(externalId, from, to),
        from,
        to,
        this.cacheCoverageToleranceMs,
      );
      // Re-scan the remaining rows against the recomputed gaps before
      // another provider request, so a blocked row can never be bypassed by
      // an earlier completion changing which rows are relevant.
      this.assertNoBlockedPending(pending, requiredGaps, signal);
    }

    // Fresh chat gaps are coalesced into one encompassing range so a single
    // all-mode request covers every requested hole in this operation.
    let gaps = requiredGaps;
    if (target.kind === "chat" && gaps.length > 1) {
      gaps = [{ from: gaps[0].from, to: gaps[gaps.length - 1].to }];
    }
    for (const range of gaps) {
      throwIfAborted(signal);
      this.throwIfChatQuotaExceeded(target, chatRequests);
      await this.collectRange(target, externalId, range, null, 0, signal);
      if (target.kind === "chat") chatRequests += 1;
    }

    return {
      feed,
      target,
      items: dedupeItems(this.cache.read(externalId, from, to)),
    };
  }

  private throwIfChatQuotaExceeded(target: XTarget, chatRequests: number): void {
    if (target.kind === "chat" && chatRequests > 0) {
      throw new Error(
        "X chat collection would require a second DM-history request for this feed; " +
          "remaining ranges are resumable from the persisted cursor",
      );
    }
  }

  /**
   * Fails locally before any provider request when a pending row with a
   * terminal block reason intersects a required gap of the current window.
   * Rows outside the required gaps are irrelevant to this digest and never
   * trigger the failure.
   */
  private assertNoBlockedPending(
    pending: XContentPageProgress[],
    requiredGaps: XTimeRange[],
    signal: AbortSignal,
  ): void {
    for (const progress of pending) {
      throwIfAborted(signal);
      if (requiredGaps.length === 0) return;
      if (!requiredGaps.some((gap) => rangesOverlap(gap, progress.range))) {
        continue;
      }
      // A terminally blocked range can never be resumed: fail locally before
      // any provider request, so a manual digest can never purchase another
      // page of it.
      if (progress.blockedReason !== null) {
        throw new Error(X_BLOCKED_PROGRESS_ERROR);
      }
    }
  }

  private async collectRange(
    target: XTarget,
    feedExternalId: string,
    range: XTimeRange,
    initialCursor: string | null,
    initialPageCount: number,
    signal: AbortSignal,
  ): Promise<void> {
    let cursor = initialCursor;
    let pageCount = initialPageCount;
    for (;;) {
      throwIfAborted(signal);
      if (target.kind === "list" && pageCount >= MAX_LIST_PAGE_COUNT) {
        throw new Error(
          "X list pagination exceeded the safety page limit; saved progress is resumable",
        );
      }
      if (target.kind === "chat" && pageCount >= MAX_CHAT_PAGE_COUNT) {
        throw new Error(
          "X chat pagination reached the two-request safety page limit after incomplete all-mode responses; no provider request was made. Disconnect and reconnect X to reset the retained progress before retrying this range",
        );
      }

      const page = target.kind === "list"
        ? await this.client.getListPostsPage(
          target.listId,
          range.from,
          range.to,
          cursor,
          signal,
        )
        : await this.client.getChatMessagesPage(
          target.conversationId,
          range.from,
          range.to,
          cursor,
          signal,
        );

      // A terminal page (e.g. the provider answered for a different
      // conversation than the one requested) is not paid data for this range:
      // an empty page is durably recorded with the terminal reason before the
      // abort state is re-checked, so no later operation can purchase another
      // page of this range.
      if (page.terminalReason !== undefined) {
        const progress = this.cache.recordPage(feedExternalId, range, [], null, {
          blockedReason: page.terminalReason,
        });
        pageCount = progress.pageCount;
        throwIfAborted(signal);
        throw new Error(X_MISMATCHED_CONVERSATION_ERROR);
      }
      // A successful provider page is paid data: it must be durably recorded
      // before any abort state is re-checked, so an abort racing the response
      // can never discard fetched items, progress, or coverage. The next
      // iteration's pre-request check still blocks further HTTP.
      if (page.complete) {
        this.cache.record(feedExternalId, range, page.items);
        throwIfAborted(signal);
        return;
      }
      if (page.nextCursor === null) {
        // The provider marked the range incomplete without any resume cursor.
        // The page is still paid data: it is durably recorded with a terminal
        // block before the abort state is re-checked, so neither an abort nor
        // the billing-safety error below can discard it, and no later
        // operation can purchase another page of this range.
        const progress = this.cache.recordPage(
          feedExternalId,
          range,
          page.items,
          null,
          { blockedReason: "missing_cursor" },
        );
        pageCount = progress.pageCount;
        throwIfAborted(signal);
        if (progress.blockedReason === "missing_cursor") {
          throw new Error(missingCursorBlockedError(target));
        }
        throw new Error(X_BLOCKED_PROGRESS_ERROR);
      }
      // Repetition is the cache's job: the page, its cursor, and the durable
      // seen-cursor set are updated in one atomic write, so a cycle is caught
      // even when earlier pages were fetched by other connector instances.
      // The returned progress carries the terminal block reason.
      const progress = this.cache.recordPage(
        feedExternalId,
        range,
        page.items,
        page.nextCursor,
      );
      pageCount = progress.pageCount;
      throwIfAborted(signal);
      if (progress.blockedReason !== null) {
        throw new Error(X_REPEATED_CURSOR_BLOCKED_ERROR);
      }
      cursor = page.nextCursor;

      if (target.kind === "chat") {
        throw new Error(
          "X chat history remained incomplete after one provider request; " +
            "saved progress is resumable from the persisted cursor",
        );
      }
    }
  }

  private async track<T>(
    signal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.assertUsable();
    const operationSignal = combineAbortSignals(signal, this.lifetime.signal) ?? this.lifetime.signal;
    throwIfAborted(operationSignal);
    let tracked: Promise<T>;
    tracked = operation(operationSignal).finally(() => {
      this.activeOperations.delete(tracked);
    });
    this.activeOperations.add(tracked);
    return await tracked;
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error("X connector has been disposed");
  }
}

function parseSelectedTargets(feedExternalIds: string[]): XTarget[] {
  if (feedExternalIds.length > MAX_SELECTED_FEEDS) {
    throw new Error(`X collection is limited to ${MAX_SELECTED_FEEDS} feeds per batch`);
  }
  const targets: XTarget[] = [];
  const seen = new Set<string>();
  for (const externalId of feedExternalIds) {
    const target = parseXFeedExternalId(externalId);
    const canonicalExternalId = formatXFeedExternalId(target);
    if (seen.has(canonicalExternalId)) continue;
    seen.add(canonicalExternalId);
    targets.push(target);
  }
  return targets;
}

function validateWindow(from: number, to: number): void {
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    throw new Error("X collection window must contain finite epoch milliseconds");
  }
  if (from > to) throw new Error("X collection window start must not exceed its end");
}

/**
 * Cache coverage tolerance: suppresses only small uncovered head/tail slivers
 * that touch the requested window edges, and only when some coverage exists
 * inside the window. A wholly uncovered window and any internal gap are never
 * suppressed. Stored coverage is never mutated or expanded: callers keep the
 * returned missing ranges as the persisted-coverage ledger.
 */
export function applyCacheCoverageTolerance(
  gaps: XTimeRange[],
  from: number,
  to: number,
  toleranceMs: number,
): XTimeRange[] {
  if (toleranceMs <= 0 || gaps.length === 0) return gaps;
  // The single gap spanning the whole window means no coverage exists inside
  // it; a wholly uncovered window is never suppressed, however short it is.
  if (gaps.length === 1 && gaps[0].from === from && gaps[0].to === to) {
    return gaps;
  }
  return gaps.filter(
    (gap) =>
      gap.to - gap.from + 1 > toleranceMs ||
      (gap.from !== from && gap.to !== to),
  );
}


function rangesOverlap(left: XTimeRange, right: XTimeRange): boolean {
  return left.from <= right.to && right.from <= left.to;
}

function dedupeItems(items: XRawItem[]): XRawItem[] {
  const seen = new Set<string>();
  const result: XRawItem[] = [];
  for (const item of items) {
    if (seen.has(item.externalId)) continue;
    seen.add(item.externalId);
    result.push(item);
  }
  return result;
}

function groupLabel(conversation: TwexConversation): string {
  return `Group (${conversation.participants.length} participants) - ${conversation.conversation_id}`;
}

function fallbackFeed(target: XTarget): AvailableFeed {
  switch (target.kind) {
    case "list":
      return {
        externalId: formatXFeedExternalId(target),
        name: `List ${target.listId}`,
        kind: "news",
      };
    case "chat":
      return {
        externalId: formatXFeedExternalId(target),
        name: `Chat ${target.conversationId}`,
        kind: "discussion",
      };
  }
}

function compareFeeds(left: AvailableFeed, right: AvailableFeed): number {
  if (left.kind !== right.kind) return left.kind === "news" ? -1 : 1;
  return left.name.localeCompare(right.name)
    || left.externalId.localeCompare(right.externalId);
}

function normalizeItem(feedExternalId: string, item: XRawItem): NormalizedItem {
  if (item.kind === "chat_message") {
    const reactionCount = item.reactions.reduce((total, reaction) => total + reaction.count, 0);
    return {
      connectorId: ConnectorId.X,
      feedExternalId,
      externalId: item.externalId,
      date: item.date,
      title: null,
      text: item.text,
      author: item.author,
      url: item.url,
      meta: {
        messageKind: "chat",
        reactions: item.reactions,
        reactionCount,
        reactedByViewer: item.reactions.some((reaction) => reaction.reactedByViewer),
      },
    };
  }

  const metrics: Record<string, number> = {};
  if (item.replyCount !== null) metrics.replies = item.replyCount;
  if (item.repostCount !== null) metrics.reposts = item.repostCount;
  if (item.likeCount !== null) metrics.likes = item.likeCount;
  if (item.viewCount !== null) metrics.views = item.viewCount;
  return {
    connectorId: ConnectorId.X,
    feedExternalId,
    externalId: item.externalId,
    date: item.date,
    title: null,
    text: item.text,
    author: item.author,
    url: item.url,
    meta: {
      messageKind: "post",
      ...(Object.keys(metrics).length === 0 ? {} : { metrics }),
    },
  };
}
