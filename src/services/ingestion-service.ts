import type { Connector, NormalizedItem } from "../connectors/connector.types.ts";
import type { Database } from "../db/client.ts";
import type { PublicFeed } from "../repositories/feed-repository.ts";
import { setLastFetched } from "../repositories/feed-repository.ts";
import { upsertItems, validateNormalizedItems } from "../repositories/item-repository.ts";
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
  const defaultLookbackMs = options.defaultLookbackMs ?? DEFAULT_INGESTION_LOOKBACK_MS;
  const from = feed.lastFetchedPeriodEndMs === null
    ? to - defaultLookbackMs
    : feed.lastFetchedPeriodEndMs + 1;
  return { from, to };
}

function validateFeedItems(feed: PublicFeed, normalizedItems: NormalizedItem[]): NormalizedItem[] {
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
  const normalizedData = await connector.getNormalizedData(window.from, window.to, [feed.externalId]);
  const normalizedItems = validateFeedItems(feed, normalizedData[feed.externalId] ?? []);
  const fetchedAt = options.fetchedAt ?? options.now?.() ?? Date.now();

  await database.transaction(async (transaction) => {
    const transactionalDatabase = transaction as Database;
    await upsertItems(transactionalDatabase, feed.id, normalizedItems, fetchedAt);
    await setLastFetched(transactionalDatabase, feed.id, userId, window.to);
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

    const normalizedData = await connector.getNormalizedData(minFrom, maxTo, allExternalIds, controller.signal);

    // Deadline check: if connector ignored the abort signal and returned late,
    // treat the whole batch as failed.
    if (controller.signal.aborted && Date.now() - startMs >= config.connectorTimeoutMs) {
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
          await upsertItems(transactionalDatabase, feed.id, validItems, fetchedAt);
          await setLastFetched(transactionalDatabase, feed.id, userId, window.to);
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
