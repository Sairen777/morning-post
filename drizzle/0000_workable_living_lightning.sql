CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`password_hash` text,
	`system_prompt` text NOT NULL,
	`summary_prompt` text DEFAULT '' NOT NULL,
	`default_language` text,
	`default_relevance_filter_mode` text DEFAULT 'personalized' NOT NULL,
	`relevance_threshold` integer DEFAULT 60 NOT NULL,
	`maximum_stories_per_digest` integer,
	`interest_profile_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "users_default_relevance_filter_mode_check" CHECK("users"."default_relevance_filter_mode" in ('personalized', 'include_all')),
	CONSTRAINT "users_relevance_threshold_check" CHECK("users"."relevance_threshold" between 0 and 100),
	CONSTRAINT "users_maximum_stories_per_digest_check" CHECK("users"."maximum_stories_per_digest" is null or "users"."maximum_stories_per_digest" > 0),
	CONSTRAINT "users_interest_profile_version_check" CHECK("users"."interest_profile_version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `users_created_at_id_idx` ON `users` (`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `interest_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`label` text NOT NULL,
	`normalized_label` text NOT NULL,
	`kind` text NOT NULL,
	`disposition` text NOT NULL,
	`origin` text NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`strength` integer DEFAULT 100 NOT NULL,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "interest_rules_kind_check" CHECK("interest_rules"."kind" in ('topic', 'entity', 'phrase', 'story_type')),
	CONSTRAINT "interest_rules_disposition_check" CHECK("interest_rules"."disposition" in ('prioritize', 'show_less', 'mute')),
	CONSTRAINT "interest_rules_origin_check" CHECK("interest_rules"."origin" in ('explicit', 'inferred')),
	CONSTRAINT "interest_rules_state_check" CHECK("interest_rules"."state" in ('active', 'dismissed')),
	CONSTRAINT "interest_rules_strength_check" CHECK("interest_rules"."strength" between 0 and 100),
	CONSTRAINT "interest_rules_mute_origin_check" CHECK("interest_rules"."disposition" <> 'mute' or "interest_rules"."origin" = 'explicit')
);
--> statement-breakpoint
CREATE INDEX `interest_rules_user_state_idx` ON `interest_rules` (`user_id`,`state`);--> statement-breakpoint
CREATE UNIQUE INDEX `interest_rules_user_kind_label_unique` ON `interest_rules` (`user_id`,`kind`,`normalized_label`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`connector_id` text NOT NULL,
	`credentials` text,
	`position` integer,
	`enabled` integer DEFAULT true NOT NULL,
	`show_paid_post_titles` integer DEFAULT false NOT NULL,
	`relevance_filter_mode` text DEFAULT 'inherit' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "sources_connector_id_check" CHECK("sources"."connector_id" in ('Telegram', 'Substack', 'YouTube', 'Reddit', 'X', 'RSS')),
	CONSTRAINT "sources_credentials_disabled_check" CHECK("sources"."credentials" is not null or "sources"."enabled" = false),
	CONSTRAINT "sources_relevance_filter_mode_check" CHECK("sources"."relevance_filter_mode" in ('inherit', 'personalized', 'include_all'))
);
--> statement-breakpoint
CREATE INDEX `sources_user_id_idx` ON `sources` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sources_user_id_connector_id_unique` ON `sources` (`user_id`,`connector_id`);--> statement-breakpoint
CREATE TABLE `feeds` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`custom_prompt` text,
	`position` integer,
	`enabled` integer DEFAULT true NOT NULL,
	`summarization_mode` text DEFAULT 'basic' NOT NULL,
	`relevance_filter_mode` text DEFAULT 'inherit' NOT NULL,
	`deleted_at` integer,
	`last_fetched_period_end_ms` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "feeds_kind_check" CHECK("feeds"."kind" in ('news', 'discussion')),
	CONSTRAINT "feeds_summarization_mode_check" CHECK("feeds"."summarization_mode" in ('basic', 'thorough')),
	CONSTRAINT "feeds_relevance_filter_mode_check" CHECK("feeds"."relevance_filter_mode" in ('inherit', 'personalized', 'include_all'))
);
--> statement-breakpoint
CREATE INDEX `feeds_source_id_idx` ON `feeds` (`source_id`);--> statement-breakpoint
CREATE INDEX `feeds_source_order_idx` ON `feeds` (`source_id`,`position`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `feeds_source_id_external_id_unique` ON `feeds` (`source_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`feed_id` text NOT NULL,
	`external_id` text NOT NULL,
	`date` integer NOT NULL,
	`payload` text NOT NULL,
	`fetched_at` integer NOT NULL,
	FOREIGN KEY (`feed_id`) REFERENCES `feeds`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `items_feed_date_external_id_idx` ON `items` (`feed_id`,`date`,`external_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `items_feed_id_external_id_unique` ON `items` (`feed_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `summaries` (
	`id` text PRIMARY KEY NOT NULL,
	`feed_id` text NOT NULL,
	`period_start_ms` integer NOT NULL,
	`period_end_ms` integer NOT NULL,
	`content` text NOT NULL,
	`feed_name_snapshot` text NOT NULL,
	`generated_at` integer NOT NULL,
	FOREIGN KEY (`feed_id`) REFERENCES `feeds`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "summaries_period_order_check" CHECK("summaries"."period_start_ms" <= "summaries"."period_end_ms")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `summaries_feed_id_period_unique` ON `summaries` (`feed_id`,`period_start_ms`,`period_end_ms`);--> statement-breakpoint
CREATE TABLE `digests` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`period_start_ms` integer NOT NULL,
	`period_end_ms` integer NOT NULL,
	`status` text NOT NULL,
	`content_mode` text DEFAULT 'legacy' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "digests_status_check" CHECK("digests"."status" in ('pending', 'complete', 'failed')),
	CONSTRAINT "digests_content_mode_check" CHECK("digests"."content_mode" in ('legacy', 'stories')),
	CONSTRAINT "digests_period_order_check" CHECK("digests"."period_start_ms" <= "digests"."period_end_ms")
);
--> statement-breakpoint
CREATE INDEX `digests_user_latest_idx` ON `digests` (`user_id`,`period_end_ms`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `digests_user_period_unique` ON `digests` (`user_id`,`period_start_ms`,`period_end_ms`);--> statement-breakpoint
CREATE TABLE `digest_stories` (
	`id` text PRIMARY KEY NOT NULL,
	`digest_id` text NOT NULL,
	`story_id` text NOT NULL,
	`story_version` integer NOT NULL,
	`profile_version` integer NOT NULL,
	`summary_version` text DEFAULT 'legacy' NOT NULL,
	`title` text NOT NULL,
	`topics` text NOT NULL,
	`entities` text NOT NULL,
	`points` text NOT NULL,
	`sources` text NOT NULL,
	`relevance_score` integer NOT NULL,
	`matched_interest_rule_ids` text NOT NULL,
	`generated_at` integer NOT NULL,
	FOREIGN KEY (`digest_id`) REFERENCES `digests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`story_id`) REFERENCES `stories`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "digest_stories_story_version_check" CHECK("digest_stories"."story_version" > 0),
	CONSTRAINT "digest_stories_profile_version_check" CHECK("digest_stories"."profile_version" > 0),
	CONSTRAINT "digest_stories_relevance_score_check" CHECK("digest_stories"."relevance_score" between 0 and 100)
);
--> statement-breakpoint
CREATE INDEX `digest_stories_digest_idx` ON `digest_stories` (`digest_id`);--> statement-breakpoint
CREATE INDEX `digest_stories_story_generated_idx` ON `digest_stories` (`story_id`,`generated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `digest_stories_digest_story_unique` ON `digest_stories` (`digest_id`,`story_id`);--> statement-breakpoint
CREATE TABLE `item_analyses` (
	`item_id` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`analysis` text NOT NULL,
	`analyzer_version` text NOT NULL,
	`analyzed_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `stories` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`canonical_key` text NOT NULL,
	`title` text NOT NULL,
	`topics` text NOT NULL,
	`entities` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "stories_version_check" CHECK("stories"."version" > 0)
);
--> statement-breakpoint
CREATE INDEX `stories_user_updated_idx` ON `stories` (`user_id`,`last_updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `stories_user_canonical_key_unique` ON `stories` (`user_id`,`canonical_key`);--> statement-breakpoint
CREATE TABLE `story_developments` (
	`id` text PRIMARY KEY NOT NULL,
	`story_id` text NOT NULL,
	`canonical_key` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`occurred_at` integer NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_updated_at` integer NOT NULL,
	FOREIGN KEY (`story_id`) REFERENCES `stories`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "story_developments_version_check" CHECK("story_developments"."version" > 0)
);
--> statement-breakpoint
CREATE INDEX `story_developments_story_occurred_idx` ON `story_developments` (`story_id`,`occurred_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `story_developments_story_key_unique` ON `story_developments` (`story_id`,`canonical_key`);--> statement-breakpoint
CREATE TABLE `story_items` (
	`development_id` text NOT NULL,
	`item_id` text NOT NULL,
	`item_fingerprint` text NOT NULL,
	`confidence` integer NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`development_id`, `item_id`),
	FOREIGN KEY (`development_id`) REFERENCES `story_developments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "story_items_confidence_check" CHECK("story_items"."confidence" between 0 and 100)
);
--> statement-breakpoint
CREATE INDEX `story_items_development_idx` ON `story_items` (`development_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `story_items_item_unique` ON `story_items` (`item_id`);--> statement-breakpoint
CREATE TABLE `story_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`digest_id` text NOT NULL,
	`digest_story_id` text NOT NULL,
	`story_id` text NOT NULL,
	`story_version` integer NOT NULL,
	`action` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_label` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`digest_id`) REFERENCES `digests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`story_id`) REFERENCES `stories`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "story_feedback_story_version_check" CHECK("story_feedback"."story_version" > 0),
	CONSTRAINT "story_feedback_action_check" CHECK("story_feedback"."action" in ('relevant', 'not_relevant', 'already_known', 'too_repetitive', 'follow_topic', 'show_less_topic', 'mute_topic')),
	CONSTRAINT "story_feedback_target_kind_check" CHECK("story_feedback"."target_kind" in ('', 'topic', 'entity')),
	CONSTRAINT "story_feedback_target_shape_check" CHECK((
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
CREATE INDEX `story_feedback_user_created_idx` ON `story_feedback` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `story_feedback_story_idx` ON `story_feedback` (`story_id`,`story_version`);--> statement-breakpoint
CREATE UNIQUE INDEX `story_feedback_identity_unique` ON `story_feedback` (`user_id`,`digest_id`,`story_id`,`story_version`,`action`,`target_kind`,`target_label`);--> statement-breakpoint
CREATE TABLE `digest_run_feeds` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`source_id` text,
	`feed_id` text,
	`connector_id` text NOT NULL,
	`feed_external_id` text,
	`feed_name` text,
	`stage` text NOT NULL,
	`status` text NOT NULL,
	`item_count` integer,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`error_message` text,
	FOREIGN KEY (`run_id`) REFERENCES `digest_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`feed_id`) REFERENCES `feeds`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "digest_run_feeds_stage_check" CHECK("digest_run_feeds"."stage" in ('connector', 'ingestion', 'summarization')),
	CONSTRAINT "digest_run_feeds_status_check" CHECK("digest_run_feeds"."status" in ('running', 'complete', 'skipped', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `digest_run_feeds_run_idx` ON `digest_run_feeds` (`run_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `digest_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`digest_id` text,
	`user_id` text NOT NULL,
	`trigger` text NOT NULL,
	`period_start_ms` integer NOT NULL,
	`period_end_ms` integer NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`error_message` text,
	`model_usage` text,
	FOREIGN KEY (`digest_id`) REFERENCES `digests`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "digest_runs_status_check" CHECK("digest_runs"."status" in ('running', 'complete', 'partial', 'failed')),
	CONSTRAINT "digest_runs_trigger_check" CHECK("digest_runs"."trigger" in ('manual', 'scheduled')),
	CONSTRAINT "digest_runs_period_order_check" CHECK("digest_runs"."period_start_ms" <= "digest_runs"."period_end_ms")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `digest_runs_user_running_unique` ON `digest_runs` (`user_id`) WHERE "digest_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX `digest_runs_user_started_idx` ON `digest_runs` (`user_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `rate_limit_buckets` (
	`bucket_key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`resets_at` integer NOT NULL
);
