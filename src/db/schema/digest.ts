import { bigint, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { users } from "./user.ts";

export const digestStatuses = ["pending", "complete", "failed"] as const;
export type DigestStatus = (typeof digestStatuses)[number];

export const digests = pgTable(
  "digests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    periodStartMs: bigint("period_start_ms", { mode: "number" }).notNull(),
    periodEndMs: bigint("period_end_ms", { mode: "number" }).notNull(),
    status: text("status").$type<DigestStatus>().notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    unique("digests_user_period_unique").on(table.userId, table.periodStartMs, table.periodEndMs),
  ],
);

export type DigestRow = typeof digests.$inferSelect;
export type NewDigestRow = typeof digests.$inferInsert;
