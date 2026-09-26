CREATE TABLE `device_notices` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`message` text NOT NULL,
	`at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_device_notices_device` ON `device_notices` (`device_id`,`at`);--> statement-breakpoint
ALTER TABLE `batches` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `batches` ADD `cancel_reason` text;