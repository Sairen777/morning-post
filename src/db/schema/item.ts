import { bigint, index, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import type { NormalizedItem } from "../../connectors/connector.types.ts";
import { feeds } from "./feed.ts";

export const items = pgTable(
  "items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    feedId: uuid("feed_id")
      .notNull()
      .references(() => feeds.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    date: bigint("date", { mode: "number" }).notNull(),
    payload: jsonb("payload").$type<NormalizedItem>().notNull(),
    fetchedAt: bigint("fetched_at", { mode: "number" }).notNull(),
  },
  (table) => [
    unique("items_feed_id_external_id_unique").on(table.feedId, table.externalId),
    index("items_feed_date_external_id_idx").on(table.feedId, table.date, table.externalId),
  ],
);

export type ItemRow = typeof items.$inferSelect;
export type NewItemRow = typeof items.$inferInsert;
