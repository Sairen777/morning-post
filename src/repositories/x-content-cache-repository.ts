import { and, asc, between, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  xRawItemSchema,
  type XRawItem,
} from "../connectors/x/x.types.ts";
import type { Database } from "../db/client.ts";
import { feeds } from "../db/schema/feed.ts";
import {
  xContentCacheItems,
  xContentCacheRanges,
  xContentFetchProgress,
  type XContentProgressBlockReason,
} from "../db/schema/x-content-cache.ts";
import { ConflictError } from "../server/errors.ts";
import { assertSourceConnectionRevision } from "./source-repository.ts";

export type { XContentProgressBlockReason };

/**
 * Upper bound for the durable per-range cursor history. When the bound is
 * reached the oldest entries are dropped, so the window always tracks the
 * most recent distinct cursors.
 */
const MAX_SEEN_CURSORS = 500;

/** Inclusive millisecond time window. */
export interface XTimeRange {
  /** Inclusive window start, milliseconds since epoch. */
  from: number;
  /** Inclusive window end, milliseconds since epoch. */
  to: number;
}

/**
 * Persisted fetch progress for a range whose coverage is not yet committed.
 * Each successful provider page is durably recorded before the next provider
 * request, so a crashed or failed run leaves items plus the next cursor
 * behind and a retry can resume the range instead of re-fetching page 1.
 */
export interface XContentPageProgress {
  /** Exact range this progress belongs to. */
  range: XTimeRange;
  /**
   * Opaque provider cursor for the next page, or `null` when the provider
   * reported the range finished or the page was recorded with a terminal
   * block reason.
   */
  nextCursor: string | null;
  /** Number of provider pages durably recorded for this range. */
  pageCount: number;
  /** Milliseconds since epoch of the most recent recorded page. */
  updatedAt: number;
  /**
   * Terminal block reason, or `null` while the range is normally resumable.
   * Once non-null the range is finished-for-good: later pages keep the
   * reason and a retry must not resume the range.
   */
  blockedReason: XContentProgressBlockReason | null;
  /**
   * Distinct provider cursors durably recorded for this range, in arrival
   * order, bounded to the most recent 500 entries. Drives automatic
   * repeated-cursor detection across runs and restarts.
   */
  seenCursors: string[];
}

/**
 * Optional inputs for {@link XContentCache.recordPage}. Passing the options
 * object is the only supported call shape; the old positional `fetchedAt`
 * argument is gone.
 */
export interface XContentRecordPageOptions {
  /** Milliseconds since epoch used for the page's item and progress timestamps. */
  fetchedAt?: number;
  /**
   * Terminal reason to persist atomically with this page. The range becomes
   * non-resumable and the reason is never cleared by later pages. Pass this
   * for caller-detected terminal conditions (e.g. `"missing_cursor"` or
   * `"mismatched_conversation"`); provider cursor cycles are detected
   * automatically from the durable cursor history and persisted as
   * `"repeated_cursor"` without any option.
   */
  blockedReason?: XContentProgressBlockReason | null;
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
   * Persisted but unfinished fetch progress for ranges overlapping
   * `[from, to]` on a feed, ordered by range start. Lets a retry with a
   * slightly wider digest window resume sunk-cost ranges from their saved
   * cursor before fetching new gaps. Progress whose `blockedReason` is
   * non-null is terminal: it must not be resumed, only reported.
   */
  pendingRanges(
    feedExternalId: string,
    from: number,
    to: number,
  ): XContentPageProgress[];

  /**
   * Atomically persists one provider page for an unfinished range: upserts
   * the raw items and replaces the range's next cursor, bumping its page
   * count. Adds NO coverage, so partial pages stay invisible to gap
   * computation until the whole range is committed. Safe to call
   * repeatedly; a retry of an already recorded page just bumps the count.
   *
   * Runs inside one immediate transaction: the durable cursor history is
   * read, a non-null `nextCursor` that already appears in it is detected as
   * a provider cycle and persisted as `blockedReason: "repeated_cursor"`,
   * and items, cursor, page count, history, and reason are written
   * together. Pass `options.blockedReason` for terminal conditions the
   * caller detects itself (e.g. `"missing_cursor"`); a supplied reason
   * wins over auto-detection, and a reason, once persisted, is never
   * cleared by later pages.
   *
   * Returns the persisted progress state, including the updated
   * `seenCursors` history and the effective `blockedReason`.
   */
  recordPage(
    feedExternalId: string,
    range: XTimeRange,
    items: XRawItem[],
    nextCursor: string | null,
    options?: XContentRecordPageOptions,
  ): XContentPageProgress;

