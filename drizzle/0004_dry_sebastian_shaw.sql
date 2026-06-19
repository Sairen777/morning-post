CREATE TABLE "items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feed_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"date" bigint NOT NULL,
	"payload" jsonb NOT NULL,
	"fetched_at" bigint NOT NULL,
	CONSTRAINT "items_feed_id_external_id_unique" UNIQUE("feed_id","external_id")
);
--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_feed_id_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."feeds"("id") ON DELETE cascade ON UPDATE no action;