CREATE TABLE `x_content_cache_items` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`feed_external_id` text NOT NULL,
	`external_id` text NOT NULL,
	`date` integer NOT NULL,
	`payload` text NOT NULL,
	`fetched_at` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `x_content_cache_items_feed_date_external_idx` ON `x_content_cache_items` (`source_id`,`feed_external_id`,`date`,`external_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `x_content_cache_items_source_feed_external_unique` ON `x_content_cache_items` (`source_id`,`feed_external_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `x_content_cache_ranges` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`feed_external_id` text NOT NULL,
	`start_ms` integer NOT NULL,
	`end_ms` integer NOT NULL,
	`fetched_at` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "x_content_cache_ranges_window_check" CHECK("x_content_cache_ranges"."end_ms" >= "x_content_cache_ranges"."start_ms")
);
--> statement-breakpoint
CREATE INDEX `x_content_cache_ranges_feed_start_end_idx` ON `x_content_cache_ranges` (`source_id`,`feed_external_id`,`start_ms`,`end_ms`);--> statement-breakpoint
CREATE UNIQUE INDEX `x_content_cache_ranges_source_feed_start_unique` ON `x_content_cache_ranges` (`source_id`,`feed_external_id`,`start_ms`);