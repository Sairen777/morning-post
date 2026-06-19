import type { Connector, NormalizedItem } from "../connectors/connector.types.ts";
import type { Database } from "../db/client.ts";
import type { PublicFeed } from "../repositories/feed-repository.ts";
import { setLastFetched } from "../repositories/feed-repository.ts";
import { upsertItems, validateNormalizedItems } from "../repositories/item-repository.ts";
import { ValidationError } from "../server/errors.ts";

const DEFAULT_INGESTION_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export interface IngestionWindow {
  from: number;
  to: number;
}

export interface IngestFeedOptions {
  now?: () => number;
  defaultLookbackMs?: number;
  window?: IngestionWindow;
  fetchedAt?: number;
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
