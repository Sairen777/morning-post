import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import type { FeedKind } from "../../connectors/connector.types.ts";
import type { RelevanceFilterOverride } from "../../personalization/personalization.types.ts";
import type { SummarizationMode } from "../../summarization-mode.ts";
import { sources } from "./source.ts";

export const feeds = sqliteTable("feeds",
{
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  sourceId: text("source_id")
    .notNull()
    .references(() => sources.id, { onDelete: "cascade" }),
  externalId: text("external_id").notNull(),
  name: text("name").notNull(),
  kind: text("kind").$type<FeedKind>().notNull(),
  customPrompt: text("custom_prompt"),
  position: integer("position"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  summarizationMode: text("summarization_mode")
    .$type<SummarizationMode>()
    .notNull()
    .default("basic"),
  relevanceFilterMode: text("relevance_filter_mode")
    .$type<RelevanceFilterOverride>()
    .notNull()
    .default("inherit"),
  deletedAt: integer("deleted_at", { mode: "number" }),
  lastFetchedPeriodEndMs: integer("last_fetched_period_end_ms", { mode: "number" }),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
},
(table) => [
  unique("feeds_source_id_external_id_unique").on(table.sourceId, table.externalId),
  index("feeds_source_id_idx").on(table.sourceId),
  index("feeds_source_order_idx").on(table.sourceId, table.position, table.name),
  check("feeds_kind_check", sql`${table.kind} in ('news', 'discussion')`),
  check(
    "feeds_summarization_mode_check",
    sql`${table.summarizationMode} in ('basic', 'thorough')`,
  ),
  check(
    "feeds_relevance_filter_mode_check",
    sql`${table.relevanceFilterMode} in ('inherit', 'personalized', 'include_all')`,
  ),
],);

export type FeedRow = typeof feeds.$inferSelect;
export type NewFeedRow = typeof feeds.$inferInsert;
