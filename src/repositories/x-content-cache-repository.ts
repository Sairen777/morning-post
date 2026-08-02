import { and, asc, between, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  xRawItemSchema,
  type XRawItem,
} from "../connectors/x/x.types.ts";
import type { Database } from "../db/client.ts";
import {
  xContentCacheItems,
  xContentCacheRanges,
} from "../db/schema/x-content-cache.ts";
import { assertSourceConnectionRevision } from "./source-repository.ts";

/** Inclusive millisecond time window. */
export interface XTimeRange {
  /** Inclusive window start, milliseconds since epoch. */
  from: number;
  /** Inclusive window end, milliseconds since epoch. */
  to: number;
}

/**
 * Source-scoped cache of raw X items (posts, chat messages) and the inclusive
 * time ranges whose content has been fetched. Implementations must be
 * synchronous and scope every operation to a single source and feed.
 */
export interface XContentCache {
  /**
   * Uncovered gaps within `[from, to]` for a feed, derived from merged
   * persisted coverage. Adjacent coverage ranges count as continuous.
   */
  missingRanges(feedExternalId: string, from: number, to: number): XTimeRange[];

  /**
   * Raw items for a feed whose date falls in `[from, to]`, ordered by date
   * then external id (stable).
   */
  read(feedExternalId: string, from: number, to: number): XRawItem[];

  /**
   * Atomically upserts raw items and merges `range` into the feed's coverage,
   * including when `items` is empty (an empty successful fetch still
   * establishes coverage). Overlapping or adjacent ranges merge into one row.
   */
  record(
    feedExternalId: string,
    range: XTimeRange,
    items: XRawItem[],
    fetchedAt?: number,
  ): void;

  /** Atomically removes every cached item and covered range for this source. */
  clear(): void;
}

function assertFeedExternalId(feedExternalId: string): void {
  if (typeof feedExternalId !== "string" || feedExternalId.length === 0) {
    throw new Error("XContentCache: feedExternalId must be a non-empty string");
  }
}

function assertWindow(from: number, to: number): void {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) {
    throw new Error("XContentCache: time bounds must be safe integers (milliseconds)");
  }
  if (from < 0 || to < 0) {
    throw new Error("XContentCache: time bounds must be non-negative");
  }
  if (from > to) {
    throw new Error(`XContentCache: invalid window [${from}, ${to}]`);
  }
}

/**
 * SQLite-backed {@link XContentCache}. Every query is scoped to the source
 * given at construction and to the requested feed external id, so unrelated
 * feeds or ranges are never loaded.
 */
export class DatabaseXContentCache implements XContentCache {
  private readonly database: Database;
  private readonly sourceId: string;
  private readonly expectedCredentialRevision: number | undefined;

  constructor(
    database: Database,
    sourceId: string,
    expectedCredentialRevision?: number,
  ) {
    if (typeof sourceId !== "string" || sourceId.length === 0) {
      throw new Error("DatabaseXContentCache: sourceId must be a non-empty string");
    }
    if (
      expectedCredentialRevision !== undefined &&
      (!Number.isSafeInteger(expectedCredentialRevision) ||
        expectedCredentialRevision < 1)
    ) {
      throw new Error(
        "DatabaseXContentCache: expectedCredentialRevision must be a positive safe integer",
      );
    }
    this.database = database;
    this.sourceId = sourceId;
    this.expectedCredentialRevision = expectedCredentialRevision;
  }

  private assertCurrentConnection(database: Database = this.database): void {
    if (this.expectedCredentialRevision === undefined) return;
    assertSourceConnectionRevision(
      database,
      this.sourceId,
      this.expectedCredentialRevision,
    );
  }

