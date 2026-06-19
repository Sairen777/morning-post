CREATE TABLE "summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feed_id" uuid NOT NULL,
	"period_start_ms" bigint NOT NULL,
	"period_end_ms" bigint NOT NULL,
	"points" jsonb NOT NULL,
	"feed_name_snapshot" text NOT NULL,
	"generated_at" bigint NOT NULL,
	CONSTRAINT "summaries_feed_id_period_unique" UNIQUE("feed_id","period_start_ms","period_end_ms")
);
--> statement-breakpoint
ALTER TABLE "summaries" ADD CONSTRAINT "summaries_feed_id_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."feeds"("id") ON DELETE cascade ON UPDATE no action;