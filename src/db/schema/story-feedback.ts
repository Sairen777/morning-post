import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import { digests } from "./digest.ts";
import { stories } from "./story.ts";
import { users } from "./user.ts";

export const storyFeedbackActions = [
  "relevant",
  "not_relevant",
  "already_known",
  "too_repetitive",
  "follow_topic",
  "show_less_topic",
  "mute_topic",
] as const;
export type StoryFeedbackAction = (typeof storyFeedbackActions)[number];

export const storyFeedbackTargetKinds = ["topic", "entity"] as const;
export type StoryFeedbackTargetKind = (typeof storyFeedbackTargetKinds)[number];
export type StoredStoryFeedbackTargetKind = StoryFeedbackTargetKind | "";

export const storyFeedback = sqliteTable("story_feedback",
{
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  digestId: text("digest_id")
    .notNull()
    .references(() => digests.id, { onDelete: "cascade" }),
  digestStoryId: text("digest_story_id").notNull(),
  storyId: text("story_id")
    .notNull()
    .references(() => stories.id, { onDelete: "cascade" }),
  storyVersion: integer("story_version").notNull(),
  action: text("action").$type<StoryFeedbackAction>().notNull(),
  targetKind: text("target_kind").$type<StoredStoryFeedbackTargetKind>().notNull(),
  targetLabel: text("target_label").notNull(),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
},
(table) => [
  unique("story_feedback_identity_unique").on(
    table.userId,
    table.digestId,
    table.storyId,
    table.storyVersion,
    table.action,
    table.targetKind,
    table.targetLabel,
  ),
  index("story_feedback_user_created_idx").on(
    table.userId,
    table.createdAt,
  ),
  index("story_feedback_story_idx").on(table.storyId, table.storyVersion),
  check("story_feedback_story_version_check", sql`${table.storyVersion} > 0`),
  check(
    "story_feedback_action_check",
    sql`${table.action} in ('relevant', 'not_relevant', 'already_known', 'too_repetitive', 'follow_topic', 'show_less_topic', 'mute_topic')`,
  ),
  check(
    "story_feedback_target_kind_check",
    sql`${table.targetKind} in ('', 'topic', 'entity')`,
  ),
  check(
    "story_feedback_target_shape_check",
    sql`(
      ${table.action} in ('relevant', 'not_relevant', 'already_known', 'too_repetitive')
      and ${table.targetKind} = ''
      and ${table.targetLabel} = ''
    ) or (
      ${table.action} in ('follow_topic', 'show_less_topic', 'mute_topic')
      and ${table.targetKind} in ('topic', 'entity')
      and length(${table.targetLabel}) > 0
    )`,
  ),
],);

export type StoryFeedbackRow = typeof storyFeedback.$inferSelect;
export type NewStoryFeedbackRow = typeof storyFeedback.$inferInsert;
