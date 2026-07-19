import { ConnectorId } from "../constants.ts";
import {
  listFeedsForUser,
  type PublicFeed,
} from "../repositories/feed-repository.ts";
import {
  findDigestById,
  listDigestsForUser,
  type PublicDigest,
  setDigestStatus,
  upsertDigestForPeriod,
} from "../repositories/digest-repository.ts";
import {
  listSummariesForFeedPeriods,
  listSummariesForUserPeriod,
  type UserPeriodSummary,
} from "../repositories/summary-repository.ts";
import { findUserById } from "../repositories/user-repository.ts";
import {
  type SummarizeFeedPeriodDependencies,
  summarizeOwnedFeedPeriod,
} from "./summarization-service.ts";
import type { Database } from "../db/client.ts";
import {
  type CreateDigestRunFeedInput,
  finishDigestRunFeed,
  startDigestRunFeed,
} from "../repositories/digest-run-repository.ts";
import { listSourcesForUser } from "../repositories/source-repository.ts";
import { summarizeErrorForOps } from "../server/error-sanitizer.ts";
import { NotFoundError } from "../server/errors.ts";
import type { SummaryContent } from "../summarizers/summarizer.types.ts";

export interface DigestSection {
  sourceId: string;
  connectorId: string;
  feedId: string;
  feedName: string;
  feedRemoved: boolean;
  content: SummaryContent;
}

export interface DigestSourceGroup {
  sourceId: string;
  connectorId: string;
  sections: DigestSection[];
}

export interface PaidPost {
  title: string;
  sourceUrl: string | null;
  publishedAt: number;
}

export interface DigestView {
  digest: PublicDigest;
  sections: DigestSection[];
  groups: DigestSourceGroup[];
  paidPosts: PaidPost[];
}

export interface AssembleDigestDependencies
  extends SummarizeFeedPeriodDependencies {
  feedIds?: string[];
  runId?: string;
  sourceConnectorIdsBySourceId?: Map<string, string>;
  feeds?: PublicFeed[];
  summarizationConcurrency?: number;
}

function toDigestContent(
  userPeriodSummaries: UserPeriodSummary[],
): { sections: DigestSection[]; paidPosts: PaidPost[] } {
  const sections: DigestSection[] = [];
  const paidPosts: PaidPost[] = [];

  for (const summary of userPeriodSummaries) {
    let content = summary.content;
    if (content.kind === "articles") {
      const articles = content.articles.filter((article) => {
        if (article.contentAccess !== "paid") {
          return true;
        }
        if (summary.showPaidPostTitles) {
          paidPosts.push({
            title: article.title,
            sourceUrl: article.sourceUrl,
            publishedAt: article.publishedAt,
          });
        }
        return false;
      });
      if (content.articles.length > 0 && articles.length === 0) {
        continue;
      }
      content = { kind: "articles", articles };
    }
    sections.push({
      sourceId: summary.sourceId,
      connectorId: summary.connectorId,
      feedId: summary.feedId,
      feedName: summary.feedNameSnapshot,
      feedRemoved: summary.feedDeletedAt !== null,
      content,
    });
  }

  return { sections, paidPosts };
}

function groupDigestSections(sections: DigestSection[]): DigestSourceGroup[] {
  const groups: DigestSourceGroup[] = [];
  for (const section of sections) {
    const lastGroup = groups[groups.length - 1];
    if (lastGroup && lastGroup.sourceId === section.sourceId) {
      lastGroup.sections.push(section);
      continue;
    }
    groups.push({
      sourceId: section.sourceId,
      connectorId: section.connectorId,
      sections: [section],
    });
  }
  return groups;
}
function requireConnectorId(value: string | undefined): ConnectorId {
  switch (value) {
    case ConnectorId.Telegram:
    case ConnectorId.Substack:
    case ConnectorId.YouTube:
    case ConnectorId.Reddit:
    case ConnectorId.X:
    case ConnectorId.RSS:
      return value;
    default:
      throw new Error("connector id missing or invalid for feed source");
  }
}

function activeFeeds(feeds: PublicFeed[], feedIds?: string[]): PublicFeed[] {
  const selectedFeedIds = feedIds === undefined ? null : new Set(feedIds);
  return feeds.filter((feed) =>
    feed.enabled && (selectedFeedIds === null || selectedFeedIds.has(feed.id))
  );
}

export async function buildDigestViewForPeriod(
  database: Database,
  digest: PublicDigest,
): Promise<DigestView> {
  const userPeriodSummaries = await listSummariesForUserPeriod(
    database,
    digest.userId,
    digest.periodStartMs,
    digest.periodEndMs,
  );
  const { sections, paidPosts } = toDigestContent(userPeriodSummaries);
  return {
    digest,
    sections,
    groups: groupDigestSections(sections),
    paidPosts,
  };
}

export async function buildDigestViewById(
  database: Database,
  userId: string,
  digestId: string,
): Promise<DigestView> {
  const digest = await findDigestById(database, digestId, userId);
  if (!digest) {
    throw new NotFoundError("digest not found");
  }
  return await buildDigestViewForPeriod(database, digest);
}

/**
 * Run async tasks with bounded concurrency, preserving input order.
 * Each task runs independently; task failures do not stop other tasks.
 */
async function runBounded<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const running = new Set<Promise<void>>();

  while (index < items.length) {
    while (index < items.length && running.size < concurrency) {
      const item = items[index++];
      const promise = fn(item).finally(() => running.delete(promise));
      running.add(promise);
    }

    if (running.size > 0) {
      await Promise.race(running);
    }
  }

  await Promise.all(running);
}

