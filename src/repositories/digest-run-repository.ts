import { and, asc, eq, desc } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.ts";
import {
  digestRunFeeds,
  digestRuns,
  type DigestRunFeedStatus,
  type DigestRunFeedStage,
  type DigestRunStatus,
  type DigestRunTrigger,
} from "../db/schema/digest-run.ts";

const publicDigestRunSchema = z.object({
  id: z.string(),
  digestId: z.string().nullable(),
  userId: z.string(),
  trigger: z.enum(["manual", "scheduled"]),
  periodStartMs: z.number(),
  periodEndMs: z.number(),
  status: z.enum(["running", "complete", "partial", "failed"]),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  errorMessage: z.string().nullable(),
});

export type PublicDigestRun = z.infer<typeof publicDigestRunSchema>;

const publicDigestRunFeedSchema = z.object({
  id: z.string(),
  runId: z.string(),
  sourceId: z.string().nullable(),
  feedId: z.string().nullable(),
  connectorId: z.string(),
  feedExternalId: z.string().nullable(),
  feedName: z.string().nullable(),
  stage: z.enum(["connector", "ingestion", "summarization"]),
  status: z.enum(["running", "complete", "skipped", "failed"]),
  itemCount: z.number().nullable(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  errorMessage: z.string().nullable(),
});

export type PublicDigestRunFeed = z.infer<typeof publicDigestRunFeedSchema>;

export interface CreateDigestRunInput {
  userId: string;
  trigger: DigestRunTrigger;
  periodStartMs: number;
  periodEndMs: number;
  status: DigestRunStatus;
}

export interface CreateDigestRunFeedInput {
  runId: string;
  sourceId?: string | null;
  feedId?: string | null;
  connectorId: string;
  feedExternalId?: string | null;
  feedName?: string | null;
  stage: DigestRunFeedStage;
  status: DigestRunFeedStatus;
  itemCount?: number | null;
}

function parsePublicDigestRun(row: unknown): PublicDigestRun {
  return publicDigestRunSchema.parse(row);
}

function parsePublicDigestRunFeed(row: unknown): PublicDigestRunFeed {
  return publicDigestRunFeedSchema.parse(row);
}

export async function createDigestRun(
  database: Database,
  input: CreateDigestRunInput,
  now = Date.now(),
): Promise<PublicDigestRun> {
  const [row] = await database
    .insert(digestRuns)
    .values({
      userId: input.userId,
      trigger: input.trigger as DigestRunTrigger,
      periodStartMs: input.periodStartMs,
      periodEndMs: input.periodEndMs,
      status: input.status as DigestRunStatus,
      startedAt: now,
    })
    .returning();
  if (!row) {
    throw new Error("digest run insert returned no rows");
  }
  return parsePublicDigestRun(row);
}

export async function finishDigestRun(
  database: Database,
  id: string,
  input: {
    digestId?: string | null;
    status: DigestRunStatus;
    errorMessage?: string | null;
  },
  now = Date.now(),
): Promise<PublicDigestRun> {
  const setValues: Record<string, unknown> = {
    status: input.status as DigestRunStatus,
    finishedAt: now,
  };
  if ("digestId" in input) {
    setValues.digestId = input.digestId;
  }
  if ("errorMessage" in input) {
    setValues.errorMessage = input.errorMessage;
  }
  const [row] = await database
    .update(digestRuns)
    .set(setValues)
    .where(eq(digestRuns.id, id))
    .returning();
  if (!row) {
    throw new Error("digest run not found");
  }
  return parsePublicDigestRun(row);
}

export async function startDigestRunFeed(
  database: Database,
  input: CreateDigestRunFeedInput,
  now = Date.now(),
): Promise<PublicDigestRunFeed> {
  const [row] = await database
    .insert(digestRunFeeds)
    .values({
      runId: input.runId,
      sourceId: input.sourceId ?? null,
      feedId: input.feedId ?? null,
      connectorId: input.connectorId,
      feedExternalId: input.feedExternalId ?? null,
      feedName: input.feedName ?? null,
      stage: input.stage as DigestRunFeedStage,
      status: input.status as DigestRunFeedStatus,
      itemCount: input.itemCount ?? null,
      startedAt: now,
    })
    .returning();
  if (!row) {
    throw new Error("digest run feed insert returned no rows");
  }
  return parsePublicDigestRunFeed(row);
}

export async function finishDigestRunFeed(
  database: Database,
  id: string,
  input: {
    status: DigestRunFeedStatus;
    itemCount?: number | null;
    errorMessage?: string | null;
  },
  now = Date.now(),
): Promise<PublicDigestRunFeed> {
  const setValues: Record<string, unknown> = {
    status: input.status as DigestRunFeedStatus,
    finishedAt: now,
  };
  if ("itemCount" in input) {
    setValues.itemCount = input.itemCount;
  }
  if ("errorMessage" in input) {
    setValues.errorMessage = input.errorMessage;
  }
  const [row] = await database
    .update(digestRunFeeds)
    .set(setValues)
    .where(eq(digestRunFeeds.id, id))
    .returning();
  if (!row) {
    throw new Error("digest run feed not found");
  }
  return parsePublicDigestRunFeed(row);
}

export async function listDigestRunsForUser(
  database: Database,
  userId: string,
  options: { limit?: number } = {},
): Promise<PublicDigestRun[]> {
  const rows = await database
    .select()
    .from(digestRuns)
    .where(eq(digestRuns.userId, userId))
    .orderBy(desc(digestRuns.startedAt))
    .limit(options.limit ?? 50);
  return rows.map(parsePublicDigestRun);
}

export async function findDigestRunForUser(
  database: Database,
  id: string,
  userId: string,
): Promise<PublicDigestRun | null> {
  const [row] = await database
    .select()
    .from(digestRuns)
    .where(and(eq(digestRuns.id, id), eq(digestRuns.userId, userId)));
  return row ? parsePublicDigestRun(row) : null;
}

export async function listDigestRunFeedsForRun(
  database: Database,
  runId: string,
): Promise<PublicDigestRunFeed[]> {
  const rows = await database
    .select()
    .from(digestRunFeeds)
    .where(eq(digestRunFeeds.runId, runId))
    .orderBy(asc(digestRunFeeds.startedAt));
  return rows.map(parsePublicDigestRunFeed);
}
