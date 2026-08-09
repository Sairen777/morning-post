UPDATE `feeds`
SET
  `enabled` = 0,
  `deleted_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  `updated_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE
  `source_id` IN (
    SELECT `id`
    FROM `sources`
    WHERE `connector_id` = 'X'
  )
  AND `deleted_at` IS NULL;--> statement-breakpoint
UPDATE `sources`
SET
  `credentials` = NULL,
  `enabled` = 0,
  `updated_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE `connector_id` = 'X';--> statement-breakpoint
DROP TABLE `x_content_cache_items`;--> statement-breakpoint
DROP TABLE `x_content_cache_ranges`;--> statement-breakpoint
DROP TABLE `x_content_fetch_progress`;--> statement-breakpoint
DROP TABLE `x_discovered_feeds`;--> statement-breakpoint
ALTER TABLE `sources` DROP COLUMN `credential_revision`;