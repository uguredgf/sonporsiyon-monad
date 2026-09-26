CREATE TABLE `provider_applications` (
	`wallet` text PRIMARY KEY NOT NULL,
	`business_name` text NOT NULL,
	`registration_number` text NOT NULL,
	`business_address` text NOT NULL,
	`official_qr` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`submitted_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_provider_applications_status` ON `provider_applications` (`status`);