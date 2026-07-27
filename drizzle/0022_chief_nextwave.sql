ALTER TABLE "feeds" ADD COLUMN "summarization_mode" text DEFAULT 'basic' NOT NULL;--> statement-breakpoint
ALTER TABLE "feeds" ADD CONSTRAINT "feeds_summarization_mode_check" CHECK ("feeds"."summarization_mode" in ('basic', 'thorough'));--> statement-breakpoint
UPDATE "feeds" SET "summarization_mode" = "sources"."summarization_mode" FROM "sources" WHERE "feeds"."source_id" = "sources"."id";--> statement-breakpoint
ALTER TABLE "sources" DROP CONSTRAINT "sources_summarization_mode_check";--> statement-breakpoint
ALTER TABLE "sources" DROP COLUMN "summarization_mode";