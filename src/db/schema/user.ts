import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import type { RelevanceFilterMode } from "../../personalization/personalization.types.ts";

/**
 * Domain entity: a person who owns sources, feeds, and digests.
 *
 * Timestamps are epoch milliseconds stored as `bigint` (mode "number"), never
 * `timestamptz`, to honor the cross-layer epoch-ms boundary rule.
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  systemPrompt: text("system_prompt").notNull(),
  summaryPrompt: text("summary_prompt").notNull().default(""),
  defaultLanguage: text("default_language"),
  defaultRelevanceFilterMode: text("default_relevance_filter_mode")
    .$type<RelevanceFilterMode>()
    .notNull()
    .default("personalized"),
  relevanceThreshold: integer("relevance_threshold").notNull().default(60),
  maximumStoriesPerDigest: integer("maximum_stories_per_digest"),
  interestProfileVersion: integer("interest_profile_version").notNull().default(1),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => [
  index("users_created_at_id_idx").on(table.createdAt, table.id),
  check(
    "users_default_relevance_filter_mode_check",
    sql`${table.defaultRelevanceFilterMode} in ('personalized', 'include_all')`,
  ),
  check(
    "users_relevance_threshold_check",
    sql`${table.relevanceThreshold} between 0 and 100`,
  ),
  check(
    "users_maximum_stories_per_digest_check",
    sql`${table.maximumStoriesPerDigest} is null or ${table.maximumStoriesPerDigest} > 0`,
  ),
  check(
    "users_interest_profile_version_check",
    sql`${table.interestProfileVersion} > 0`,
  ),
]);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
