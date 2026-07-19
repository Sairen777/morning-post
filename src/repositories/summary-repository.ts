import { and, asc, eq, inArray } from "drizzle-orm";
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
  contentAccess: z.enum(["full", "preview"]),
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

export async function upsertSummaryForPeriod(
  database: Database,
  input: UpsertSummaryForPeriodInput,
  generatedAt = Date.now(),
): Promise<PublicSummary> {
  const content = summaryContentSchema.parse(input.content);
  const rows = await database
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
    .returning();
  return parsePublicSummary(rows[0]);
}

export async function findSummaryForFeedPeriod(
  database: Database,
  feedId: string,
  periodStartMs: number,
  periodEndMs: number,
): Promise<PublicSummary | null> {
  const rows = await database
    .select()
    .from(summaries)
    .where(and(
      eq(summaries.feedId, feedId),
      eq(summaries.periodStartMs, periodStartMs),
      eq(summaries.periodEndMs, periodEndMs),
    ))
    .limit(1);
  return rows[0] ? parsePublicSummary(rows[0]) : null;
}

export async function listSummariesForFeedPeriods(
  database: Database,
  feedIds: string[],
  periodStartMs: number,
  periodEndMs: number,
): Promise<PublicSummary[]> {
  if (feedIds.length === 0) {
    return [];
  }

  const rows = await database
    .select()
    .from(summaries)
    .where(and(
      inArray(summaries.feedId, feedIds),
      eq(summaries.periodStartMs, periodStartMs),
      eq(summaries.periodEndMs, periodEndMs),
    ));
  return rows.map(parsePublicSummary);
}
export async function listSummariesForUserPeriod(
  database: Database,
  userId: string,
  periodStartMs: number,
  periodEndMs: number,
): Promise<UserPeriodSummary[]> {
  const rows = await database
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
      asc(sources.position),
      asc(sources.createdAt),
      asc(sources.id),
      asc(feeds.position),
      asc(feeds.name),
      asc(summaries.feedNameSnapshot),
    );
  return rows.map(parseUserPeriodSummary);
}

export async function assertFeedOwned(
  database: Database,
  feedId: string,
  userId: string,
): Promise<void> {
  const rows = await database
    .select({ id: feeds.id })
    .from(feeds)
    .innerJoin(sources, eq(feeds.sourceId, sources.id))
    .where(and(eq(feeds.id, feedId), eq(sources.userId, userId)))
    .limit(1);
  if (!rows[0]) {
    throw new NotFoundError("feed not found");
  }
}
