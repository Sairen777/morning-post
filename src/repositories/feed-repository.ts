import { and, asc, count, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.ts";
import { feeds } from "../db/schema/feed.ts";
import { sources } from "../db/schema/source.ts";
import { users } from "../db/schema/user.ts";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../server/errors.ts";
import type { FeedKind } from "../connectors/connector.types.ts";
import { ConnectorId } from "../constants.ts";
import { MAX_X_ACTIVE_FEEDS } from "../connectors/x/x-connector.ts";
import { parseXFeedExternalId } from "../connectors/x/targets.ts";
import { isUniqueViolation } from "../db/errors.ts";
import {
  clearDiscoveredFeedsForSource,
  findDiscoveredFeedForRevision,
} from "./x-discovered-feed-repository.ts";
import {
  summarizationModes,
  type SummarizationMode,
} from "../summarization-mode.ts";
import { deleteItemsForFeedsOfSource } from "./item-repository.ts";

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

interface LockedSourceForFeedWrite {
  connectorId: string;
  credentialRevision: number;
}

function lockSourceForFeedWrite(
  database: Database,
  sourceId: string,
  userId: string,
): LockedSourceForFeedWrite {
  const source = database
    .select({
      id: sources.id,
      credentials: sources.credentials,
      connectorId: sources.connectorId,
      credentialRevision: sources.credentialRevision,
    })
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
  return {
    connectorId: source.connectorId,
    credentialRevision: source.credentialRevision,
  };
}

/**
 * Authorization gate for X subscription. Runs inside the feed write
 * transaction after the source row has been locked, so the revision read here
 * is the same one the catalog lookup and the insert/revive commit against.
 *
 * Malformed or non-list/non-chat targets are rejected as validation errors
 * before any write; well-formed targets are authorized only by an exact
 * catalog entry for the source's current credential revision, and the
 * server-canonical catalog name/kind always win over client-supplied
 * metadata. Uncataloged targets (including direct-DM conversations, which
 * discovery never returns) fail closed without any upstream call.
 */
function requireCatalogedXTarget(
  database: Database,
  sourceId: string,
  credentialRevision: number,
  externalId: string,
): { name: string; kind: FeedKind } {
  try {
    parseXFeedExternalId(externalId);
  } catch (error) {
    throw new ValidationError(
      error instanceof Error ? error.message : "invalid X feed external ID",
    );
  }
  const cataloged = findDiscoveredFeedForRevision(
    database,
    sourceId,
    credentialRevision,
    externalId,
  );
  if (!cataloged) {
    throw new ConflictError(
      "X target was not discovered for the current connection; run discovery again",
    );
  }
  return { name: cataloged.name, kind: cataloged.kind };
}

export function assertFeedActiveForSourceConnectionRevision(
  database: Database,
  feedId: string,
  userId: string,
  expectedRevision: number,
): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new ConflictError("source connection changed; retry ingestion");
  }
  const current = database
    .select({ id: feeds.id })
    .from(feeds)
    .innerJoin(sources, eq(feeds.sourceId, sources.id))
    .where(and(
      eq(feeds.id, feedId),
      eq(sources.userId, userId),
      eq(sources.credentialRevision, expectedRevision),
      eq(sources.enabled, true),
      isNotNull(sources.credentials),
      eq(feeds.enabled, true),
      isNull(feeds.deletedAt),
    ))
    .limit(1)
    .get();
  if (!current) {
    throw new ConflictError(
      "source connection changed or feed became inactive; retry ingestion",
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
    const locked = lockSourceForFeedWrite(
      transactionalDatabase,
      parsed.sourceId,
      parsed.userId,
    );

    // X subscriptions are authorized only by the discovery catalog for the
    // source's current credential revision, rechecked in this same immediate
    // transaction. Client-supplied name/kind are ignored in favor of the
    // server-canonical catalog values, and an active feed count cap mirrors
    // the connector's per-batch limit so persistence can never exceed what
    // ingestion will accept.
    const canonicalTarget = locked.connectorId === ConnectorId.X
      ? requireCatalogedXTarget(
        transactionalDatabase,
        parsed.sourceId,
        locked.credentialRevision,
        parsed.externalId,
      )
      : null;
    const effectiveInput = canonicalTarget === null
      ? parsed
      : { ...parsed, name: canonicalTarget.name, kind: canonicalTarget.kind };

    const existingFeed = findFeedBySourceAndExternalId(
      transactionalDatabase,
      parsed.sourceId,
      parsed.externalId,
    );
    if (existingFeed) {
      if (existingFeed.deletedAt === null) {
        return existingFeed;
      }
      if (locked.connectorId === ConnectorId.X) {
        assertUnderActiveFeedCap(transactionalDatabase, parsed.sourceId);
      }
      return reviveFeed(transactionalDatabase, existingFeed.id, effectiveInput);
    }

    if (locked.connectorId === ConnectorId.X) {
      assertUnderActiveFeedCap(transactionalDatabase, parsed.sourceId);
    }
    return insertFeed(transactionalDatabase, effectiveInput);
  }, { behavior: "immediate" });
}

/**
 * Mirrors the connector's `MAX_X_ACTIVE_FEEDS` batch limit for persisted
 * feeds: a subscription that would leave more than the limit active (not
 * soft-deleted) is rejected so ingestion jobs can never be poisoned by
 * over-cap state. Counting inside the same immediate transaction as the
 * insert/revive keeps the check race-free.
 */
function assertUnderActiveFeedCap(
  database: Database,
  sourceId: string,
): void {
  const row = database
    .select({ active: count() })
    .from(feeds)
    .where(and(eq(feeds.sourceId, sourceId), isNull(feeds.deletedAt)))
    .get();
  if ((row?.active ?? 0) >= MAX_X_ACTIVE_FEEDS) {
    throw new ConflictError(
      `X subscription limit reached: at most ${MAX_X_ACTIVE_FEEDS} active feeds per source`,
    );
  }
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

export function resetFeedsForSourceConnection(
  database: Database,
  sourceId: string,
): void {
  const now = Date.now();
  database
    .update(feeds)
    .set({
      deletedAt: sql`coalesce(${feeds.deletedAt}, ${now})`,
      enabled: false,
      lastFetchedPeriodEndMs: null,
      updatedAt: now,
    })
    .where(eq(feeds.sourceId, sourceId))
    .run();
  // Normalized items belong to the account the source was last connected to.
  // A revived feed reuses its row, so the items must not survive the reset or
  // a later revival could expose the previous account's content.
  deleteItemsForFeedsOfSource(database, sourceId);
  // Revoke every discovery authorization for the connection epoch. Callers
  // run this inside their own immediate transaction (account-change reset),
  // so the feed reset, normalized-item deletion, and this catalog clear all
  // commit atomically.
  clearDiscoveredFeedsForSource(database, sourceId);
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
