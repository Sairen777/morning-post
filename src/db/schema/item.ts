import { index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import type { NormalizedItem } from "../../connectors/connector.types.ts";
import { feeds } from "./feed.ts";

export const items = sqliteTable("items",
{
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  feedId: text("feed_id")
    .notNull()
    .references(() => feeds.id, { onDelete: "cascade" }),
  externalId: text("external_id").notNull(),
  date: integer("date", { mode: "number" }).notNull(),
  payload: text("payload", { mode: "json" }).$type<NormalizedItem>().notNull(),
  fetchedAt: integer("fetched_at", { mode: "number" }).notNull(),
},
(table) => [
  unique("items_feed_id_external_id_unique").on(table.feedId, table.externalId),
  index("items_feed_date_external_id_idx").on(table.feedId, table.date, table.externalId),
],);

export type ItemRow = typeof items.$inferSelect;
export type NewItemRow = typeof items.$inferInsert;
