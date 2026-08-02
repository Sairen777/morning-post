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

export type XContentCacheItemRow = typeof xContentCacheItems.$inferSelect;
export type NewXContentCacheItemRow = typeof xContentCacheItems.$inferInsert;
export type XContentCacheRangeRow = typeof xContentCacheRanges.$inferSelect;
export type NewXContentCacheRangeRow = typeof xContentCacheRanges.$inferInsert;
