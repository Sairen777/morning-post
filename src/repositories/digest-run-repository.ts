import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.ts";
import {
  digestRunFeeds,
  type DigestRunFeedStage,
  type DigestRunFeedStatus,
  digestRuns,
  type DigestRunStatus,
  type DigestRunTrigger,
} from "../db/schema/digest-run.ts";

import { isUniqueViolation } from "../db/errors.ts";
import { ConflictError } from "../server/errors.ts";
import {
  decodeDigestRunCursor,
  encodeDigestRunCursor,
  type PageResult,
} from "../server/cursor.ts";

const usageCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const modelUsageMetricsSchema = z.object({
  attemptCount: usageCountSchema,
  durationMs: usageCountSchema,
  usageReportedAttemptCount: usageCountSchema,
  promptTokensLowerBound: usageCountSchema,
  completionTokensLowerBound: usageCountSchema,
  totalTokensLowerBound: usageCountSchema,
  promptCacheHitTokensLowerBound: usageCountSchema,
  promptCacheMissTokensLowerBound: usageCountSchema,
  successCount: usageCountSchema,
  retryCount: usageCountSchema,
  failureCount: usageCountSchema,
  saturated: z.boolean(),
}).strict();

const modelPricingSchema = z.object({
  uncachedInputUsdPerMillionTokens: z.number().finite().nonnegative(),
  cachedInputUsdPerMillionTokens: z.number().finite().nonnegative(),
  outputUsdPerMillionTokens: z.number().finite().nonnegative(),
}).strict();

export const digestModelUsageSnapshotSchema = z.object({
  version: z.literal(1),
  totals: modelUsageMetricsSchema,
  stages: z.array(z.object({
    stage: z.enum(["analysis", "classification", "summarization", "media"]),
    models: z.array(z.object({
      model: z.string().min(1),
      metrics: modelUsageMetricsSchema,
      pricing: modelPricingSchema.nullable().optional(),
      estimatedCostUsd: z.number().finite().nonnegative().nullable().optional(),
    }).strict()),
  }).strict()),
  estimatedCostUsd: z.number().nonnegative().nullable(),
}).strict();

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
  modelUsage: digestModelUsageSnapshotSchema.nullable(),
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

export class DigestRunAlreadyRunningError extends ConflictError {
  constructor() {
    super("digest already running");
    this.name = "DigestRunAlreadyRunningError";
  }
}

export function isDigestRunAlreadyRunningError(
  error: unknown,
): error is DigestRunAlreadyRunningError {
  return error instanceof DigestRunAlreadyRunningError;
}

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

export function createDigestRun(database: Database,
input: CreateDigestRunInput,
now = Date.now(),): PublicDigestRun { try {
  const [row] = database
    .insert(digestRuns)
    .values({
      userId: input.userId,
      trigger: input.trigger as DigestRunTrigger,
      periodStartMs: input.periodStartMs,
      periodEndMs: input.periodEndMs,
      status: input.status as DigestRunStatus,
      startedAt: now,
    })
    .returning()
    .all();
  if (!row) {
    throw new Error("digest run insert returned no rows");
  }
  return parsePublicDigestRun(row);
} catch (error) {
  if (input.status === "running" && isUniqueViolation(error)) {
    throw new DigestRunAlreadyRunningError();
  }
  throw error;
} }

export function recoverStaleDigestRuns(database: Database,
now: number,
staleAfterMs: number,): number { const staleBefore = now - staleAfterMs;
return database.transaction((transaction) => {
  const recoveredRuns = transaction
    .update(digestRuns)
    .set({
      status: "failed",
      finishedAt: now,
      errorMessage: "digest run lease expired",
    })
    .where(and(
      eq(digestRuns.status, "running"),
      lt(digestRuns.startedAt, staleBefore),
    ))
    .returning({ id: digestRuns.id })
    .all();

  if (recoveredRuns.length === 0) {
    return 0;
  }

  transaction
    .update(digestRunFeeds)
    .set({
      status: "failed",
      finishedAt: now,
      errorMessage: "digest run lease expired",
    })
    .where(and(
      eq(digestRunFeeds.status, "running"),
      inArray(digestRunFeeds.runId, recoveredRuns.map((run) => run.id)),
    ))
    .run();

  return recoveredRuns.length;
}, { behavior: "immediate" }); }

