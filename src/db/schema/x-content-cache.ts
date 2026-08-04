import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import type { XRawItem } from "../../connectors/x/x.types.ts";
import { sources } from "./source.ts";

/**
 * Raw X items (posts and chat messages) fetched through TwexAPI, keyed per
 * source and feed external id (`x:list:<id>` / `x:chat:<id>`). Payloads are
 * stored verbatim so normalized rendering can evolve independently of the
 * cached raw data. Deleting a source cascades its cache rows.
 */
export const xContentCacheItems = sqliteTable("x_content_cache_items",
{
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  sourceId: text("source_id")
    .notNull()
    .references(() => sources.id, { onDelete: "cascade" }),
  feedExternalId: text("feed_external_id").notNull(),
  externalId: text("external_id").notNull(),
  date: integer("date", { mode: "number" }).notNull(),
  payload: text("payload", { mode: "json" }).$type<XRawItem>().notNull(),
  fetchedAt: integer("fetched_at", { mode: "number" }).notNull(),
},
(table) => [
  unique("x_content_cache_items_source_feed_external_unique").on(
    table.sourceId,
    table.feedExternalId,
    table.externalId,
  ),
  index("x_content_cache_items_feed_date_external_idx").on(
    table.sourceId,
    table.feedExternalId,
    table.date,
    table.externalId,
  ),
],);

/**
 * Covered inclusive time ranges per source and feed external id. Adjacent or
 * overlapping ranges are merged on write, so persisted rows are never
 * contiguous; gap computation treats adjacency as coverage.
 */
export const xContentCacheRanges = sqliteTable("x_content_cache_ranges",
{
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  sourceId: text("source_id")
    .notNull()
    .references(() => sources.id, { onDelete: "cascade" }),
  feedExternalId: text("feed_external_id").notNull(),
  startMs: integer("start_ms", { mode: "number" }).notNull(),
  endMs: integer("end_ms", { mode: "number" }).notNull(),
  fetchedAt: integer("fetched_at", { mode: "number" }).notNull(),
},
(table) => [
  unique("x_content_cache_ranges_source_feed_start_unique").on(
    table.sourceId,
    table.feedExternalId,
    table.startMs,
  ),
  index("x_content_cache_ranges_feed_start_end_idx").on(
    table.sourceId,
    table.feedExternalId,
    table.startMs,
    table.endMs,
  ),
  check("x_content_cache_ranges_window_check", sql`${table.endMs} >= ${table.startMs}`),
],);

/**
 * Terminal reasons a fetch range can never be completed. A blocked range must
 * not be resumed or retried: ingestion of the affected window stops locally.
 */
export type XContentProgressBlockReason =
  | "repeated_cursor"
  | "missing_cursor"
  | "mismatched_conversation";

/**
 * Fetch progress for a range whose coverage is not yet committed. One row per
 * (source, feed, exact range): the next provider cursor and the number of
 * pages persisted so far survive process or run failure, so a retry can
 * resume a sunk-cost range from its cursor instead of re-fetching page 1.
 * Rows never contribute coverage; they are deleted when the range is
 * committed through `record`, on cache clear, or when the source is deleted.
 *
 * A row may instead carry a terminal {@link XContentProgressBlockReason}
 * written atomically with the page that exposed it; such a range is never
 * resumed, and the reason survives every later page write.
 *
 * Each row also records the distinct provider cursors seen so far (bounded
 * to the most recent 500) so a provider that cycles its cursor is detected
 * durably, even across process restarts.
 */
export const xContentFetchProgress = sqliteTable("x_content_fetch_progress",
{
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  sourceId: text("source_id")
    .notNull()
    .references(() => sources.id, { onDelete: "cascade" }),
  feedExternalId: text("feed_external_id").notNull(),
  startMs: integer("start_ms", { mode: "number" }).notNull(),
  endMs: integer("end_ms", { mode: "number" }).notNull(),
  nextCursor: text("next_cursor"),
  blockedReason: text("blocked_reason").$type<XContentProgressBlockReason>(),
  seenCursors: text("seen_cursors", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default([]),
  pageCount: integer("page_count", { mode: "number" }).notNull(),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
},
(table) => [
  unique("x_content_fetch_progress_source_feed_range_unique").on(
    table.sourceId,
    table.feedExternalId,
    table.startMs,
    table.endMs,
  ),
  check("x_content_fetch_progress_window_check", sql`${table.endMs} >= ${table.startMs}`),
  check(
    "x_content_fetch_progress_blocked_reason_check",
    sql`${table.blockedReason} is null or ${table.blockedReason} in ('repeated_cursor', 'missing_cursor', 'mismatched_conversation')`,
  ),
],);

export type XContentCacheItemRow = typeof xContentCacheItems.$inferSelect;
export type NewXContentCacheItemRow = typeof xContentCacheItems.$inferInsert;
export type XContentCacheRangeRow = typeof xContentCacheRanges.$inferSelect;
export type NewXContentCacheRangeRow = typeof xContentCacheRanges.$inferInsert;
export type XContentFetchProgressRow = typeof xContentFetchProgress.$inferSelect;
export type NewXContentFetchProgressRow = typeof xContentFetchProgress.$inferInsert;
