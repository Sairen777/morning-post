import { sql } from "drizzle-orm";
import {
  check,
  integer,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import type { SummaryContent } from "../../summarizers/summarizer.types.ts";
import { feeds } from "./feed.ts";

export const summaries = sqliteTable("summaries",
{
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  feedId: text("feed_id")
    .notNull()
    .references(() => feeds.id, { onDelete: "cascade" }),
  periodStartMs: integer("period_start_ms", { mode: "number" }).notNull(),
  periodEndMs: integer("period_end_ms", { mode: "number" }).notNull(),
  content: text("content", { mode: "json" }).$type<SummaryContent>().notNull(),
  feedNameSnapshot: text("feed_name_snapshot").notNull(),
  generatedAt: integer("generated_at", { mode: "number" }).notNull(),
},
(table) => [
  unique("summaries_feed_id_period_unique").on(
    table.feedId,
    table.periodStartMs,
    table.periodEndMs,
  ),
  check(
    "summaries_period_order_check",
    sql`${table.periodStartMs} <= ${table.periodEndMs}`,
  ),
],);

export type SummaryRow = typeof summaries.$inferSelect;
export type NewSummaryRow = typeof summaries.$inferInsert;
