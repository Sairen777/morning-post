ALTER TABLE "summaries" RENAME COLUMN "points" TO "content";
--> statement-breakpoint
UPDATE "summaries"
SET "content" = jsonb_build_object('kind', 'aggregate', 'points', "content");