import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.ts";
import { feeds } from "../db/schema/feed.ts";
import { sources } from "../db/schema/source.ts";
import { ConflictError, NotFoundError } from "../server/errors.ts";
import type { FeedKind } from "../connectors/connector.types.ts";
import { isUniqueViolation } from "../db/errors.ts";

const feedKindSchema = z.enum(["news", "discussion"]);

const publicFeedRowSchema = z.object({
  id: z.string().uuid(),
  sourceId: z.string().uuid(),
  externalId: z.string(),
  name: z.string(),
  kind: feedKindSchema,
  customPrompt: z.string().nullable(),
  position: z.number().nullable(),
  enabled: z.boolean(),
  deletedAt: z.number().nullable(),
  lastFetchedPeriodEndMs: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const createFeedInputSchema = z.object({
  userId: z.string().uuid(),
  sourceId: z.string().uuid(),
  externalId: z.string().min(1),
  name: z.string().min(1),
  kind: feedKindSchema,
  customPrompt: z.string().nullable().optional(),
  position: z.number().int().nullable().optional(),
});

const updateFeedInputSchema = z.object({
  kind: feedKindSchema.optional(),
  customPrompt: z.string().nullable().optional(),
  position: z.number().int().nullable().optional(),
  enabled: z.boolean().optional(),
});

export type PublicFeed = z.infer<typeof publicFeedRowSchema>;

export interface CreateOrReviveFeedInput {
  userId: string;
  sourceId: string;
  externalId: string;
  name: string;
  kind: FeedKind;
  customPrompt?: string | null;
  position?: number | null;
}

export type UpdateFeedInput = Partial<{
  kind: FeedKind;
  customPrompt: string | null;
  position: number | null;
  enabled: boolean;
}>;

export interface ListFeedsForUserOptions {
  includeDeleted?: boolean;
}

function publicColumns() {
  return {
    id: feeds.id,
    sourceId: feeds.sourceId,
    externalId: feeds.externalId,
    name: feeds.name,
    kind: feeds.kind,
    customPrompt: feeds.customPrompt,
    position: feeds.position,
    enabled: feeds.enabled,
    deletedAt: feeds.deletedAt,
    lastFetchedPeriodEndMs: feeds.lastFetchedPeriodEndMs,
    createdAt: feeds.createdAt,
    updatedAt: feeds.updatedAt,
  };
}

function parsePublicFeed(row: unknown): PublicFeed {
  return publicFeedRowSchema.parse(row);
}

async function assertSourceOwned(
  database: Database,
  sourceId: string,
  userId: string,
): Promise<void> {
  const rows = await database
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.id, sourceId), eq(sources.userId, userId)))
    .limit(1);
  if (!rows[0]) {
    throw new NotFoundError("source not found");
  }
}

async function lockSourceForFeedWrite(
  database: Database,
  sourceId: string,
  userId: string,
): Promise<void> {
  const rows = await database
    .select({ id: sources.id, credentials: sources.credentials })
    .from(sources)
    .where(and(eq(sources.id, sourceId), eq(sources.userId, userId)))
    .limit(1)
    .for("update");
  const source = rows[0];
  if (!source) {
    throw new NotFoundError("source not found");
  }
  if (source.credentials === null) {
    throw new ConflictError(
      "source must be reconnected before feeds can be subscribed",
    );
  }
}

async function findFeedBySourceAndExternalId(
  database: Database,
  sourceId: string,
  externalId: string,
): Promise<PublicFeed | null> {
  const rows = await database
    .select(publicColumns())
    .from(feeds)
    .where(and(eq(feeds.sourceId, sourceId), eq(feeds.externalId, externalId)))
    .limit(1);
  return rows[0] ? parsePublicFeed(rows[0]) : null;
}

function ownedSourceIds(database: Database, userId: string) {
  return database.select({ id: sources.id }).from(sources).where(
    eq(sources.userId, userId),
  );
}
export async function createOrReviveFeed(
  database: Database,
  input: CreateOrReviveFeedInput,
): Promise<PublicFeed> {
  const parsed = createFeedInputSchema.parse(input);

  return await database.transaction(async (transaction) => {
    const transactionalDatabase = transaction as Database;
    await lockSourceForFeedWrite(
      transactionalDatabase,
      parsed.sourceId,
      parsed.userId,
    );

    const existingFeed = await findFeedBySourceAndExternalId(
      transactionalDatabase,
      parsed.sourceId,
      parsed.externalId,
    );
    if (existingFeed) {
      if (existingFeed.deletedAt === null) {
        return existingFeed;
      }
      return await reviveFeed(transactionalDatabase, existingFeed.id, parsed);
    }

    return await insertFeed(transactionalDatabase, parsed);
  });
}

