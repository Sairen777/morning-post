CREATE TABLE `x_discovered_feeds` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`credential_revision` integer NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "x_discovered_feeds_kind_check" CHECK("x_discovered_feeds"."kind" in ('news', 'discussion'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `x_discovered_feeds_source_revision_external_unique` ON `x_discovered_feeds` (`source_id`,`credential_revision`,`external_id`);
