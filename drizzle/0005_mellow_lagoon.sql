CREATE TABLE `x_content_fetch_progress` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`feed_external_id` text NOT NULL,
	`start_ms` integer NOT NULL,
	`end_ms` integer NOT NULL,
	`next_cursor` text,
	`page_count` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "x_content_fetch_progress_window_check" CHECK("x_content_fetch_progress"."end_ms" >= "x_content_fetch_progress"."start_ms")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `x_content_fetch_progress_source_feed_range_unique` ON `x_content_fetch_progress` (`source_id`,`feed_external_id`,`start_ms`,`end_ms`);
