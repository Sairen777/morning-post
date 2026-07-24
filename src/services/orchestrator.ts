import type { ConnectorFactoryLike } from "../connectors/connector-factory.ts";
import { ConnectorFactory } from "../connectors/connector-factory.ts";
import type { Database } from "../db/client.ts";
import type { DigestRunTrigger } from "../db/schema/digest-run.ts";
import {
  createDigestRun,
  type CreateDigestRunFeedInput,
  finishDigestRun,
  finishDigestRunFeed,
  startDigestRunFeed,
} from "../repositories/digest-run-repository.ts";
import {
  setDigestStatus,
  upsertDigestForPeriod,
} from "../repositories/digest-repository.ts";
import {
  listFeedsForUser,
  type PublicFeed,
} from "../repositories/feed-repository.ts";
import { listFeedIdsWithPaidItems } from "../repositories/item-repository.ts";
import {
  listSourcesForUser,
  type PublicSource,
} from "../repositories/source-repository.ts";
import { summarizeErrorForOps } from "../server/error-sanitizer.ts";
import {
  type AssembleDigestDependencies,
  assembleDigestForPeriod,
  buildDigestViewById,
  buildDigestViewForPeriod,
  type DigestView,
} from "./digest-service.ts";
import {
  ingestFeed,
  type IngestFeedError,
  ingestFeedsForSource,
  ingestFeedsIndividually,
} from "./ingestion-service.ts";

export interface DigestPeriod {
  startMs: number;
  endMs: number;
}

export interface OrchestratorDependencies extends AssembleDigestDependencies {
  connectorFactory?: ConnectorFactoryLike;
  trigger?: DigestRunTrigger;
  now?: () => number;
}

function activeFeeds(feeds: PublicFeed[]): PublicFeed[] {
  return feeds.filter((feed) => feed.enabled);
}

