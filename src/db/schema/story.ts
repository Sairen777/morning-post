import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import type {
  ItemAnalysisContent,
  StorySource,
} from "../../personalization/story.types.ts";
import type { SummaryPoint } from "../../summarizers/summarizer.types.ts";
import { digests } from "./digest.ts";
import { items } from "./item.ts";
import { users } from "./user.ts";

export const itemAnalyses = sqliteTable("item_analyses", {
  itemId: text("item_id")
    .primaryKey()
    .references(() => items.id, { onDelete: "cascade" }),
  fingerprint: text("fingerprint").notNull(),
  analysis: text("analysis", { mode: "json" }).$type<ItemAnalysisContent>().notNull(),
  analyzerVersion: text("analyzer_version").notNull(),
  analyzedAt: integer("analyzed_at", { mode: "number" }).notNull(),
});

export const stories = sqliteTable("stories",
{
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  canonicalKey: text("canonical_key").notNull(),
  title: text("title").notNull(),
  topics: text("topics", { mode: "json" }).$type<string[]>().notNull(),
  entities: text("entities", { mode: "json" }).$type<string[]>().notNull(),
  version: integer("version").notNull().default(1),
  firstSeenAt: integer("first_seen_at", { mode: "number" }).notNull(),
  lastUpdatedAt: integer("last_updated_at", { mode: "number" }).notNull(),
},
(table) => [
  unique("stories_user_canonical_key_unique").on(
    table.userId,
    table.canonicalKey,
  ),
  index("stories_user_updated_idx").on(
    table.userId,
    table.lastUpdatedAt,
  ),
  check("stories_version_check", sql`${table.version} > 0`),
],);
export const storyDevelopments = sqliteTable("story_developments",
{
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  storyId: text("story_id")
    .notNull()
    .references(() => stories.id, { onDelete: "cascade" }),
  canonicalKey: text("canonical_key").notNull(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  version: integer("version").notNull().default(1),
  occurredAt: integer("occurred_at", { mode: "number" }).notNull(),
  firstSeenAt: integer("first_seen_at", { mode: "number" }).notNull(),
  lastUpdatedAt: integer("last_updated_at", { mode: "number" }).notNull(),
},
(table) => [
  unique("story_developments_story_key_unique").on(
    table.storyId,
    table.canonicalKey,
  ),
  index("story_developments_story_occurred_idx").on(
    table.storyId,
    table.occurredAt,
  ),
  check("story_developments_version_check", sql`${table.version} > 0`),
],);


export const storyItems = sqliteTable("story_items",
{
  developmentId: text("development_id")
    .notNull()
    .references(() => storyDevelopments.id, { onDelete: "cascade" }),
  itemId: text("item_id")
    .notNull()
    .references(() => items.id, { onDelete: "cascade" }),
  itemFingerprint: text("item_fingerprint").notNull(),
  confidence: integer("confidence").notNull(),
  addedAt: integer("added_at", { mode: "number" }).notNull(),
},
(table) => [
  primaryKey({ columns: [table.developmentId, table.itemId] }),
  unique("story_items_item_unique").on(table.itemId),
  index("story_items_development_idx").on(table.developmentId),
  check(
    "story_items_confidence_check",
    sql`${table.confidence} between 0 and 100`,
  ),
],);

export const digestStories = sqliteTable("digest_stories",
{
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  digestId: text("digest_id")
    .notNull()
    .references(() => digests.id, { onDelete: "cascade" }),
  storyId: text("story_id")
    .notNull()
    .references(() => stories.id, { onDelete: "cascade" }),
  storyVersion: integer("story_version").notNull(),
  profileVersion: integer("profile_version").notNull(),
  summaryVersion: text("summary_version").notNull().default("legacy"),
  title: text("title").notNull(),
  topics: text("topics", { mode: "json" }).$type<string[]>().notNull(),
  entities: text("entities", { mode: "json" }).$type<string[]>().notNull(),
  points: text("points", { mode: "json" }).$type<SummaryPoint[]>().notNull(),
  sources: text("sources", { mode: "json" }).$type<StorySource[]>().notNull(),
  relevanceScore: integer("relevance_score").notNull(),
  matchedInterestRuleIds: text("matched_interest_rule_ids", { mode: "json" })
    .$type<string[]>()
    .notNull(),
  generatedAt: integer("generated_at", { mode: "number" }).notNull(),
},
(table) => [
  unique("digest_stories_digest_story_unique").on(
    table.digestId,
    table.storyId,
  ),
  index("digest_stories_digest_idx").on(table.digestId),
  index("digest_stories_story_generated_idx").on(
    table.storyId,
    table.generatedAt,
  ),
  check("digest_stories_story_version_check", sql`${table.storyVersion} > 0`),
  check("digest_stories_profile_version_check", sql`${table.profileVersion} > 0`),
  check(
    "digest_stories_relevance_score_check",
    sql`${table.relevanceScore} between 0 and 100`,
  ),
],);

export type ItemAnalysisRow = typeof itemAnalyses.$inferSelect;
export type NewItemAnalysisRow = typeof itemAnalyses.$inferInsert;
export type StoryRow = typeof stories.$inferSelect;
export type NewStoryRow = typeof stories.$inferInsert;
export type StoryDevelopmentRow = typeof storyDevelopments.$inferSelect;
export type NewStoryDevelopmentRow = typeof storyDevelopments.$inferInsert;
export type StoryItemRow = typeof storyItems.$inferSelect;
export type NewStoryItemRow = typeof storyItems.$inferInsert;
export type DigestStoryRow = typeof digestStories.$inferSelect;
export type NewDigestStoryRow = typeof digestStories.$inferInsert;
