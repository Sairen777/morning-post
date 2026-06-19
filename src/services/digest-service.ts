import { listFeedsForUser, type PublicFeed } from "../repositories/feed-repository.ts";
import {
  findDigestById,
  listDigestsForUser,
  setDigestStatus,
  type PublicDigest,
  upsertDigestForPeriod,
} from "../repositories/digest-repository.ts";
import { listSummariesForUserPeriod, type UserPeriodSummary } from "../repositories/summary-repository.ts";
import { getOrSummarizeFeedPeriod, type SummarizeFeedPeriodDependencies } from "./summarization-service.ts";
import type { Database } from "../db/client.ts";
import { NotFoundError } from "../server/errors.ts";

export interface DigestSection {
  sourceId: string;
  connectorId: string;
  feedId: string;
  feedName: string;
  feedRemoved: boolean;
  points: UserPeriodSummary["points"];
}

export interface DigestSourceGroup {
  sourceId: string;
  connectorId: string;
  sections: DigestSection[];
}

export interface DigestView {
  digest: PublicDigest;
  sections: DigestSection[];
  groups: DigestSourceGroup[];
}

export interface AssembleDigestDependencies extends SummarizeFeedPeriodDependencies {
  feedIds?: string[];
}

function toDigestSections(userPeriodSummaries: UserPeriodSummary[]): DigestSection[] {
  return userPeriodSummaries.map((summary) => ({
    sourceId: summary.sourceId,
    connectorId: summary.connectorId,
    feedId: summary.feedId,
    feedName: summary.feedNameSnapshot,
    feedRemoved: summary.feedDeletedAt !== null,
    points: summary.points,
  }));
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

function activeFeeds(feeds: PublicFeed[], feedIds?: string[]): PublicFeed[] {
  const selectedFeedIds = feedIds === undefined ? null : new Set(feedIds);
  return feeds.filter((feed) => feed.enabled && (selectedFeedIds === null || selectedFeedIds.has(feed.id)));
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
  const sections = toDigestSections(userPeriodSummaries);
  return {
    digest,
    sections,
    groups: groupDigestSections(sections),
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

export async function assembleDigestForPeriod(
  database: Database,
  userId: string,
  periodStartMs: number,
  periodEndMs: number,
  dependencies: AssembleDigestDependencies = {},
): Promise<DigestView> {
  let digest = await upsertDigestForPeriod(database, {
    userId,
    periodStartMs,
    periodEndMs,
    status: "pending",
  });

  const feeds = activeFeeds(await listFeedsForUser(database, userId), dependencies.feedIds);
  let hadFailure = false;
  for (const feed of feeds) {
    try {
      await getOrSummarizeFeedPeriod(
        database,
        userId,
        feed.id,
        periodStartMs,
        periodEndMs,
        dependencies,
      );
    } catch {
      hadFailure = true;
    }
  }

  digest = await setDigestStatus(database, digest.id, userId, hadFailure ? "failed" : "complete");
  return await buildDigestViewForPeriod(database, digest);
}

export async function listDigestViewsForUser(database: Database, userId: string): Promise<PublicDigest[]> {
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

export function renderDigestMarkdown(view: DigestView): string {
  const lines = [
    `# Digest ${formatDigestMoment(view.digest.periodStartMs)} → ${formatDigestMoment(view.digest.periodEndMs)}`,
    `Status: ${view.digest.status}`,
    "",
  ];

  for (const group of view.groups) {
    lines.push(`## ${group.connectorId}`);
    lines.push("");
    for (const section of group.sections) {
      lines.push(`### ${section.feedName}${section.feedRemoved ? " (removed)" : ""}`);
      if (section.points.length === 0) {
        lines.push("- Nothing to report.");
      } else {
        for (const point of section.points) {
          lines.push(`- ${point.text}`);
        }
      }
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd() + "\n";
}
