PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_x_content_fetch_progress` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`feed_external_id` text NOT NULL,
	`start_ms` integer NOT NULL,
	`end_ms` integer NOT NULL,
	`next_cursor` text,
	`blocked_reason` text,
	`seen_cursors` text NOT NULL DEFAULT '[]',
	`page_count` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "x_content_fetch_progress_window_check" CHECK("end_ms" >= "start_ms"),
	CONSTRAINT "x_content_fetch_progress_blocked_reason_check" CHECK("blocked_reason" is null or "blocked_reason" in ('repeated_cursor', 'missing_cursor', 'mismatched_conversation'))
);
--> statement-breakpoint
INSERT INTO `__new_x_content_fetch_progress`("id", "source_id", "feed_external_id", "start_ms", "end_ms", "next_cursor", "seen_cursors", "page_count", "created_at", "updated_at") SELECT "id", "source_id", "feed_external_id", "start_ms", "end_ms", "next_cursor", CASE WHEN "next_cursor" IS NOT NULL THEN json_array("next_cursor") ELSE '[]' END, "page_count", "created_at", "updated_at" FROM `x_content_fetch_progress`;
--> statement-breakpoint
DROP TABLE `x_content_fetch_progress`;
--> statement-breakpoint
ALTER TABLE `__new_x_content_fetch_progress` RENAME TO `x_content_fetch_progress`;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint
CREATE UNIQUE INDEX `x_content_fetch_progress_source_feed_range_unique` ON `x_content_fetch_progress` (`source_id`,`feed_external_id`,`start_ms`,`end_ms`);
