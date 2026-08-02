import { ConnectorId } from "../../constants.ts";
import type {
  AvailableFeed,
  Connector,
  NormalizedData,
  NormalizedItem,
} from "../connector.types.ts";
import type { XContentCache } from "../../repositories/x-content-cache-repository.ts";
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

export class XConnector implements Connector<XConnectorRawData> {
  private readonly lifetime = new AbortController();
  private readonly activeOperations = new Set<Promise<unknown>>();
  private disposed = false;

  constructor(
    private readonly client: XApiClient,
    private readonly cache: XContentCache,
    private readonly listQuery: string,
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
    for (const range of this.cache.missingRanges(externalId, from, to)) {
      throwIfAborted(signal);
      const items = target.kind === "list"
        ? await this.client.getListPosts(target.listId, range.from, range.to, signal)
        : await this.client.getChatMessages(
          target.conversationId,
          range.from,
          range.to,
          signal,
        );
      throwIfAborted(signal);
      this.cache.record(externalId, range, items);
    }
    return {
      feed,
      target,
      items: dedupeItems(this.cache.read(externalId, from, to)),
    };
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
