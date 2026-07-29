import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import type { RelevanceFilterMode } from "../../personalization/personalization.types.ts";
import type { StoryDetailLevel } from "../../story-detail-level.ts";

/**
 * Domain entity: a person who owns sources, feeds, and digests.
 *
 * Timestamps are epoch milliseconds stored as `bigint` (mode "number"), never
 * `timestamptz`, to honor the cross-layer epoch-ms boundary rule.
 */
export const users = sqliteTable("users", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  systemPrompt: text("system_prompt").notNull(),
  summaryPrompt: text("summary_prompt").notNull().default(""),
  defaultLanguage: text("default_language"),
  defaultRelevanceFilterMode: text("default_relevance_filter_mode")
    .$type<RelevanceFilterMode>()
    .notNull()
    .default("personalized"),
  storyDetailLevel: text("story_detail_level")
    .$type<StoryDetailLevel>()
    .notNull()
    .default("balanced"),
  relevanceThreshold: integer("relevance_threshold").notNull().default(60),
  maximumStoriesPerDigest: integer("maximum_stories_per_digest"),
  interestProfileVersion: integer("interest_profile_version").notNull().default(1),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
}, (table) => [
  index("users_created_at_id_idx").on(table.createdAt, table.id),
  check(
    "users_default_relevance_filter_mode_check",
    sql`${table.defaultRelevanceFilterMode} in ('personalized', 'include_all')`,
  ),
  check(
    "users_story_detail_level_check",
    sql`${table.storyDetailLevel} in ('headlines', 'balanced', 'thorough')`,
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
