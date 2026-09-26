DROP INDEX `idx_portions_one_active_claim`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_portions_one_active_claim` ON `portions` (`owner_id`) WHERE "portions"."state" = 'claimed' AND "portions"."owner_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `batches` ADD `claim_ttl_seconds` integer DEFAULT 1800 NOT NULL;