export async function assembleDigestForPeriod(
  database: Database,
  userId: string,
  periodStartMs: number,
  periodEndMs: number,
  dependencies: AssembleDigestDependencies = {},
): Promise<DigestView> {
  const user = await findUserById(database, userId);
  if (!user) {
    throw new NotFoundError("user not found");
  }

  let digest = await upsertDigestForPeriod(database, {
    userId,
    periodStartMs,
    periodEndMs,
    status: "pending",
  });

  const rawFeeds = dependencies.feeds ??
    await listFeedsForUser(database, userId);
  const feeds = activeFeeds(rawFeeds, dependencies.feedIds);

  const summariesByFeedId = new Map(
    (await listSummariesForFeedPeriods(
      database,
      feeds.map((feed) => feed.id),
      periodStartMs,
      periodEndMs,
    ))
      .map((summary) => [summary.feedId, summary] as const),
  );

  let sourceConnectorIdsBySourceId = dependencies.sourceConnectorIdsBySourceId;
  if (!sourceConnectorIdsBySourceId) {
    const sources = await listSourcesForUser(database, userId);
    sourceConnectorIdsBySourceId = new Map(
      sources.map((source) => [source.id, source.connectorId]),
    );
  }

  let hadFailure = false;
  const feedsToSummarize = feeds.filter((feed) =>
    !summariesByFeedId.has(feed.id)
  );
  const concurrency = dependencies.summarizationConcurrency ?? 2;

  await runBounded(feedsToSummarize, concurrency, async (feed) => {
    let feedRunId: string | undefined;
    try {
      const connectorId = requireConnectorId(
        sourceConnectorIdsBySourceId.get(feed.sourceId),
      );
      if (dependencies.runId) {
        const feedRunInput: CreateDigestRunFeedInput = {
          runId: dependencies.runId,
          sourceId: feed.sourceId,
          connectorId,
          feedId: feed.id,
          feedExternalId: feed.externalId,
          feedName: feed.name,
          stage: "summarization",
          status: "running",
        };
        const feedRun = await startDigestRunFeed(database, feedRunInput);
        feedRunId = feedRun.id;
      }

      await summarizeOwnedFeedPeriod(
        database,
        { user, feed, connectorId, periodStartMs, periodEndMs },
        dependencies,
      );
      if (feedRunId) {
        await finishDigestRunFeed(database, feedRunId, { status: "complete" });
      }
    } catch (error) {
      hadFailure = true;
      if (feedRunId) {
        await finishDigestRunFeed(database, feedRunId, {
          status: "failed",
          errorMessage: summarizeErrorForOps(error),
        });
      }
    }
  });

  digest = await setDigestStatus(
    database,
    digest.id,
    userId,
    hadFailure ? "failed" : "complete",
  );
  return await buildDigestViewForPeriod(database, digest);
}

export async function listDigestViewsForUser(
  database: Database,
  userId: string,
): Promise<PublicDigest[]> {
  return await listDigestsForUser(database, userId);
}

function formatDigestMoment(value: number): string {
  return new Date(value).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function safeMarkdownLinkDestination(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.href.replaceAll(">", "%3E");
  } catch {
    return null;
  }
}
function escapeMarkdownTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/[\\[\]]/g, "\\$&");
}

export function renderDigestMarkdown(view: DigestView): string {
  const lines = [
    `# Digest ${formatDigestMoment(view.digest.periodStartMs)} \u2192 ${
      formatDigestMoment(view.digest.periodEndMs)
    }`,
    `Status: ${view.digest.status}`,
    "",
  ];

  for (const group of view.groups) {
    lines.push(`## ${group.connectorId}`);
    lines.push("");
    for (const section of group.sections) {
      lines.push(
        `### ${section.feedName}${section.feedRemoved ? " (removed)" : ""}`,
      );
      if (section.content.kind === "aggregate") {
        if (section.content.points.length === 0) {
          lines.push("- Nothing to report.");
        } else {
          for (const point of section.content.points) {
            lines.push(`- ${point.text}`);
          }
        }
      } else if (section.content.articles.length === 0) {
        lines.push("No articles.");
      } else {
        for (const article of section.content.articles) {
          lines.push("");
          const articleTitle = escapeMarkdownTitle(article.title);
          const sourceUrl = safeMarkdownLinkDestination(article.sourceUrl);
          lines.push(
            sourceUrl
              ? `#### [${articleTitle}](<${sourceUrl}>)`
              : `#### ${articleTitle}`,
          );
          if (article.contentAccess === "preview") {
            lines.push("Preview");
          }
          lines.push(`Published: ${formatDigestMoment(article.publishedAt)}`);
          if (article.points.length === 0) {
            lines.push("- Nothing to report.");
          } else {
            for (const point of article.points) {
              lines.push(`- ${point.text}`);
            }
          }
        }
      }
      lines.push("");
    }
  }

  if (view.paidPosts.length > 0) {
    lines.push("## Paid posts", "");
    for (const paidPost of view.paidPosts) {
      const title = escapeMarkdownTitle(paidPost.title);
      const sourceUrl = safeMarkdownLinkDestination(paidPost.sourceUrl);
      lines.push(sourceUrl ? `- [${title}](<${sourceUrl}>)` : `- ${title}`);
    }
    lines.push(
      "",
      "These posts were not summarized because their full text is unavailable.",
      "",
    );
  }

  return lines.join("\n").trimEnd() + "\n";
}
