import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.ts";
import { feeds } from "../db/schema/feed.ts";
import { sources } from "../db/schema/source.ts";
import { users } from "../db/schema/user.ts";
import { ConflictError, NotFoundError } from "../server/errors.ts";
import type { FeedKind } from "../connectors/connector.types.ts";
import { isUniqueViolation } from "../db/errors.ts";
import {
  summarizationModes,
  type SummarizationMode,
} from "../summarization-mode.ts";

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
  summarizationMode: z.enum(summarizationModes),
  relevanceFilterMode: z.enum(["inherit", "personalized", "include_all"]),
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
  summarizationMode: z.enum(summarizationModes).optional(),
  relevanceFilterMode: z.enum(["inherit", "personalized", "include_all"]).optional(),
});

const updateFeedInputSchema = z.object({
  kind: feedKindSchema.optional(),
  customPrompt: z.string().nullable().optional(),
  position: z.number().int().nullable().optional(),
  enabled: z.boolean().optional(),
  summarizationMode: z.enum(summarizationModes).optional(),
  relevanceFilterMode: z.enum(["inherit", "personalized", "include_all"]).optional(),
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
  summarizationMode?: SummarizationMode;
  relevanceFilterMode?: "inherit" | "personalized" | "include_all";
}

export type UpdateFeedInput = Partial<{
  kind: FeedKind;
  customPrompt: string | null;
  position: number | null;
  enabled: boolean;
  summarizationMode: SummarizationMode;
  relevanceFilterMode: "inherit" | "personalized" | "include_all";
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
    summarizationMode: feeds.summarizationMode,
    relevanceFilterMode: feeds.relevanceFilterMode,
    deletedAt: feeds.deletedAt,
    lastFetchedPeriodEndMs: feeds.lastFetchedPeriodEndMs,
    createdAt: feeds.createdAt,
    updatedAt: feeds.updatedAt,
  };
}

function parsePublicFeed(row: unknown): PublicFeed {
  return publicFeedRowSchema.parse(row);
}

function assertSourceOwned(
  database: Database,
  sourceId: string,
  userId: string,
): void {
  const row = database
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.id, sourceId), eq(sources.userId, userId)))
    .get();
  if (!row) {
    throw new NotFoundError("source not found");
  }
}

function lockSourceForFeedWrite(
  database: Database,
  sourceId: string,
  userId: string,
): void {
  const source = database
    .select({ id: sources.id, credentials: sources.credentials })
    .from(sources)
    .where(and(eq(sources.id, sourceId), eq(sources.userId, userId)))
    .get();
  if (!source) {
    throw new NotFoundError("source not found");
  }
  if (source.credentials === null) {
    throw new ConflictError(
      "source must be reconnected before feeds can be subscribed",
    );
  }
}

function findFeedBySourceAndExternalId(
  database: Database,
  sourceId: string,
  externalId: string,
): PublicFeed | null {
  const row = database
    .select(publicColumns())
    .from(feeds)
    .where(and(eq(feeds.sourceId, sourceId), eq(feeds.externalId, externalId)))
    .get();
  return row ? parsePublicFeed(row) : null;
}

function ownedSourceIds(database: Database, userId: string) {
  return database.select({ id: sources.id }).from(sources).where(
    eq(sources.userId, userId),
  );
}
export function createOrReviveFeed(
  database: Database,
  input: CreateOrReviveFeedInput,
): PublicFeed {
  const parsed = createFeedInputSchema.parse(input);

  return database.transaction((transaction) => {
    const transactionalDatabase = transaction as Database;
    lockSourceForFeedWrite(
      transactionalDatabase,
      parsed.sourceId,
      parsed.userId,
    );

    const existingFeed = findFeedBySourceAndExternalId(
      transactionalDatabase,
      parsed.sourceId,
      parsed.externalId,
    );
    if (existingFeed) {
      if (existingFeed.deletedAt === null) {
        return existingFeed;
      }
      return reviveFeed(transactionalDatabase, existingFeed.id, parsed);
    }

    return insertFeed(transactionalDatabase, parsed);
  }, { behavior: "immediate" });
}

function reviveFeed(
  database: Database,
  id: string,
  input: z.infer<typeof createFeedInputSchema>,
): PublicFeed {
  const row = database
    .update(feeds)
    .set({
      name: input.name,
      kind: input.kind,
      customPrompt: input.customPrompt ?? null,
      position: input.position ?? null,
      summarizationMode: input.summarizationMode ?? "basic",
      relevanceFilterMode: input.relevanceFilterMode ?? "inherit",
      enabled: true,
      deletedAt: null,
      updatedAt: Date.now(),
    })
    .where(eq(feeds.id, id))
    .returning(publicColumns())
    .get();
  return parsePublicFeed(row);
}

