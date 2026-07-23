CREATE TABLE "story_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"digest_id" uuid NOT NULL,
	"digest_story_id" uuid NOT NULL,
	"story_id" uuid NOT NULL,
	"story_version" integer NOT NULL,
	"action" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_label" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "story_feedback_identity_unique" UNIQUE("user_id","digest_id","story_id","story_version","action","target_kind","target_label"),
	CONSTRAINT "story_feedback_story_version_check" CHECK ("story_feedback"."story_version" > 0),
	CONSTRAINT "story_feedback_action_check" CHECK ("story_feedback"."action" in ('relevant', 'not_relevant', 'already_known', 'too_repetitive', 'follow_topic', 'show_less_topic', 'mute_topic')),
	CONSTRAINT "story_feedback_target_kind_check" CHECK ("story_feedback"."target_kind" in ('', 'topic', 'entity')),
	CONSTRAINT "story_feedback_target_shape_check" CHECK ((
        "story_feedback"."action" in ('relevant', 'not_relevant', 'already_known', 'too_repetitive')
        and "story_feedback"."target_kind" = ''
        and "story_feedback"."target_label" = ''
      ) or (
        "story_feedback"."action" in ('follow_topic', 'show_less_topic', 'mute_topic')
        and "story_feedback"."target_kind" in ('topic', 'entity')
        and length("story_feedback"."target_label") > 0
      ))
);
--> statement-breakpoint
ALTER TABLE "story_feedback" ADD CONSTRAINT "story_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_feedback" ADD CONSTRAINT "story_feedback_digest_id_digests_id_fk" FOREIGN KEY ("digest_id") REFERENCES "public"."digests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_feedback" ADD CONSTRAINT "story_feedback_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "story_feedback_user_created_idx" ON "story_feedback" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "story_feedback_story_idx" ON "story_feedback" USING btree ("story_id","story_version");