  /**
   * Atomically commits a fully fetched range: upserts raw items, merges
   * `range` into the feed's coverage (including when `items` is empty — an
   * empty successful fetch still establishes coverage), and deletes the
   * pending progress row for this exact range. Overlapping or adjacent
   * coverage ranges merge into one row. Call only when the entire range has
   * been fetched or the provider reported exhaustion.
   */
  record(
    feedExternalId: string,
    range: XTimeRange,
    items: XRawItem[],
    fetchedAt?: number,
  ): void;

  /**
   * Atomically removes every cached item, covered range, and pending fetch
   * progress for this source.
   */
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

  /**
   * Revision-bound caches must not plan or persist work for a feed that is
   * disabled or soft-deleted: a fetch would repurchase paid content for a
   * feed the user can no longer see, and writes would resurrect raw data.
   * Fetch-planning methods (missingRanges, pendingRanges) call this up front,
   * and the write methods run it inside the same immediate transaction as the
   * source revision check, so the write lock pins both the source connection
   * state and the feed's activity. Unrestricted caches (no expected revision)
   * keep legacy behavior and skip the check entirely.
   */
  private assertFeedActive(
    database: Database,
    feedExternalId: string,
  ): void {
    if (this.expectedCredentialRevision === undefined) return;
    const feed = database
      .select({ id: feeds.id })
      .from(feeds)
      .where(and(
        eq(feeds.sourceId, this.sourceId),
        eq(feeds.externalId, feedExternalId),
        eq(feeds.enabled, true),
        isNull(feeds.deletedAt),
      ))
      .limit(1)
      .get();
    if (!feed) {
      throw new ConflictError(
        "source connection changed or feed became inactive; retry ingestion",
      );
    }
  }

