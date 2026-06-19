import { sql } from "drizzle-orm";
import { bigint, boolean, check, integer, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import type { FeedKind } from "../../connectors/connector.types.ts";
import { sources } from "./source.ts";

export const feeds = pgTable(
  "feeds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").$type<FeedKind>().notNull(),
    customPrompt: text("custom_prompt"),
    position: integer("position"),
    enabled: boolean("enabled").notNull().default(true),
    deletedAt: bigint("deleted_at", { mode: "number" }),
    lastFetchedPeriodEndMs: bigint("last_fetched_period_end_ms", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    unique("feeds_source_id_external_id_unique").on(table.sourceId, table.externalId),
    check("feeds_kind_check", sql`${table.kind} in ('news', 'discussion')`),
  ],
);

export type FeedRow = typeof feeds.$inferSelect;
export type NewFeedRow = typeof feeds.$inferInsert;
