CREATE TABLE `batches` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`provider` text NOT NULL,
	`title` text NOT NULL,
	`deadline` text NOT NULL,
	`deadline_at` integer NOT NULL,
	`prepared_at` text NOT NULL,
	`storage` text NOT NULL,
	`allergens` text NOT NULL,
	`address` text NOT NULL,
	`published_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_batches_deadline` ON `batches` (`deadline_at`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`text` text NOT NULL,
	`ref` text NOT NULL,
	`at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_events_at` ON `events` (`at`);--> statement-breakpoint
CREATE TABLE `portions` (
	`batch_id` text NOT NULL,
	`slot_index` integer NOT NULL,
	`state` text DEFAULT 'available' NOT NULL,
	`owner_id` text,
	`code` text,
	`claim_expires_at` integer,
	PRIMARY KEY(`batch_id`, `slot_index`),
	FOREIGN KEY (`batch_id`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_portions_batch_state` ON `portions` (`batch_id`,`state`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_portions_one_active_claim` ON `portions` (`batch_id`,`owner_id`) WHERE "portions"."state" = 'claimed' AND "portions"."owner_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_portions_active_code` ON `portions` (`code`) WHERE "portions"."state" = 'claimed' AND "portions"."code" IS NOT NULL;