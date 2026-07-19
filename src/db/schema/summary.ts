import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { SummaryContent } from "../../summarizers/summarizer.types.ts";
import { feeds } from "./feed.ts";

export const summaries = pgTable(
  "summaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    feedId: uuid("feed_id")
      .notNull()
      .references(() => feeds.id, { onDelete: "cascade" }),
    periodStartMs: bigint("period_start_ms", { mode: "number" }).notNull(),
    periodEndMs: bigint("period_end_ms", { mode: "number" }).notNull(),
    content: jsonb("content").$type<SummaryContent>().notNull(),
    feedNameSnapshot: text("feed_name_snapshot").notNull(),
    generatedAt: bigint("generated_at", { mode: "number" }).notNull(),
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
  ],
);

export type SummaryRow = typeof summaries.$inferSelect;
export type NewSummaryRow = typeof summaries.$inferInsert;