async function reviveFeed(
  database: Database,
  id: string,
  input: z.infer<typeof createFeedInputSchema>,
): Promise<PublicFeed> {
  const rows = await database
    .update(feeds)
    .set({
      name: input.name,
      kind: input.kind,
      customPrompt: input.customPrompt ?? null,
      position: input.position ?? null,
      enabled: true,
      deletedAt: null,
      updatedAt: Date.now(),
    })
    .where(eq(feeds.id, id))
    .returning(publicColumns());
  return parsePublicFeed(rows[0]);
}

async function insertFeed(
  database: Database,
  input: z.infer<typeof createFeedInputSchema>,
): Promise<PublicFeed> {
  const now = Date.now();
  try {
    const rows = await database
      .insert(feeds)
      .values({
        sourceId: input.sourceId,
        externalId: input.externalId,
        name: input.name,
        kind: input.kind,
        customPrompt: input.customPrompt ?? null,
        position: input.position ?? null,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning(publicColumns());
    return parsePublicFeed(rows[0]);
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
    const conflictingFeed = await findFeedBySourceAndExternalId(
      database,
      input.sourceId,
      input.externalId,
    );
    if (!conflictingFeed) {
      throw error;
    }
    if (conflictingFeed.deletedAt === null) {
      return conflictingFeed;
    }
    return await reviveFeed(database, conflictingFeed.id, input);
  }
}

export async function listFeedsForUser(
  database: Database,
  userId: string,
  options: ListFeedsForUserOptions = {},
): Promise<PublicFeed[]> {
  const predicates = [eq(sources.userId, userId)];
  if (!options.includeDeleted) {
    predicates.push(isNull(feeds.deletedAt));
  }

  const rows = await database
    .select(publicColumns())
    .from(feeds)
    .innerJoin(sources, eq(feeds.sourceId, sources.id))
    .where(and(...predicates))
    .orderBy(asc(sources.position), asc(feeds.position), asc(feeds.name));
  return rows.map(parsePublicFeed);
}

export async function listFeedsForSource(
  database: Database,
  sourceId: string,
  userId: string,
  options: ListFeedsForUserOptions = {},
): Promise<PublicFeed[]> {
  await assertSourceOwned(database, sourceId, userId);

  const predicates = [eq(feeds.sourceId, sourceId), eq(sources.userId, userId)];
  if (!options.includeDeleted) {
    predicates.push(isNull(feeds.deletedAt));
  }

  const rows = await database
    .select(publicColumns())
    .from(feeds)
    .innerJoin(sources, eq(feeds.sourceId, sources.id))
    .where(and(...predicates))
    .orderBy(asc(feeds.position), asc(feeds.name));
  return rows.map(parsePublicFeed);
}

export async function findFeedById(
  database: Database,
  id: string,
  userId: string,
): Promise<PublicFeed | null> {
  const rows = await database
    .select(publicColumns())
    .from(feeds)
    .innerJoin(sources, eq(feeds.sourceId, sources.id))
    .where(and(eq(feeds.id, id), eq(sources.userId, userId)))
    .limit(1);
  return rows[0] ? parsePublicFeed(rows[0]) : null;
}

export async function updateFeed(
  database: Database,
  id: string,
  userId: string,
  partial: UpdateFeedInput,
): Promise<PublicFeed> {
  const parsed = updateFeedInputSchema.parse(partial);
  const rows = await database
    .update(feeds)
    .set({ ...parsed, updatedAt: Date.now() })
    .where(
      and(
        eq(feeds.id, id),
        inArray(feeds.sourceId, ownedSourceIds(database, userId)),
      ),
    )
    .returning(publicColumns());
  if (!rows[0]) {
    throw new NotFoundError("feed not found");
  }
  return parsePublicFeed(rows[0]);
}

export async function softDeleteFeed(
  database: Database,
  id: string,
  userId: string,
): Promise<PublicFeed> {
  const now = Date.now();
  const rows = await database
    .update(feeds)
    .set({ deletedAt: now, enabled: false, updatedAt: now })
    .where(
      and(
        eq(feeds.id, id),
        inArray(feeds.sourceId, ownedSourceIds(database, userId)),
      ),
    )
    .returning(publicColumns());
  if (!rows[0]) {
    throw new NotFoundError("feed not found");
  }
  return parsePublicFeed(rows[0]);
}

export async function setLastFetched(
  database: Database,
  id: string,
  userId: string,
  lastFetchedPeriodEndMs: number | null,
): Promise<PublicFeed> {
  const rows = await database
    .update(feeds)
    .set({
      lastFetchedPeriodEndMs:
        sql`greatest(${feeds.lastFetchedPeriodEndMs}, ${lastFetchedPeriodEndMs})`,
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(feeds.id, id),
        inArray(feeds.sourceId, ownedSourceIds(database, userId)),
      ),
    )
    .returning(publicColumns());
  if (!rows[0]) {
    throw new NotFoundError("feed not found");
  }
  return parsePublicFeed(rows[0]);
}
