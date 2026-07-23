import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  ItemAnalysisContent,
  StorySource,
} from "../../personalization/story.types.ts";
import type { SummaryPoint } from "../../summarizers/summarizer.types.ts";
import { digests } from "./digest.ts";
import { items } from "./item.ts";
import { users } from "./user.ts";

export const itemAnalyses = pgTable("item_analyses", {
  itemId: uuid("item_id")
    .primaryKey()
    .references(() => items.id, { onDelete: "cascade" }),
  fingerprint: text("fingerprint").notNull(),
  analysis: jsonb("analysis").$type<ItemAnalysisContent>().notNull(),
  analyzerVersion: text("analyzer_version").notNull(),
  analyzedAt: bigint("analyzed_at", { mode: "number" }).notNull(),
});

export const stories = pgTable(
  "stories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    canonicalKey: text("canonical_key").notNull(),
    title: text("title").notNull(),
    topics: jsonb("topics").$type<string[]>().notNull(),
    entities: jsonb("entities").$type<string[]>().notNull(),
    version: integer("version").notNull().default(1),
    firstSeenAt: bigint("first_seen_at", { mode: "number" }).notNull(),
    lastUpdatedAt: bigint("last_updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    unique("stories_user_canonical_key_unique").on(
      table.userId,
      table.canonicalKey,
    ),
    index("stories_user_updated_idx").on(
      table.userId,
      table.lastUpdatedAt.desc(),
    ),
    check("stories_version_check", sql`${table.version} > 0`),
  ],
);
export const storyDevelopments = pgTable(
  "story_developments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storyId: uuid("story_id")
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    canonicalKey: text("canonical_key").notNull(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    version: integer("version").notNull().default(1),
    occurredAt: bigint("occurred_at", { mode: "number" }).notNull(),
    firstSeenAt: bigint("first_seen_at", { mode: "number" }).notNull(),
    lastUpdatedAt: bigint("last_updated_at", { mode: "number" }).notNull(),
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
  ],
);


export const storyItems = pgTable(
  "story_items",
  {
    developmentId: uuid("development_id")
      .notNull()
      .references(() => storyDevelopments.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    itemFingerprint: text("item_fingerprint").notNull(),
    confidence: integer("confidence").notNull(),
    addedAt: bigint("added_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.developmentId, table.itemId] }),
    unique("story_items_item_unique").on(table.itemId),
    index("story_items_development_idx").on(table.developmentId),
    check(
      "story_items_confidence_check",
      sql`${table.confidence} between 0 and 100`,
    ),
  ],
);

export const digestStories = pgTable(
  "digest_stories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    digestId: uuid("digest_id")
      .notNull()
      .references(() => digests.id, { onDelete: "cascade" }),
    storyId: uuid("story_id")
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    storyVersion: integer("story_version").notNull(),
    profileVersion: integer("profile_version").notNull(),
    title: text("title").notNull(),
    topics: jsonb("topics").$type<string[]>().notNull(),
    entities: jsonb("entities").$type<string[]>().notNull(),
    points: jsonb("points").$type<SummaryPoint[]>().notNull(),
    sources: jsonb("sources").$type<StorySource[]>().notNull(),
    relevanceScore: integer("relevance_score").notNull(),
    matchedInterestRuleIds: jsonb("matched_interest_rule_ids")
      .$type<string[]>()
      .notNull(),
    generatedAt: bigint("generated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    unique("digest_stories_digest_story_unique").on(
      table.digestId,
      table.storyId,
    ),
    index("digest_stories_digest_idx").on(table.digestId),
    index("digest_stories_story_generated_idx").on(
      table.storyId,
      table.generatedAt.desc(),
    ),
    check("digest_stories_story_version_check", sql`${table.storyVersion} > 0`),
    check("digest_stories_profile_version_check", sql`${table.profileVersion} > 0`),
    check(
      "digest_stories_relevance_score_check",
      sql`${table.relevanceScore} between 0 and 100`,
    ),
  ],
);

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