function activeSources(sources: PublicSource[]): Map<string, PublicSource> {
  return new Map(
    sources.filter((source) => source.enabled).map((
      source,
    ) => [source.id, source]),
  );
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

function alreadyIngestedForPeriod(
  feed: PublicFeed,
  period: DigestPeriod,
): boolean {
  return feed.lastFetchedPeriodEndMs !== null &&
    feed.lastFetchedPeriodEndMs >= period.endMs;
}

function ingestionWindow(
  feed: PublicFeed,
  period: DigestPeriod,
  paidRefreshFeedIds: ReadonlySet<string>,
): { from: number; to: number } {
  return {
    from:
      paidRefreshFeedIds.has(feed.id) || feed.lastFetchedPeriodEndMs === null
        ? period.startMs
        : feed.lastFetchedPeriodEndMs + 1,
    to: period.endMs,
  };
}

interface RunContext {
  digestRunId: string;
  period: DigestPeriod;
  now: () => number;
}

async function loadEnabledUserFeedPlan(
  database: Database,
  userId: string,
): Promise<{
  sourcesById: Map<string, PublicSource>;
  feedsBySourceId: Map<string, PublicFeed[]>;
}> {
  const [sources, feeds] = await Promise.all([
    listSourcesForUser(database, userId),
    listFeedsForUser(database, userId),
  ]);
  return {
    sourcesById: activeSources(sources),
    feedsBySourceId: groupFeedsBySource(activeFeeds(feeds)),
  };
}

async function ingestUserFeeds(
  database: Database,
  userId: string,
  period: DigestPeriod,
  plan: {
    sourcesById: Map<string, PublicSource>;
    feedsBySourceId: Map<string, PublicFeed[]>;
  },
  connectorFactory: ConnectorFactoryLike | undefined,
  now: () => number,
  runContext: RunContext,
): Promise<{ successfulFeedIds: string[]; hadFailure: boolean }> {
  const successfulFeedIds: string[] = [];
  let hadFailure = false;
  const activeFeedIds = [...plan.feedsBySourceId.values()]
    .flatMap((feeds) => feeds.map((feed) => feed.id));
  const paidRefreshFeedIds = new Set(
    await listFeedIdsWithPaidItems(
      database,
      activeFeedIds,
      period.startMs,
      period.endMs,
    ),
  );

  for (const [sourceId, sourceFeeds] of plan.feedsBySourceId.entries()) {
    const source = plan.sourcesById.get(sourceId);
    if (!source) {
      hadFailure = true;
      continue;
    }

    const feedsNeedingIngestion: PublicFeed[] = [];
    for (const feed of sourceFeeds) {
      if (
        alreadyIngestedForPeriod(feed, period) &&
        !paidRefreshFeedIds.has(feed.id)
      ) {
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
    } catch (error) {
      hadFailure = true;
      const feedRunInput: CreateDigestRunFeedInput = {
        runId: runContext.digestRunId,
        sourceId: source.id,
        connectorId: source.connectorId,
        stage: "connector",
        status: "failed",
      };
      const feedRun = await startDigestRunFeed(
        database,
        feedRunInput,
        runContext.now(),
      );
      await finishDigestRunFeed(database, feedRun.id, {
        status: "failed",
        errorMessage: summarizeErrorForOps(error),
      }, runContext.now());
      continue;
    }

    try {
      if (handle.ingestionMode === "individual") {
        const feedRunMap = new Map<string, { id: string }>();
        for (const feed of feedsNeedingIngestion) {
          const feedRunInput: CreateDigestRunFeedInput = {
            runId: runContext.digestRunId,
            sourceId: source.id,
            connectorId: source.connectorId,
            feedId: feed.id,
            feedExternalId: feed.externalId,
            feedName: feed.name,
            stage: "ingestion",
            status: "running",
          };
          const feedRun = await startDigestRunFeed(
            database,
            feedRunInput,
            runContext.now(),
          );
          feedRunMap.set(feed.id, feedRun);
        }

        try {
          const feedWindows = new Map<string, { from: number; to: number }>();
          for (const feed of feedsNeedingIngestion) {
            feedWindows.set(
              feed.id,
              ingestionWindow(feed, period, paidRefreshFeedIds),
            );
          }

          const individualResult = await ingestFeedsIndividually(
            database,
            userId,
            feedsNeedingIngestion,
            handle.connector,
            { feedWindows, fetchedAt: now() },
          );

          for (const result of individualResult.feedResults) {
            const feedRun = feedRunMap.get(result.feedId);
            if (!feedRun) continue;

            if ("error" in result) {
              hadFailure = true;
              await finishDigestRunFeed(database, feedRun.id, {
                status: "failed",
                errorMessage: result.error,
              }, runContext.now());
            } else {
              await finishDigestRunFeed(database, feedRun.id, {
                status: "complete",
                itemCount: result.itemCount,
              }, runContext.now());
              successfulFeedIds.push(result.feedId);
            }
          }
        } catch (error) {
          hadFailure = true;
          for (const feed of feedsNeedingIngestion) {
            const feedRun = feedRunMap.get(feed.id);
            if (feedRun) {
              await finishDigestRunFeed(database, feedRun.id, {
                status: "failed",
                errorMessage: summarizeErrorForOps(error),
              }, runContext.now());
            }
          }
        }
      } else if (feedsNeedingIngestion.length === 1) {
        const feed = feedsNeedingIngestion[0];
        const feedRunInput: CreateDigestRunFeedInput = {
          runId: runContext.digestRunId,
          sourceId: source.id,
          connectorId: source.connectorId,
          feedId: feed.id,
          feedExternalId: feed.externalId,
          feedName: feed.name,
          stage: "ingestion",
          status: "running",
        };
        const feedRun = await startDigestRunFeed(
          database,
          feedRunInput,
          runContext.now(),
        );
        try {
          const result = await ingestFeed(
            database,
            userId,
            feed,
            handle.connector,
            {
              window: ingestionWindow(feed, period, paidRefreshFeedIds),
              fetchedAt: now(),
            },
          );
          await finishDigestRunFeed(database, feedRun.id, {
            status: "complete",
            itemCount: result.itemCount,
          }, runContext.now());
          successfulFeedIds.push(feed.id);
        } catch (error) {
          hadFailure = true;
          await finishDigestRunFeed(database, feedRun.id, {
            status: "failed",
            errorMessage: summarizeErrorForOps(error),
          }, runContext.now());
        }
      } else {
        // Batch multiple feeds from the same source with one connector call
        const feedRunMap = new Map<string, { id: string }>();
        for (const feed of feedsNeedingIngestion) {
          const feedRunInput: CreateDigestRunFeedInput = {
            runId: runContext.digestRunId,
            sourceId: source.id,
            connectorId: source.connectorId,
            feedId: feed.id,
            feedExternalId: feed.externalId,
            feedName: feed.name,
            stage: "ingestion",
            status: "running",
          };
          const feedRun = await startDigestRunFeed(
            database,
            feedRunInput,
            runContext.now(),
          );
          feedRunMap.set(feed.id, feedRun);
        }

        try {
          const feedWindows = new Map<string, { from: number; to: number }>();
          for (const feed of feedsNeedingIngestion) {
            feedWindows.set(
              feed.id,
              ingestionWindow(feed, period, paidRefreshFeedIds),
            );
          }

          const batchResult = await ingestFeedsForSource(
            database,
            userId,
            feedsNeedingIngestion,
            handle.connector,
            { feedWindows, fetchedAt: now() },
          );

          for (const result of batchResult.feedResults) {
            const feedRun = feedRunMap.get(result.feedId);
            if (!feedRun) continue;

            if ("error" in result) {
              hadFailure = true;
              await finishDigestRunFeed(database, feedRun.id, {
                status: "failed",
                errorMessage: (result as IngestFeedError).error,
              }, runContext.now());
            } else {
              await finishDigestRunFeed(database, feedRun.id, {
                status: "complete",
                itemCount: result.itemCount,
              }, runContext.now());
              successfulFeedIds.push(result.feedId);
            }
          }
        } catch (error) {
          // Connector-level exception: mark all pending feeds in this source failed
          hadFailure = true;
          for (const feed of feedsNeedingIngestion) {
            const feedRun = feedRunMap.get(feed.id);
            if (feedRun) {
              await finishDigestRunFeed(database, feedRun.id, {
                status: "failed",
                errorMessage: summarizeErrorForOps(error),
              }, runContext.now());
            }
          }
        }
      }
    } finally {
      await handle.dispose?.();
    }
  }

  return { successfulFeedIds, hadFailure };
}

async function assembleRunDigest(
  database: Database,
  userId: string,
  period: DigestPeriod,
  successfulFeedIds: string[],
  sourcesById: Map<string, PublicSource>,
  feeds: PublicFeed[],
  dependencies: OrchestratorDependencies,
  runContext: RunContext,
): Promise<DigestView> {
  const sourceConnectorIdsBySourceId = new Map<string, string>();
  for (const source of sourcesById.values()) {
    sourceConnectorIdsBySourceId.set(source.id, source.connectorId);
  }

  return await assembleDigestForPeriod(
    database,
    userId,
    period.startMs,
    period.endMs,
    {
      ...dependencies,
      feedIds: successfulFeedIds,
      runId: runContext.digestRunId,
      sourceConnectorIdsBySourceId,
      feeds,
    },
  );
}

async function finalizeRunDigestStatus(
  database: Database,
  digestView: DigestView,
  userId: string,
  hadFailure: boolean,
  now: () => number,
): Promise<DigestView> {
  if (hadFailure && digestView.digest.status !== "failed") {
    const digest = await setDigestStatus(
      database,
      digestView.digest.id,
      userId,
      "failed",
      now(),
    );
    return await buildDigestViewForPeriod(database, digest);
  }
  return digestView;
}

async function executeDigestRun(
  database: Database,
  digestRunId: string,
  userId: string,
  period: DigestPeriod,
  dependencies: OrchestratorDependencies,
  now: () => number,
): Promise<DigestView> {
  const plan = await loadEnabledUserFeedPlan(database, userId);
  const allFeeds = [...plan.feedsBySourceId.values()].flat();

  const runContext: RunContext = {
    digestRunId,
    period,
    now,
  };

  const ingestionResult = await ingestUserFeeds(
    database,
    userId,
    period,
    plan,
    dependencies.connectorFactory,
    now,
    runContext,
  );

  let digestView: DigestView;
  let assemblyFailed = false;
  let assemblyError: unknown;

  try {
    digestView = await assembleRunDigest(
      database,
      userId,
      period,
      ingestionResult.successfulFeedIds,
      plan.sourcesById,
      allFeeds,
      dependencies,
      runContext,
    );
  } catch (error) {
    assemblyFailed = true;
    assemblyError = error;
    const fallbackDigest = await upsertDigestForPeriod(database, {
      userId,
      periodStartMs: period.startMs,
      periodEndMs: period.endMs,
      status: "failed",
    }, now());
    digestView = await buildDigestViewForPeriod(database, fallbackDigest);
  }

  const summarizationHadFailure = !assemblyFailed &&
    digestView.digest.status === "failed";
  const overallHadFailure = ingestionResult.hadFailure || assemblyFailed ||
    summarizationHadFailure;

  let runStatus: "complete" | "partial" | "failed";
  if (assemblyFailed) {
    runStatus = "failed";
  } else if (!overallHadFailure) {
    runStatus = "complete";
  } else {
    runStatus = "partial";
  }

  await finishDigestRun(database, digestRunId, {
    digestId: digestView.digest.id || null,
    status: runStatus,
    errorMessage: assemblyFailed ? summarizeErrorForOps(assemblyError) : null,
  }, now());

  if (runStatus === "failed") {
    return await buildDigestViewById(database, userId, digestView.digest.id);
  }

  return await finalizeRunDigestStatus(
    database,
    digestView,
    userId,
    overallHadFailure,
    now,
  );
}

export async function runForUser(
  database: Database,
  userId: string,
  period: DigestPeriod,
  dependencies: OrchestratorDependencies = {},
): Promise<DigestView> {
  const now = dependencies.now ?? Date.now;
  const trigger = dependencies.trigger ?? "manual";

  const digestRun = await createDigestRun(database, {
    userId,
    trigger,
    periodStartMs: period.startMs,
    periodEndMs: period.endMs,
    status: "running",
  }, now());

  try {
    return await executeDigestRun(
      database,
      digestRun.id,
      userId,
      period,
      dependencies,
      now,
    );
  } catch (error) {
    try {
      await finishDigestRun(database, digestRun.id, {
        status: "failed",
        errorMessage: summarizeErrorForOps(error),
      }, now());
    } catch {
      // Preserve the operational failure when the best-effort run transition also fails.
    }
    throw error;
  }
}
