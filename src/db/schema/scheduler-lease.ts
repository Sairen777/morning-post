import { bigint, pgTable, text } from "drizzle-orm/pg-core";

/**
 * PostgreSQL-backed leader leases used to elect one scheduler callback across
 * application instances. `expiresAt` is an epoch-millisecond boundary.
 */
export const schedulerLeases = pgTable("scheduler_leases", {
  name: text("name").primaryKey(),
  ownerId: text("owner_id").notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
});

export type SchedulerLeaseRow = typeof schedulerLeases.$inferSelect;
export type NewSchedulerLeaseRow = typeof schedulerLeases.$inferInsert;
