import { ConnectorFactory } from "../connectors/connector-factory.ts";
import type { Database } from "../db/client.ts";
import { setDigestStatus } from "../repositories/digest-repository.ts";
import { listFeedsForUser, type PublicFeed } from "../repositories/feed-repository.ts";
import { listSourcesForUser, type PublicSource } from "../repositories/source-repository.ts";
import { assembleDigestForPeriod, buildDigestViewForPeriod, type AssembleDigestDependencies, type DigestView } from "./digest-service.ts";
import { ingestFeed } from "./ingestion-service.ts";

export interface DigestPeriod {
  startMs: number;
  endMs: number;
}

export interface OrchestratorDependencies extends AssembleDigestDependencies {
  connectorFactory?: ConnectorFactory;
  now?: () => number;
}

function activeFeeds(feeds: PublicFeed[]): PublicFeed[] {
  return feeds.filter((feed) => feed.enabled);
}

function activeSources(sources: PublicSource[]): Map<string, PublicSource> {
  return new Map(sources.filter((source) => source.enabled).map((source) => [source.id, source]));
}

function groupFeedsBySource(feeds: PublicFeed[]): Map<string, PublicFeed[]> {
  const groupedFeeds = new Map<string, PublicFeed[]>();
  for (const feed of feeds) {
    const existingFeeds = groupedFeeds.get(feed.sourceId) ?? [];
    existingFeeds.push(feed);
    groupedFeeds.set(feed.sourceId, existingFeeds);
  }
  return groupedFeeds;
}

function alreadyIngestedForPeriod(feed: PublicFeed, period: DigestPeriod): boolean {
  return feed.lastFetchedPeriodEndMs !== null && feed.lastFetchedPeriodEndMs >= period.endMs;
}

export async function runForUser(
  database: Database,
  userId: string,
  period: DigestPeriod,
  dependencies: OrchestratorDependencies = {},
): Promise<DigestView> {
  const now = dependencies.now ?? Date.now;
  let connectorFactory = dependencies.connectorFactory;
  const [sources, feeds] = await Promise.all([
    listSourcesForUser(database, userId),
    listFeedsForUser(database, userId),
  ]);
  const enabledSourceById = activeSources(sources);
  const enabledFeedsBySource = groupFeedsBySource(activeFeeds(feeds));
  const successfulFeedIds: string[] = [];
  let hadFailure = false;

  for (const [sourceId, sourceFeeds] of enabledFeedsBySource.entries()) {
    const source = enabledSourceById.get(sourceId);
    if (!source) {
      hadFailure = true;
      continue;
    }

    const feedsNeedingIngestion: PublicFeed[] = [];
    for (const feed of sourceFeeds) {
      if (alreadyIngestedForPeriod(feed, period)) {
        successfulFeedIds.push(feed.id);
      } else {
        feedsNeedingIngestion.push(feed);
      }
    }
    if (feedsNeedingIngestion.length === 0) {
      continue;
    }

    let handle;
    try {
      connectorFactory ??= new ConnectorFactory(database);
      handle = await connectorFactory.forSource(source, userId);
    } catch {
      hadFailure = true;
      continue;
    }

    try {
      for (const feed of feedsNeedingIngestion) {
        try {
          await ingestFeed(database, userId, feed, handle.connector, {
            window: {
              from: feed.lastFetchedPeriodEndMs === null ? period.startMs : feed.lastFetchedPeriodEndMs + 1,
              to: period.endMs,
            },
            fetchedAt: now(),
          });
          successfulFeedIds.push(feed.id);
        } catch {
          hadFailure = true;
        }
      }
    } finally {
      await handle.dispose?.();
    }
  }

  let digestView = await assembleDigestForPeriod(database, userId, period.startMs, period.endMs, {
    ...dependencies,
    feedIds: successfulFeedIds,
  });

  if (hadFailure && digestView.digest.status !== "failed") {
    const digest = await setDigestStatus(database, digestView.digest.id, userId, "failed", now());
    digestView = await buildDigestViewForPeriod(database, digest);
  }

  return digestView;
}
