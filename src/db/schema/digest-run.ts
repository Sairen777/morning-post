import { sql } from "drizzle-orm";
import { bigint, check, index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { digests } from "./digest.ts";
import { feeds } from "./feed.ts";
import { sources } from "./source.ts";
import { users } from "./user.ts";

export const digestRunTriggers = ["manual", "scheduled"] as const;
export type DigestRunTrigger = (typeof digestRunTriggers)[number];

export const digestRunStatuses = ["running", "complete", "partial", "failed"] as const;
export type DigestRunStatus = (typeof digestRunStatuses)[number];

export const digestRuns = pgTable(
  "digest_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    digestId: uuid("digest_id").references(() => digests.id, { onDelete: "set null" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    trigger: text("trigger").$type<DigestRunTrigger>().notNull(),
    periodStartMs: bigint("period_start_ms", { mode: "number" }).notNull(),
    periodEndMs: bigint("period_end_ms", { mode: "number" }).notNull(),
    status: text("status").$type<DigestRunStatus>().notNull(),
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
    finishedAt: bigint("finished_at", { mode: "number" }),
    errorMessage: text("error_message"),
  },
  (table) => [
    uniqueIndex("digest_runs_user_running_unique")
      .on(table.userId)
      .where(sql`${table.status} = 'running'`),
    index("digest_runs_user_started_idx").on(table.userId, table.startedAt.desc()),
    check("digest_runs_status_check", sql`${table.status} in ('running', 'complete', 'partial', 'failed')`),
    check("digest_runs_trigger_check", sql`${table.trigger} in ('manual', 'scheduled')`),
    check("digest_runs_period_order_check", sql`${table.periodStartMs} <= ${table.periodEndMs}`),
  ],
);

export type DigestRunRow = typeof digestRuns.$inferSelect;
export type NewDigestRunRow = typeof digestRuns.$inferInsert;

export const digestRunFeedStages = ["connector", "ingestion", "summarization"] as const;
export type DigestRunFeedStage = (typeof digestRunFeedStages)[number];

export const digestRunFeedStatuses = ["running", "complete", "skipped", "failed"] as const;
export type DigestRunFeedStatus = (typeof digestRunFeedStatuses)[number];

export const digestRunFeeds = pgTable(
  "digest_run_feeds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => digestRuns.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id").references(() => sources.id, { onDelete: "set null" }),
    feedId: uuid("feed_id").references(() => feeds.id, { onDelete: "set null" }),
    connectorId: text("connector_id").notNull(),
    feedExternalId: text("feed_external_id"),
    feedName: text("feed_name"),
    stage: text("stage").$type<DigestRunFeedStage>().notNull(),
    status: text("status").$type<DigestRunFeedStatus>().notNull(),
    itemCount: integer("item_count"),
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
    finishedAt: bigint("finished_at", { mode: "number" }),
    errorMessage: text("error_message"),
  },
  (table) => [
    index("digest_run_feeds_run_idx").on(table.runId, table.startedAt),
    check("digest_run_feeds_stage_check", sql`${table.stage} in ('connector', 'ingestion', 'summarization')`),
    check("digest_run_feeds_status_check", sql`${table.status} in ('running', 'complete', 'skipped', 'failed')`),
  ],
);

export type DigestRunFeedRow = typeof digestRunFeeds.$inferSelect;
export type NewDigestRunFeedRow = typeof digestRunFeeds.$inferInsert;