export function finishDigestRun(database: Database,
id: string,
input: {
  digestId?: string | null;
  status: DigestRunStatus;
  errorMessage?: string | null;
  modelUsage?: z.infer<typeof digestModelUsageSnapshotSchema> | null;
},
now = Date.now(),): PublicDigestRun { const setValues: Record<string, unknown> = {
  status: input.status as DigestRunStatus,
  finishedAt: now,
};
if ("digestId" in input) {
  setValues.digestId = input.digestId;
}
if ("errorMessage" in input) {
  setValues.errorMessage = input.errorMessage;
}
if ("modelUsage" in input) {
  setValues.modelUsage = input.modelUsage;
}
const [row] = database
  .update(digestRuns)
  .set(setValues)
  .where(eq(digestRuns.id, id))
  .returning()
  .all();
if (!row) {
  throw new Error("digest run not found");
}
return parsePublicDigestRun(row); }

export function startDigestRunFeed(database: Database,
input: CreateDigestRunFeedInput,
now = Date.now(),): PublicDigestRunFeed { const [row] = database
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
  .returning()
  .all();
if (!row) {
  throw new Error("digest run feed insert returned no rows");
}
return parsePublicDigestRunFeed(row); }

export function finishDigestRunFeed(database: Database,
id: string,
input: {
  status: DigestRunFeedStatus;
  itemCount?: number | null;
  errorMessage?: string | null;
},
now = Date.now(),): PublicDigestRunFeed { const setValues: Record<string, unknown> = {
  status: input.status as DigestRunFeedStatus,
  finishedAt: now,
};
if ("itemCount" in input) {
  setValues.itemCount = input.itemCount;
}
if ("errorMessage" in input) {
  setValues.errorMessage = input.errorMessage;
}
const [row] = database
  .update(digestRunFeeds)
  .set(setValues)
  .where(eq(digestRunFeeds.id, id))
  .returning()
  .all();
if (!row) {
  throw new Error("digest run feed not found");
}
return parsePublicDigestRunFeed(row); }

export function findNewestDigestRunByDigestIdForUser(database: Database,
userId: string,
digestId: string,): PublicDigestRun | null { const [row] = database
  .select()
  .from(digestRuns)
  .where(and(
    eq(digestRuns.userId, userId),
    eq(digestRuns.digestId, digestId),
  ))
  .orderBy(
    desc(digestRuns.startedAt),
    sql`${digestRuns.finishedAt} desc nulls last`,
    desc(digestRuns.id),
  )
  .limit(1)
  .all();
return row ? parsePublicDigestRun(row) : null; }

export function listDigestRunsForUser(database: Database,
userId: string,
options: { limit?: number } = {},): PublicDigestRun[] { const rows = database
  .select()
  .from(digestRuns)
  .where(eq(digestRuns.userId, userId))
  .orderBy(desc(digestRuns.startedAt))
  .limit(options.limit ?? 50)
  .all();
return rows.map(parsePublicDigestRun); }

export function listDigestRunPageForUser(database: Database,
userId: string,
options: { cursor?: string; limit?: number } = {},): PageResult<PublicDigestRun> { const limit = (() => {
  const n = options.limit ?? 20;
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new TypeError("limit must be an integer between 1 and 100");
  }
  return n;
})();

const conditions = [eq(digestRuns.userId, userId)];
if (options.cursor) {
  const c = decodeDigestRunCursor(options.cursor);
  const cursorCondition = or(
    lt(digestRuns.startedAt, c.p),
    and(eq(digestRuns.startedAt, c.p), lt(digestRuns.id, c.i)),
  );
  if (cursorCondition) conditions.push(cursorCondition);
}

const rows = database
  .select()
  .from(digestRuns)
  .where(and(...conditions))
  .orderBy(desc(digestRuns.startedAt), desc(digestRuns.id))
  .limit(limit + 1)
  .all();

const hasMore = rows.length > limit;
const data = rows.slice(0, limit).map(parsePublicDigestRun);
const nextCursor: string | null = hasMore
  ? encodeDigestRunCursor(
    data[data.length - 1].startedAt,
    data[data.length - 1].id,
  )
  : null;

return { data, nextCursor }; }

export function findDigestRunForUser(database: Database,
id: string,
userId: string,): PublicDigestRun | null { const [row] = database
  .select()
  .from(digestRuns)
  .where(and(eq(digestRuns.id, id), eq(digestRuns.userId, userId)))
  .all();
return row ? parsePublicDigestRun(row) : null; }

export function listDigestRunFeedsForRun(database: Database,
runId: string,
userId: string,): PublicDigestRunFeed[] { const rows = database
  .select()
  .from(digestRunFeeds)
  .innerJoin(digestRuns, eq(digestRunFeeds.runId, digestRuns.id))
  .where(and(eq(digestRunFeeds.runId, runId), eq(digestRuns.userId, userId)))
  .orderBy(asc(digestRunFeeds.startedAt))
  .all();
return rows.map((row) => parsePublicDigestRunFeed(row.digest_run_feeds)); }