function insertFeed(
  database: Database,
  input: z.infer<typeof createFeedInputSchema>,
): PublicFeed {
  const now = Date.now();
  try {
    const row = database
      .insert(feeds)
      .values({
        sourceId: input.sourceId,
        externalId: input.externalId,
        name: input.name,
        kind: input.kind,
        customPrompt: input.customPrompt ?? null,
        position: input.position ?? null,
        enabled: true,
        summarizationMode: input.summarizationMode ?? "basic",
        relevanceFilterMode: input.relevanceFilterMode ?? "inherit",
        createdAt: now,
        updatedAt: now,
      })
      .returning(publicColumns())
      .get();
    return parsePublicFeed(row);
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
    const conflictingFeed = findFeedBySourceAndExternalId(
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
    return reviveFeed(database, conflictingFeed.id, input);
  }
}

export function listFeedsForUser(
  database: Database,
  userId: string,
  options: ListFeedsForUserOptions = {},
): PublicFeed[] {
  const predicates = [eq(sources.userId, userId)];
  if (!options.includeDeleted) {
    predicates.push(isNull(feeds.deletedAt));
  }

  const rows = database
    .select(publicColumns())
    .from(feeds)
    .innerJoin(sources, eq(feeds.sourceId, sources.id))
    .where(and(...predicates))
    .orderBy(
      asc(sql`${sources.position} is null`),
      asc(sources.position),
      asc(sql`${feeds.position} is null`),
      asc(feeds.position),
      asc(feeds.name),
    )
    .all();
  return rows.map(parsePublicFeed);
}

export function listFeedsForSource(
  database: Database,
  sourceId: string,
  userId: string,
  options: ListFeedsForUserOptions = {},
): PublicFeed[] {
  assertSourceOwned(database, sourceId, userId);

  const predicates = [eq(feeds.sourceId, sourceId), eq(sources.userId, userId)];
  if (!options.includeDeleted) {
    predicates.push(isNull(feeds.deletedAt));
  }

  const rows = database
    .select(publicColumns())
    .from(feeds)
    .innerJoin(sources, eq(feeds.sourceId, sources.id))
    .where(and(...predicates))
    .orderBy(
      asc(sql`${feeds.position} is null`),
      asc(feeds.position),
      asc(feeds.name),
    )
    .all();
  return rows.map(parsePublicFeed);
}

export function findFeedById(
  database: Database,
  id: string,
  userId: string,
): PublicFeed | null {
  const row = database
    .select(publicColumns())
    .from(feeds)
    .innerJoin(sources, eq(feeds.sourceId, sources.id))
    .where(and(eq(feeds.id, id), eq(sources.userId, userId)))
    .get();
  return row ? parsePublicFeed(row) : null;
}

function updateFeedRow(
  database: Database,
  id: string,
  userId: string,
  partial: UpdateFeedInput,
): PublicFeed {
  const parsed = updateFeedInputSchema.parse(partial);
  const row = database
    .update(feeds)
    .set({ ...parsed, updatedAt: Date.now() })
    .where(
      and(
        eq(feeds.id, id),
        inArray(feeds.sourceId, ownedSourceIds(database, userId)),
      ),
    )
    .returning(publicColumns())
    .get();
  if (!row) {
    throw new NotFoundError("feed not found");
  }
  return parsePublicFeed(row);
}

export function updateFeed(
  database: Database,
  id: string,
  userId: string,
  partial: UpdateFeedInput,
): PublicFeed {
  if (partial.relevanceFilterMode === undefined) {
    return updateFeedRow(database, id, userId, partial);
  }
  return database.transaction((transaction) => {
    const transactionalDatabase = transaction as Database;
    const before = findFeedById(transactionalDatabase, id, userId);
    if (!before) {
      throw new NotFoundError("feed not found");
    }
    const updated = updateFeedRow(transactionalDatabase, id, userId, partial);
    if (before.relevanceFilterMode !== updated.relevanceFilterMode) {
      transactionalDatabase.update(users).set({
        interestProfileVersion: sql`${users.interestProfileVersion} + 1`,
      }).where(eq(users.id, userId)).run();
    }
    return updated;
  }, { behavior: "immediate" });
}

export function softDeleteFeed(
  database: Database,
  id: string,
  userId: string,
): PublicFeed {
  const now = Date.now();
  const row = database
    .update(feeds)
    .set({ deletedAt: now, enabled: false, updatedAt: now })
    .where(
      and(
        eq(feeds.id, id),
        inArray(feeds.sourceId, ownedSourceIds(database, userId)),
      ),
    )
    .returning(publicColumns())
    .get();
  if (!row) {
    throw new NotFoundError("feed not found");
  }
  return parsePublicFeed(row);
}

export function setLastFetched(
  database: Database,
  id: string,
  userId: string,
  lastFetchedPeriodEndMs: number | null,
): PublicFeed {
  const row = database
    .update(feeds)
    .set({
      lastFetchedPeriodEndMs: sql`case
        when ${feeds.lastFetchedPeriodEndMs} is null then ${lastFetchedPeriodEndMs}
        when ${lastFetchedPeriodEndMs} is null then ${feeds.lastFetchedPeriodEndMs}
        when ${feeds.lastFetchedPeriodEndMs} >= ${lastFetchedPeriodEndMs}
          then ${feeds.lastFetchedPeriodEndMs}
        else ${lastFetchedPeriodEndMs}
      end`,
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(feeds.id, id),
        inArray(feeds.sourceId, ownedSourceIds(database, userId)),
      ),
    )
    .returning(publicColumns())
    .get();
  if (!row) {
    throw new NotFoundError("feed not found");
  }
  return parsePublicFeed(row);
}
