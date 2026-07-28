import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.ts";
import { feeds } from "../db/schema/feed.ts";
import { summaries } from "../db/schema/summary.ts";
import { sources } from "../db/schema/source.ts";
import { NotFoundError } from "../server/errors.ts";
import type { SummaryContent } from "../summarizers/summarizer.types.ts";

export const summaryPointSchema = z.object({
  text: z.string(),
  sourceUrl: z.string().nullable(),
  channel: z.string().optional(),
  date: z.string().optional(),
}).strict();

const aggregateSummaryContentSchema = z.object({
  kind: z.literal("aggregate"),
  points: z.array(summaryPointSchema),
}).strict();

const articleSummarySchema = z.object({
  sourceExternalId: z.string(),
  title: z.string(),
  sourceUrl: z.string().nullable(),
  publishedAt: z.number().int().nonnegative(),
  contentAccess: z.enum(["full", "preview", "paid"]),
  points: z.array(summaryPointSchema),
}).strict();

const articleSummaryContentSchema = z.object({
  kind: z.literal("articles"),
  articles: z.array(articleSummarySchema),
}).strict();

export const summaryContentSchema = z.discriminatedUnion("kind", [
  aggregateSummaryContentSchema,
  articleSummaryContentSchema,
]);

const publicSummarySchema = z.object({
  id: z.string().uuid(),
  feedId: z.string().uuid(),
  periodStartMs: z.number(),
  periodEndMs: z.number(),
  content: summaryContentSchema,
  feedNameSnapshot: z.string(),
  generatedAt: z.number(),
});

const userPeriodSummarySchema = publicSummarySchema.extend({
  sourceId: z.string().uuid(),
  connectorId: z.string(),
  showPaidPostTitles: z.boolean(),
  sourcePosition: z.number().nullable(),
  feedPosition: z.number().nullable(),
  feedDeletedAt: z.number().nullable(),
  feedEnabled: z.boolean(),
  feedName: z.string(),
});

export type PublicSummary = z.infer<typeof publicSummarySchema>;
export type UserPeriodSummary = z.infer<typeof userPeriodSummarySchema>;

export interface UpsertSummaryForPeriodInput {
  feedId: string;
  periodStartMs: number;
  periodEndMs: number;
  content: SummaryContent;
  feedNameSnapshot: string;
}

function parsePublicSummary(row: unknown): PublicSummary {
  return publicSummarySchema.parse(row);
}

function parseUserPeriodSummary(row: unknown): UserPeriodSummary {
  return userPeriodSummarySchema.parse(row);
}

export function upsertSummaryForPeriod(
  database: Database,
  input: UpsertSummaryForPeriodInput,
  generatedAt = Date.now(),
): PublicSummary {
  const content = summaryContentSchema.parse(input.content);
  const rows = database
    .insert(summaries)
    .values({
      feedId: input.feedId,
      periodStartMs: input.periodStartMs,
      periodEndMs: input.periodEndMs,
      content,
      feedNameSnapshot: input.feedNameSnapshot,
      generatedAt,
    })
    .onConflictDoUpdate({
      target: [
        summaries.feedId,
        summaries.periodStartMs,
        summaries.periodEndMs,
      ],
      set: {
        content,
        feedNameSnapshot: input.feedNameSnapshot,
        generatedAt,
      },
    })
    .returning()
    .all();
  return parsePublicSummary(rows[0]);
}

export function findSummaryForFeedPeriod(
  database: Database,
  feedId: string,
  periodStartMs: number,
  periodEndMs: number,
): PublicSummary | null {
  const rows = database
    .select()
    .from(summaries)
    .where(and(
      eq(summaries.feedId, feedId),
      eq(summaries.periodStartMs, periodStartMs),
      eq(summaries.periodEndMs, periodEndMs),
    ))
    .limit(1)
    .all();
  return rows[0] ? parsePublicSummary(rows[0]) : null;
}

export function listSummariesForFeedPeriods(
  database: Database,
  feedIds: string[],
  periodStartMs: number,
  periodEndMs: number,
): PublicSummary[] {
  if (feedIds.length === 0) {
    return [];
  }

  const rows = database
    .select()
    .from(summaries)
    .where(and(
      inArray(summaries.feedId, feedIds),
      eq(summaries.periodStartMs, periodStartMs),
      eq(summaries.periodEndMs, periodEndMs),
    ))
    .all();
  return rows.map(parsePublicSummary);
}
export function listSummariesForUserPeriod(
  database: Database,
  userId: string,
  periodStartMs: number,
  periodEndMs: number,
): UserPeriodSummary[] {
  const rows = database
    .select({
      id: summaries.id,
      feedId: summaries.feedId,
      periodStartMs: summaries.periodStartMs,
      periodEndMs: summaries.periodEndMs,
      content: summaries.content,
      feedNameSnapshot: summaries.feedNameSnapshot,
      generatedAt: summaries.generatedAt,
      connectorId: sources.connectorId,
      sourceId: feeds.sourceId,
      showPaidPostTitles: sources.showPaidPostTitles,
      sourcePosition: sources.position,
      feedPosition: feeds.position,
      feedDeletedAt: feeds.deletedAt,
      feedEnabled: feeds.enabled,
      feedName: feeds.name,
    })
    .from(summaries)
    .innerJoin(feeds, eq(summaries.feedId, feeds.id))
    .innerJoin(sources, eq(feeds.sourceId, sources.id))
    .where(and(
      eq(sources.userId, userId),
      eq(summaries.periodStartMs, periodStartMs),
      eq(summaries.periodEndMs, periodEndMs),
    ))
    .orderBy(
      asc(sql`${sources.position} is null`),
      asc(sources.position),
      asc(sources.createdAt),
      asc(sources.id),
      asc(sql`${feeds.position} is null`),
      asc(feeds.position),
      asc(feeds.name),
      asc(summaries.feedNameSnapshot),
    )
    .all();
  return rows.map(parseUserPeriodSummary);
}

export function assertFeedOwned(
  database: Database,
  feedId: string,
  userId: string,
): void {
  const rows = database
    .select({ id: feeds.id })
    .from(feeds)
    .innerJoin(sources, eq(feeds.sourceId, sources.id))
    .where(and(eq(feeds.id, feedId), eq(sources.userId, userId)))
    .limit(1)
    .all();
  if (!rows[0]) {
    throw new NotFoundError("feed not found");
  }
}
