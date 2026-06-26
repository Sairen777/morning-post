CREATE TABLE "digest_run_feeds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"source_id" uuid,
	"feed_id" uuid,
	"connector_id" text NOT NULL,
	"feed_external_id" text,
	"feed_name" text,
	"stage" text NOT NULL,
	"status" text NOT NULL,
	"item_count" integer,
	"started_at" bigint NOT NULL,
	"finished_at" bigint,
	"error_message" text,
	CONSTRAINT "digest_run_feeds_stage_check" CHECK ("digest_run_feeds"."stage" in ('connector', 'ingestion', 'summarization')),
	CONSTRAINT "digest_run_feeds_status_check" CHECK ("digest_run_feeds"."status" in ('running', 'complete', 'skipped', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "digest_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"digest_id" uuid,
	"user_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"period_start_ms" bigint NOT NULL,
	"period_end_ms" bigint NOT NULL,
	"status" text NOT NULL,
	"started_at" bigint NOT NULL,
	"finished_at" bigint,
	"error_message" text,
	CONSTRAINT "digest_runs_status_check" CHECK ("digest_runs"."status" in ('running', 'complete', 'partial', 'failed')),
	CONSTRAINT "digest_runs_trigger_check" CHECK ("digest_runs"."trigger" in ('manual', 'scheduled')),
	CONSTRAINT "digest_runs_period_order_check" CHECK ("digest_runs"."period_start_ms" <= "digest_runs"."period_end_ms")
);
--> statement-breakpoint
ALTER TABLE "digest_run_feeds" ADD CONSTRAINT "digest_run_feeds_run_id_digest_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."digest_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_run_feeds" ADD CONSTRAINT "digest_run_feeds_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_run_feeds" ADD CONSTRAINT "digest_run_feeds_feed_id_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."feeds"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_runs" ADD CONSTRAINT "digest_runs_digest_id_digests_id_fk" FOREIGN KEY ("digest_id") REFERENCES "public"."digests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_runs" ADD CONSTRAINT "digest_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "digest_run_feeds_run_idx" ON "digest_run_feeds" USING btree ("run_id","started_at");--> statement-breakpoint
CREATE INDEX "digest_runs_user_started_idx" ON "digest_runs" USING btree ("user_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "feeds_source_id_idx" ON "feeds" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "feeds_source_order_idx" ON "feeds" USING btree ("source_id","position","name");--> statement-breakpoint
CREATE INDEX "sources_user_id_idx" ON "sources" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_connector_id_check" CHECK ("sources"."connector_id" in ('Telegram', 'Substack', 'YouTube', 'Reddit', 'X', 'RSS'));