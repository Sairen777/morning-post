import { ConnectorId } from "../../constants.ts";
import type {
  AvailableFeed,
  Connector,
  NormalizedData,
  NormalizedItem,
} from "../connector.types.ts";
import { combineAbortSignals, throwIfAborted } from "./abort.ts";
import type { XBrowserSessions } from "./browser-session.ts";
import { collectXTarget } from "./collection.ts";
import { discoverXFeedsOnPage } from "./discovery.ts";
import {
  formatXFeedExternalId,
  parseXFeedExternalId,
} from "./targets.ts";
import type {
  XConnectorRawData,
  XRawItem,
  XTarget,
} from "./x.types.ts";

export const MAX_X_FEEDS = 250;

export class XConnector implements Connector<XConnectorRawData> {
  private readonly lifetime = new AbortController();
  private readonly activeOperations = new Set<Promise<unknown>>();
  private disposed = false;

  constructor(
    private readonly sessions: XBrowserSessions,
    private readonly profileId: string,
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
      return await this.sessions.withHeadless(this.profileId, operationSignal, async ({ page }) => {
        const targets = explicitTargets ?? (await discoverXFeedsOnPage(page, operationSignal))
          .map((feed) => parseXFeedExternalId(feed.externalId));
        if (targets.length > MAX_X_FEEDS) {
          throw new Error(`X collection is limited to ${MAX_X_FEEDS} feeds per batch`);
        }

        const result: XConnectorRawData = {};
        for (const target of targets) {
          throwIfAborted(operationSignal);
          const externalId = formatXFeedExternalId(target);
          result[externalId] = await collectXTarget(
            page,
            target,
            from,
            to,
            operationSignal,
          );
        }
        return result;
      });
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
      return await this.sessions.withHeadless(this.profileId, operationSignal, async ({ page }) => {
        return await discoverXFeedsOnPage(page, operationSignal);
      });
    });
  }

  public async dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      this.lifetime.abort(new DOMException("X connector disposed", "AbortError"));
    }
    await Promise.allSettled(Array.from(this.activeOperations));
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
  if (feedExternalIds.length > MAX_X_FEEDS) {
    throw new Error(`X collection is limited to ${MAX_X_FEEDS} feeds per batch`);
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
        ...(item.author !== null
          ? { authorKind: item.viewerAuthored === true ? "viewer" : "sender" }
          : {}),
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
