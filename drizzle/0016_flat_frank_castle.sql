CREATE TABLE "digest_stories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"digest_id" uuid NOT NULL,
	"story_id" uuid NOT NULL,
	"story_version" integer NOT NULL,
	"profile_version" integer NOT NULL,
	"title" text NOT NULL,
	"topics" jsonb NOT NULL,
	"entities" jsonb NOT NULL,
	"points" jsonb NOT NULL,
	"sources" jsonb NOT NULL,
	"relevance_score" integer NOT NULL,
	"matched_interest_rule_ids" jsonb NOT NULL,
	"generated_at" bigint NOT NULL,
	CONSTRAINT "digest_stories_digest_story_unique" UNIQUE("digest_id","story_id"),
	CONSTRAINT "digest_stories_story_version_check" CHECK ("digest_stories"."story_version" > 0),
	CONSTRAINT "digest_stories_profile_version_check" CHECK ("digest_stories"."profile_version" > 0),
	CONSTRAINT "digest_stories_relevance_score_check" CHECK ("digest_stories"."relevance_score" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "item_analyses" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"analysis" jsonb NOT NULL,
	"analyzer_version" text NOT NULL,
	"analyzed_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"canonical_key" text NOT NULL,
	"title" text NOT NULL,
	"topics" jsonb NOT NULL,
	"entities" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"first_seen_at" bigint NOT NULL,
	"last_updated_at" bigint NOT NULL,
	CONSTRAINT "stories_user_canonical_key_unique" UNIQUE("user_id","canonical_key"),
	CONSTRAINT "stories_version_check" CHECK ("stories"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "story_developments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"story_id" uuid NOT NULL,
	"canonical_key" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"occurred_at" bigint NOT NULL,
	"first_seen_at" bigint NOT NULL,
	"last_updated_at" bigint NOT NULL,
	CONSTRAINT "story_developments_story_key_unique" UNIQUE("story_id","canonical_key"),
	CONSTRAINT "story_developments_version_check" CHECK ("story_developments"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "story_items" (
	"development_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"item_fingerprint" text NOT NULL,
	"confidence" integer NOT NULL,
	"added_at" bigint NOT NULL,
	CONSTRAINT "story_items_development_id_item_id_pk" PRIMARY KEY("development_id","item_id"),
	CONSTRAINT "story_items_item_unique" UNIQUE("item_id"),
	CONSTRAINT "story_items_confidence_check" CHECK ("story_items"."confidence" between 0 and 100)
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "summary_prompt" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "digests" ADD COLUMN "content_mode" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "digest_stories" ADD CONSTRAINT "digest_stories_digest_id_digests_id_fk" FOREIGN KEY ("digest_id") REFERENCES "public"."digests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_stories" ADD CONSTRAINT "digest_stories_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_analyses" ADD CONSTRAINT "item_analyses_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_developments" ADD CONSTRAINT "story_developments_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_items" ADD CONSTRAINT "story_items_development_id_story_developments_id_fk" FOREIGN KEY ("development_id") REFERENCES "public"."story_developments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_items" ADD CONSTRAINT "story_items_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "digest_stories_digest_idx" ON "digest_stories" USING btree ("digest_id");--> statement-breakpoint
CREATE INDEX "digest_stories_story_generated_idx" ON "digest_stories" USING btree ("story_id","generated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "stories_user_updated_idx" ON "stories" USING btree ("user_id","last_updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "story_developments_story_occurred_idx" ON "story_developments" USING btree ("story_id","occurred_at");--> statement-breakpoint
CREATE INDEX "story_items_development_idx" ON "story_items" USING btree ("development_id");--> statement-breakpoint
ALTER TABLE "digests" ADD CONSTRAINT "digests_content_mode_check" CHECK ("digests"."content_mode" in ('legacy', 'stories'));