  missingRanges(feedExternalId: string, from: number, to: number): XTimeRange[] {
    assertFeedExternalId(feedExternalId);
    assertWindow(from, to);
    this.assertCurrentConnection();
    this.assertFeedActive(this.database, feedExternalId);

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

  pendingRanges(
    feedExternalId: string,
    from: number,
    to: number,
  ): XContentPageProgress[] {
    assertFeedExternalId(feedExternalId);
    assertWindow(from, to);
    this.assertCurrentConnection();
    this.assertFeedActive(this.database, feedExternalId);

    const rows = this.database
      .select()
      .from(xContentFetchProgress)
      .where(and(
        eq(xContentFetchProgress.sourceId, this.sourceId),
        eq(xContentFetchProgress.feedExternalId, feedExternalId),
        lte(xContentFetchProgress.startMs, to),
        gte(xContentFetchProgress.endMs, from),
      ))
      .orderBy(asc(xContentFetchProgress.startMs))
      .all();

    return rows.map((row) => ({
      range: { from: row.startMs, to: row.endMs },
      nextCursor: row.nextCursor,
      pageCount: row.pageCount,
      updatedAt: row.updatedAt,
      blockedReason: row.blockedReason,
      seenCursors: row.seenCursors,
    }));
  }

  recordPage(
    feedExternalId: string,
    range: XTimeRange,
    items: XRawItem[],
    nextCursor: string | null,
    options?: XContentRecordPageOptions,
  ): XContentPageProgress {
    assertFeedExternalId(feedExternalId);
    assertWindow(range.from, range.to);
    if (nextCursor !== null && typeof nextCursor !== "string") {
      throw new Error("XContentCache: nextCursor must be a string or null");
    }
    const fetchedAt = options?.fetchedAt ?? Date.now();
    const suppliedBlockedReason = options?.blockedReason ?? null;
    if (
      suppliedBlockedReason !== null &&
      suppliedBlockedReason !== "repeated_cursor" &&
      suppliedBlockedReason !== "missing_cursor" &&
      suppliedBlockedReason !== "mismatched_conversation"
    ) {
      throw new Error(
        `XContentCache: unsupported blockedReason ${JSON.stringify(suppliedBlockedReason)}`,
      );
    }
    const validItems = items.map((item) => xRawItemSchema.parse(item));

    return this.database.transaction((tx) => {
      this.assertCurrentConnection(tx as Database);
      this.assertFeedActive(tx as Database, feedExternalId);

      // Read the durable state for the exact range inside the same immediate
      // transaction, so repeat detection and the page write are one atomic
      // unit: two concurrent pages can never both pass detection.
      const existing = tx
        .select()
        .from(xContentFetchProgress)
        .where(and(
          eq(xContentFetchProgress.sourceId, this.sourceId),
          eq(xContentFetchProgress.feedExternalId, feedExternalId),
          eq(xContentFetchProgress.startMs, range.from),
          eq(xContentFetchProgress.endMs, range.to),
        ))
        .get();

      const pageCount = existing ? existing.pageCount + 1 : 1;
      const seenCursors = existing?.seenCursors ?? [];
      const cursorRepeats =
        nextCursor !== null && seenCursors.includes(nextCursor);

      // Terminal reasons are sticky: an existing block is never replaced or
      // cleared, and a caller-supplied reason wins over auto-detection.
      let blockedReason = existing?.blockedReason ?? null;
      if (blockedReason === null) {
        blockedReason =
          suppliedBlockedReason ?? (cursorRepeats ? "repeated_cursor" : null);
      }

      // Append the page cursor to the durable history exactly once, checked
      // before append so a repeated cursor never grows the history.
      let nextSeenCursors = seenCursors;
      if (nextCursor !== null && !seenCursors.includes(nextCursor)) {
        nextSeenCursors = [...seenCursors, nextCursor];
        if (nextSeenCursors.length > MAX_SEEN_CURSORS) {
          nextSeenCursors = nextSeenCursors.slice(-MAX_SEEN_CURSORS);
        }
      }

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

      if (existing) {
        tx.update(xContentFetchProgress)
          .set({
            nextCursor,
            blockedReason,
            pageCount,
            seenCursors: nextSeenCursors,
            updatedAt: fetchedAt,
          })
          .where(and(
            eq(xContentFetchProgress.sourceId, this.sourceId),
            eq(xContentFetchProgress.feedExternalId, feedExternalId),
            eq(xContentFetchProgress.startMs, range.from),
            eq(xContentFetchProgress.endMs, range.to),
          ))
          .run();
      } else {
        tx.insert(xContentFetchProgress)
          .values({
            sourceId: this.sourceId,
            feedExternalId,
            startMs: range.from,
            endMs: range.to,
            nextCursor,
            blockedReason,
            pageCount,
            seenCursors: nextSeenCursors,
            createdAt: fetchedAt,
            updatedAt: fetchedAt,
          })
          .run();
      }

      return {
        range,
        nextCursor,
        pageCount,
        updatedAt: fetchedAt,
        blockedReason,
        seenCursors: nextSeenCursors,
      };
    }, { behavior: "immediate" });
  }

  clear(): void {
    this.database.transaction((tx) => {
      tx.delete(xContentCacheItems)
        .where(eq(xContentCacheItems.sourceId, this.sourceId))
        .run();
      tx.delete(xContentCacheRanges)
        .where(eq(xContentCacheRanges.sourceId, this.sourceId))
        .run();
      tx.delete(xContentFetchProgress)
        .where(eq(xContentFetchProgress.sourceId, this.sourceId))
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
      this.assertFeedActive(tx as Database, feedExternalId);
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

      // Final commit: the range is fully covered, so its pending progress
      // (cursor, page count) is no longer resumable and must not linger.
      tx.delete(xContentFetchProgress)
        .where(and(
          eq(xContentFetchProgress.sourceId, this.sourceId),
          eq(xContentFetchProgress.feedExternalId, feedExternalId),
          eq(xContentFetchProgress.startMs, range.from),
          eq(xContentFetchProgress.endMs, range.to),
        ))
        .run();
    }, { behavior: "immediate" });
  }
}
