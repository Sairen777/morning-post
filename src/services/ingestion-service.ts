import type {
  Connector,
  NormalizedItem,
} from "../connectors/connector.types.ts";
import type { Database } from "../db/client.ts";
import type { PublicFeed } from "../repositories/feed-repository.ts";
import { setLastFetched } from "../repositories/feed-repository.ts";
import {
  upsertItems,
  validateNormalizedItems,
} from "../repositories/item-repository.ts";
import { ValidationError } from "../server/errors.ts";
import { getConfig } from "../config.ts";

const DEFAULT_INGESTION_LOOKBACK_MS = 24 * 60 * 60 * 1_000;

export interface IngestionWindow {
  from: number;
  to: number;
}

export interface IngestFeedOptions {
  now?: () => number;
  defaultLookbackMs?: number;
  window?: IngestionWindow;
  fetchedAt?: number;
  /** Per-feed window overrides keyed by feed id. Overrides `window` and cursor-based computation for the specified feeds. */
  feedWindows?: Map<string, IngestionWindow>;
  signal?: AbortSignal;
  connectorTimeoutMs?: number;
  concurrency?: number;
}

export interface IngestFeedResult {
  feedId: string;
  window: IngestionWindow;
  itemCount: number;
}

export function computeIngestionWindow(
  feed: PublicFeed,
  options: IngestFeedOptions = {},
): IngestionWindow {
  if (options.window) {
    return options.window;
  }
  const to = options.now?.() ?? Date.now();
  const defaultLookbackMs = options.defaultLookbackMs ??
    DEFAULT_INGESTION_LOOKBACK_MS;
  const from = feed.lastFetchedPeriodEndMs === null
    ? to - defaultLookbackMs
    : feed.lastFetchedPeriodEndMs + 1;
  return { from, to };
}

function validateFeedItems(
  feed: PublicFeed,
  normalizedItems: NormalizedItem[],
): NormalizedItem[] {
  const validItems = validateNormalizedItems(normalizedItems);
  for (const item of validItems) {
    if (item.feedExternalId !== feed.externalId) {
      throw new ValidationError("normalized item belongs to a different feed");
    }
  }
  return validItems;
}

export async function ingestFeed(
  database: Database,
  userId: string,
  feed: PublicFeed,
  connector: Connector<unknown>,
  options: IngestFeedOptions = {},
): Promise<IngestFeedResult> {
  const window = computeIngestionWindow(feed, options);
  const normalizedData = await connector.getNormalizedData(
    window.from,
    window.to,
    [feed.externalId],
    options.signal,
  );
  if (options.signal?.aborted) {
    throw new IngestionAbortError();
  }
  const normalizedItems = validateFeedItems(
    feed,
    normalizedData[feed.externalId] ?? [],
  );
  if (options.signal?.aborted) {
    throw new IngestionAbortError();
  }
  const fetchedAt = options.fetchedAt ?? options.now?.() ?? Date.now();

  await database.transaction(async (transaction) => {
    const transactionalDatabase = transaction as Database;
    if (options.signal?.aborted) {
      throw new IngestionAbortError();
    }
    await upsertItems(
      transactionalDatabase,
      feed.id,
      normalizedItems,
      fetchedAt,
    );
    if (options.signal?.aborted) {
      throw new IngestionAbortError();
    }
    await setLastFetched(
      transactionalDatabase,
      feed.id,
      userId,
      window.to,
    );
  });

  return {
    feedId: feed.id,
    window,
    itemCount: normalizedItems.length,
  };
}

export class IngestionAbortError extends Error {
  constructor(message = "Connector ingestion aborted") {
    super(message);
    this.name = "IngestionAbortError";
  }
}

export interface IngestFeedError {
  feedId: string;
  error: string;
}

export interface IngestFeedsForSourceResult {
  feedResults: (IngestFeedResult | IngestFeedError)[];
}

