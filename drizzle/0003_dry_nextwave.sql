CREATE TABLE "feeds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"custom_prompt" text,
	"position" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"deleted_at" bigint,
	"last_fetched_period_end_ms" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "feeds_source_id_external_id_unique" UNIQUE("source_id","external_id")
);
--> statement-breakpoint
ALTER TABLE "feeds" ADD CONSTRAINT "feeds_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;