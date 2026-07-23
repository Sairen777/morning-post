import { sql } from "drizzle-orm";
import { bigint, check, index, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { users } from "./user.ts";

export const digestStatuses = ["pending", "complete", "failed"] as const;
export type DigestStatus = (typeof digestStatuses)[number];
export const digestContentModes = ["legacy", "stories"] as const;
export type DigestContentMode = (typeof digestContentModes)[number];


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
    contentMode: text("content_mode")
      .$type<DigestContentMode>()
      .notNull()
      .default("legacy"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    unique("digests_user_period_unique").on(table.userId, table.periodStartMs, table.periodEndMs),
    index("digests_user_latest_idx").on(table.userId, table.periodEndMs.desc(), table.createdAt.desc()),
    check("digests_status_check", sql`${table.status} in ('pending', 'complete', 'failed')`),
    check(
      "digests_content_mode_check",
      sql`${table.contentMode} in ('legacy', 'stories')`,
    ),
    check("digests_period_order_check", sql`${table.periodStartMs} <= ${table.periodEndMs}`),
  ],
);

export type DigestRow = typeof digests.$inferSelect;
export type NewDigestRow = typeof digests.$inferInsert;