  missingRanges(feedExternalId: string, from: number, to: number): XTimeRange[] {
    assertFeedExternalId(feedExternalId);
    assertWindow(from, to);
    this.assertCurrentConnection();

    const rows = this.database
      .select()
      .from(xContentCacheRanges)
      .where(and(
        eq(xContentCacheRanges.sourceId, this.sourceId),
        eq(xContentCacheRanges.feedExternalId, feedExternalId),
        lte(xContentCacheRanges.startMs, to),
        gte(xContentCacheRanges.endMs, from),
      ))
      .orderBy(asc(xContentCacheRanges.startMs))
      .all();

    // Merge overlapping or adjacent coverage (storage keeps rows disjoint and
    // non-adjacent, but merging defensively keeps gap math exact).
    const merged: XTimeRange[] = [];
    for (const row of rows) {
      const range: XTimeRange = { from: row.startMs, to: row.endMs };
      const last = merged[merged.length - 1];
      if (last !== undefined && range.from <= last.to + 1) {
        if (range.to > last.to) {
          last.to = range.to;
        }
      } else {
        merged.push(range);
      }
    }

    // Complement of merged coverage within [from, to].
    const gaps: XTimeRange[] = [];
    let cursor = from;
    for (const range of merged) {
      if (range.to < cursor) {
        continue;
      }
      if (range.from > cursor) {
        gaps.push({ from: cursor, to: Math.min(range.from - 1, to) });
      }
      cursor = Math.max(cursor, range.to + 1);
      if (cursor > to) {
        break;
      }
    }
    if (cursor <= to) {
      gaps.push({ from: cursor, to });
    }
    return gaps;
  }

  read(feedExternalId: string, from: number, to: number): XRawItem[] {
    assertFeedExternalId(feedExternalId);
    assertWindow(from, to);
    this.assertCurrentConnection();

    const rows = this.database
      .select()
      .from(xContentCacheItems)
      .where(and(
        eq(xContentCacheItems.sourceId, this.sourceId),
        eq(xContentCacheItems.feedExternalId, feedExternalId),
        between(xContentCacheItems.date, from, to),
      ))
      .orderBy(asc(xContentCacheItems.date), asc(xContentCacheItems.externalId))
      .all();

    return rows.map((row) => xRawItemSchema.parse(row.payload));
  }

  clear(): void {
    this.database.transaction((tx) => {
      tx.delete(xContentCacheItems)
        .where(eq(xContentCacheItems.sourceId, this.sourceId))
        .run();
      tx.delete(xContentCacheRanges)
        .where(eq(xContentCacheRanges.sourceId, this.sourceId))
        .run();
    }, { behavior: "immediate" });
  }

  record(
    feedExternalId: string,
    range: XTimeRange,
    items: XRawItem[],
    fetchedAt = Date.now(),
  ): void {
    assertFeedExternalId(feedExternalId);
    assertWindow(range.from, range.to);
    const validItems = items.map((item) => xRawItemSchema.parse(item));

    this.database.transaction((tx) => {
      this.assertCurrentConnection(tx as Database);
      if (validItems.length > 0) {
        tx.insert(xContentCacheItems)
          .values(validItems.map((item) => ({
            sourceId: this.sourceId,
            feedExternalId,
            externalId: item.externalId,
            date: item.date,
            payload: item,
            fetchedAt,
          })))
          .onConflictDoUpdate({
            target: [
              xContentCacheItems.sourceId,
              xContentCacheItems.feedExternalId,
              xContentCacheItems.externalId,
            ],
            set: {
              date: sql`excluded.date`,
              payload: sql`excluded.payload`,
              fetchedAt: sql`excluded.fetched_at`,
            },
          })
          .run();
      }

      // Merge this range with every persisted range it overlaps or is
      // adjacent to (gap of one millisecond counts as contiguous), replacing
      // them with a single covering row.
      const overlapping = tx
        .select()
        .from(xContentCacheRanges)
        .where(and(
          eq(xContentCacheRanges.sourceId, this.sourceId),
          eq(xContentCacheRanges.feedExternalId, feedExternalId),
          lte(xContentCacheRanges.startMs, range.to + 1),
          gte(xContentCacheRanges.endMs, range.from - 1),
        ))
        .all();

      let mergedFrom = range.from;
      let mergedTo = range.to;
      if (overlapping.length > 0) {
        for (const row of overlapping) {
          if (row.startMs < mergedFrom) {
            mergedFrom = row.startMs;
          }
          if (row.endMs > mergedTo) {
            mergedTo = row.endMs;
          }
        }
        tx.delete(xContentCacheRanges)
          .where(inArray(
            xContentCacheRanges.id,
            overlapping.map((row) => row.id),
          ))
          .run();
      }

      tx.insert(xContentCacheRanges)
        .values({
          sourceId: this.sourceId,
          feedExternalId,
          startMs: mergedFrom,
          endMs: mergedTo,
          fetchedAt,
        })
        .run();
    }, { behavior: "immediate" });
  }
}
