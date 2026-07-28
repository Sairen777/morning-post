import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Durable fixed-window rate-limit counters shared by all application
 * instances. `resetsAt` is an epoch-millisecond boundary, matching the
 * rest of the persistence layer.
 */
export const rateLimitBuckets = sqliteTable("rate_limit_buckets", {
  bucketKey: text("bucket_key").primaryKey(),
  count: integer("count").notNull(),
  resetsAt: integer("resets_at", { mode: "number" }).notNull(),
});

export type RateLimitBucketRow = typeof rateLimitBuckets.$inferSelect;
export type NewRateLimitBucketRow = typeof rateLimitBuckets.$inferInsert;
