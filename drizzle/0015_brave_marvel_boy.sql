CREATE TABLE "interest_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"label" text NOT NULL,
	"normalized_label" text NOT NULL,
	"kind" text NOT NULL,
	"disposition" text NOT NULL,
	"origin" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"strength" integer DEFAULT 100 NOT NULL,
	"expires_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "interest_rules_user_kind_label_unique" UNIQUE("user_id","kind","normalized_label"),
	CONSTRAINT "interest_rules_kind_check" CHECK ("interest_rules"."kind" in ('topic', 'entity', 'phrase', 'story_type')),
	CONSTRAINT "interest_rules_disposition_check" CHECK ("interest_rules"."disposition" in ('prioritize', 'show_less', 'mute')),
	CONSTRAINT "interest_rules_origin_check" CHECK ("interest_rules"."origin" in ('explicit', 'inferred')),
	CONSTRAINT "interest_rules_state_check" CHECK ("interest_rules"."state" in ('active', 'dismissed')),
	CONSTRAINT "interest_rules_strength_check" CHECK ("interest_rules"."strength" between 0 and 100),
	CONSTRAINT "interest_rules_mute_origin_check" CHECK ("interest_rules"."disposition" <> 'mute' or "interest_rules"."origin" = 'explicit')
);
--> statement-breakpoint
ALTER TABLE "feeds" ADD COLUMN "relevance_filter_mode" text DEFAULT 'inherit' NOT NULL;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "relevance_filter_mode" text DEFAULT 'inherit' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "default_relevance_filter_mode" text DEFAULT 'personalized' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "relevance_threshold" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "maximum_stories_per_digest" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "interest_profile_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "interest_rules" ADD CONSTRAINT "interest_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "interest_rules_user_state_idx" ON "interest_rules" USING btree ("user_id","state");--> statement-breakpoint
ALTER TABLE "feeds" ADD CONSTRAINT "feeds_relevance_filter_mode_check" CHECK ("feeds"."relevance_filter_mode" in ('inherit', 'personalized', 'include_all'));--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_relevance_filter_mode_check" CHECK ("sources"."relevance_filter_mode" in ('inherit', 'personalized', 'include_all'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_default_relevance_filter_mode_check" CHECK ("users"."default_relevance_filter_mode" in ('personalized', 'include_all'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_relevance_threshold_check" CHECK ("users"."relevance_threshold" between 0 and 100);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_maximum_stories_per_digest_check" CHECK ("users"."maximum_stories_per_digest" is null or "users"."maximum_stories_per_digest" > 0);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_interest_profile_version_check" CHECK ("users"."interest_profile_version" > 0);