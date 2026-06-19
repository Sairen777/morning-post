CREATE INDEX "digests_user_latest_idx" ON "digests" USING btree ("user_id","period_end_ms" DESC NULLS LAST,"created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "items_feed_date_external_id_idx" ON "items" USING btree ("feed_id","date","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_unique" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "users_created_at_id_idx" ON "users" USING btree ("created_at","id");--> statement-breakpoint
ALTER TABLE "digests" ADD CONSTRAINT "digests_status_check" CHECK ("digests"."status" in ('pending', 'complete', 'failed'));--> statement-breakpoint
ALTER TABLE "digests" ADD CONSTRAINT "digests_period_order_check" CHECK ("digests"."period_start_ms" <= "digests"."period_end_ms");--> statement-breakpoint
ALTER TABLE "feeds" ADD CONSTRAINT "feeds_kind_check" CHECK ("feeds"."kind" in ('news', 'discussion'));--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_credentials_disabled_check" CHECK ("sources"."credentials" is not null or "sources"."enabled" = false);--> statement-breakpoint
ALTER TABLE "summaries" ADD CONSTRAINT "summaries_period_order_check" CHECK ("summaries"."period_start_ms" <= "summaries"."period_end_ms");