export async function ingestFeedsForSource(
  database: Database,
  userId: string,
  feeds: PublicFeed[],
  connector: Connector<unknown>,
  options: IngestFeedOptions = {},
): Promise<IngestFeedsForSourceResult> {
  const config = getConfig();
  const controller = new AbortController();
  const startMs = Date.now();
  const timer = setTimeout(() => controller.abort(), config.connectorTimeoutMs);

  try {
    const feedWindows = feeds.map((feed) => {
      const override = options.feedWindows?.get(feed.id);
      return {
        feed,
        window: override ?? computeIngestionWindow(feed, options),
      };
    });

    const minFrom = Math.min(...feedWindows.map((fw) => fw.window.from));
    const maxTo = Math.max(...feedWindows.map((fw) => fw.window.to));
    const allExternalIds = feeds.map((feed) => feed.externalId);
    const fetchedAt = options.fetchedAt ?? options.now?.() ?? Date.now();

    const normalizedData = await connector.getNormalizedData(
      minFrom,
      maxTo,
      allExternalIds,
      controller.signal,
    );

    // Deadline check: if connector ignored the abort signal and returned late,
    // treat the whole batch as failed.
    if (
      controller.signal.aborted &&
      Date.now() - startMs >= config.connectorTimeoutMs
    ) {
      return {
        feedResults: feeds.map((feed) => ({
          feedId: feed.id,
          error: "connector deadline exceeded",
        })),
      };
    }

    const feedResults: (IngestFeedResult | IngestFeedError)[] = [];

    for (const { feed, window } of feedWindows) {
      try {
        const feedItems = (normalizedData[feed.externalId] ?? []).filter(
          (item) => item.date >= window.from && item.date <= window.to,
        );
        const validItems = validateFeedItems(feed, feedItems);

        await database.transaction(async (transaction) => {
          const transactionalDatabase = transaction as Database;
          await upsertItems(
            transactionalDatabase,
            feed.id,
            validItems,
            fetchedAt,
          );
          await setLastFetched(
            transactionalDatabase,
            feed.id,
            userId,
            window.to,
          );
        });

        feedResults.push({
          feedId: feed.id,
          window,
          itemCount: validItems.length,
        });
      } catch (error) {
        feedResults.push({
          feedId: feed.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { feedResults };
  } finally {
    clearTimeout(timer);
  }
}

export async function ingestFeedsIndividually(
  database: Database,
  userId: string,
  feeds: PublicFeed[],
  connector: Connector<unknown>,
  options: IngestFeedOptions = {},
): Promise<IngestFeedsForSourceResult> {
  const connectorTimeoutMs = options.connectorTimeoutMs ??
    getConfig().connectorTimeoutMs;
  const concurrency = options.concurrency ?? 4;
  if (!Number.isInteger(connectorTimeoutMs) || connectorTimeoutMs <= 0) {
    throw new Error("connectorTimeoutMs must be a positive integer");
  }
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error("concurrency must be a positive integer");
  }

  const feedResults: Array<IngestFeedResult | IngestFeedError | undefined> =
    Array.from(
      { length: feeds.length },
      () => undefined,
    );
  let nextFeedIndex = 0;

  const ingestOne = async (
    feed: PublicFeed,
  ): Promise<IngestFeedResult | IngestFeedError> => {
    const controller = new AbortController();
    let deadlineExceeded = false;
    const deadline = Promise.withResolvers<never>();
    const timer = setTimeout(() => {
      deadlineExceeded = true;
      controller.abort();
      deadline.reject(new IngestionAbortError());
    }, connectorTimeoutMs);
    const parentAbortHandler = options.signal
      ? () => controller.abort()
      : undefined;
    if (options.signal && parentAbortHandler) {
      if (options.signal.aborted) {
        controller.abort();
      } else {
        options.signal.addEventListener("abort", parentAbortHandler, {
          once: true,
        });
      }
    }

    try {
      const window = options.feedWindows?.get(feed.id) ?? options.window ??
        computeIngestionWindow(feed, options);
      const ingestion = ingestFeed(database, userId, feed, connector, {
        ...options,
        window,
        signal: controller.signal,
      });
      return await Promise.race([ingestion, deadline.promise]);
    } catch (error) {
      return {
        feedId: feed.id,
        error: deadlineExceeded
          ? "connector deadline exceeded"
          : error instanceof Error
          ? error.message
          : String(error),
      };
    } finally {
      clearTimeout(timer);
      if (options.signal && parentAbortHandler) {
        options.signal.removeEventListener("abort", parentAbortHandler);
      }
    }
  };

  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextFeedIndex;
      nextFeedIndex += 1;
      if (index >= feeds.length) return;
      feedResults[index] = await ingestOne(feeds[index]);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, feeds.length) }, () => worker()),
  );
  return {
    feedResults: feedResults as Array<IngestFeedResult | IngestFeedError>,
  };
}
