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
  listSummariesForUserPeriod,
  type UserPeriodSummary,
} from "../repositories/summary-repository.ts";
import { findUserById } from "../repositories/user-repository.ts";
import {
  listItemsForFeedsInWindow,
  type StoredItem,
} from "../repositories/item-repository.ts";
import type { SummarizeFeedPeriodDependencies } from "./summarization-service.ts";
import type { Database } from "../db/client.ts";
import { listSourcesForUser } from "../repositories/source-repository.ts";
import { NotFoundError } from "../server/errors.ts";
import type { SummaryContent } from "../summarizers/summarizer.types.ts";
import { listDigestStories, type StoredDigestStory } from "../repositories/story-repository.ts";
import { assembleStoryDigest, type StoryDigestDependencies } from "./story-digest-service.ts";
import { isInaccessiblePaidItem } from "./content-access.ts";

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
  newsletterName: string;
  title: string;
  sourceUrl: string | null;
  publishedAt: number;
}

export interface DigestView {
  digest: PublicDigest;
  stories: StoredDigestStory[];
  sections: DigestSection[];
  groups: DigestSourceGroup[];
  paidPosts: PaidPost[];
}

export interface AssembleDigestDependencies
  extends SummarizeFeedPeriodDependencies, StoryDigestDependencies {
  feedIds?: string[];
  runId?: string;
  sourceConnectorIdsBySourceId?: Map<string, string>;
  feeds?: PublicFeed[];
  summarizationConcurrency?: number;
}

function latestItemFetches(storedItems: StoredItem[]): Map<string, number> {
  const latestFetchByFeedId = new Map<string, number>();
  for (const item of storedItems) {
    latestFetchByFeedId.set(
      item.feedId,
      Math.max(latestFetchByFeedId.get(item.feedId) ?? 0, item.fetchedAt),
    );
  }
  return latestFetchByFeedId;
}

function toDigestContent(
  userPeriodSummaries: UserPeriodSummary[],
  storedItems: StoredItem[],
): { sections: DigestSection[]; paidPosts: PaidPost[] } {
  const sections: DigestSection[] = [];
  const paidPosts: PaidPost[] = [];
  const storedItemsByArticle = new Map(
    storedItems.map((item) => [`${item.feedId}\0${item.externalId}`, item]),
  );

  for (const summary of userPeriodSummaries) {
    let content = summary.content;
    if (content.kind === "articles") {
      const articles = content.articles.filter((article) => {
        const storedItem = storedItemsByArticle.get(
          `${summary.feedId}\0${article.sourceExternalId}`,
        );
        const inaccessiblePaidSubstackArticle =
          storedItem?.payload.connectorId === ConnectorId.Substack &&
          storedItem.payload.meta?.audience === "only_paid" &&
          storedItem.payload.meta?.hasPaidSubscription === false;
        const staleAccessiblePaidSubstackArticle =
          storedItem?.payload.connectorId === ConnectorId.Substack &&
          storedItem.payload.meta?.audience === "only_paid" &&
          storedItem.payload.meta?.hasPaidSubscription === true &&
          storedItem.fetchedAt > summary.generatedAt;
        if (staleAccessiblePaidSubstackArticle) {
          return false;
        }
        if (
          article.contentAccess !== "paid" && !inaccessiblePaidSubstackArticle
        ) {
          return true;
        }
        if (summary.showPaidPostTitles) {
          paidPosts.push({
            newsletterName: summary.feedNameSnapshot,
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
  if (digest.contentMode === "stories") {
    const feeds = await listFeedsForUser(database, digest.userId, { includeDeleted: true });
    const sources = await listSourcesForUser(database, digest.userId);
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    const feedById = new Map(feeds.map((feed) => [feed.id, feed]));
    const items = await listItemsForFeedsInWindow(database, feeds.map((feed) => feed.id), digest.periodStartMs, digest.periodEndMs);
    const inaccessibleItemIds = new Set(items.filter((item) => isInaccessiblePaidItem(item.payload)).map((item) => item.id));
    const paidPosts = items.flatMap((item): PaidPost[] => {
      const feed = feedById.get(item.feedId);
      const source = feed && sourceById.get(feed.sourceId);
      if (!feed || !source?.showPaidPostTitles || !isInaccessiblePaidItem(item.payload)) return [];
      return [{ newsletterName: feed.name, title: item.payload.title ?? "Paid post", sourceUrl: item.payload.url, publishedAt: item.payload.date }];
    });
    const visibleStories = (await listDigestStories(database, digest.userId, digest.id))
      .filter((story) => story.sources.every((source) => !inaccessibleItemIds.has(source.itemId)));
    return {
      digest,
      stories: visibleStories,
      sections: [],
      groups: [],
      paidPosts,
    };
  }
  const userPeriodSummaries = await listSummariesForUserPeriod(
    database,
    digest.userId,
    digest.periodStartMs,
    digest.periodEndMs,
  );
  const storedItems = await listItemsForFeedsInWindow(
    database,
    [...new Set(userPeriodSummaries.map((summary) => summary.feedId))],
    digest.periodStartMs,
    digest.periodEndMs,
  );
  const { sections, paidPosts } = toDigestContent(userPeriodSummaries, storedItems);
  return { digest, stories: [], sections, groups: groupDigestSections(sections), paidPosts };
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

  let sourceConnectorIdsBySourceId = dependencies.sourceConnectorIdsBySourceId;
  if (!sourceConnectorIdsBySourceId) {
    const sources = await listSourcesForUser(database, userId);
    sourceConnectorIdsBySourceId = new Map(
      sources.map((source) => [source.id, source.connectorId]),
    );
  }

  const result = await assembleStoryDigest(
    database,
    digest.id,
    user,
    feeds,
    periodStartMs,
    periodEndMs,
    {
      ...dependencies,
      summaryConcurrency: dependencies.summaryConcurrency ??
        dependencies.summarizationConcurrency,
    },
  );
  const hadFailure = result.hadSummaryFailure;

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

  for (const story of view.stories) {
    lines.push(`## ${escapeMarkdownTitle(story.title)}`, "");
    for (const point of story.points) lines.push(`- ${point.text}`);
    if (story.points.length === 0) lines.push("- Nothing to report.");
    lines.push("", "### Sources");
    for (const source of story.sources) {
      const label = escapeMarkdownTitle(source.title ?? source.feedName);
      const url = safeMarkdownLinkDestination(source.url);
      lines.push(url ? `- [${label}](<${url}>) — ${escapeMarkdownTitle(source.feedName)}` : `- ${label} — ${escapeMarkdownTitle(source.feedName)}`);
    }
    lines.push("");
  }

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
    const postsByNewsletter = new Map<string, PaidPost[]>();
    for (const paidPost of view.paidPosts) {
      const newsletterPosts = postsByNewsletter.get(paidPost.newsletterName);
      if (newsletterPosts) {
        newsletterPosts.push(paidPost);
      } else {
        postsByNewsletter.set(paidPost.newsletterName, [paidPost]);
      }
    }
    for (const [newsletterName, paidPosts] of postsByNewsletter) {
      lines.push(`### ${escapeMarkdownTitle(newsletterName)}`);
      for (const paidPost of paidPosts) {
        const title = escapeMarkdownTitle(paidPost.title);
        const sourceUrl = safeMarkdownLinkDestination(paidPost.sourceUrl);
        lines.push(sourceUrl ? `- [${title}](<${sourceUrl}>)` : `- ${title}`);
      }
      lines.push("");
    }
    lines.push(
      "",
      "These posts were not summarized because their full text is unavailable.",
      "",
    );
  }

  return lines.join("\n").trimEnd() + "\n";
}
