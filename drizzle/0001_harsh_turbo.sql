ALTER TABLE `batches` ADD `contents` text DEFAULT 'İçerik bilgisi güncelleniyor' NOT NULL;--> statement-breakpoint
ALTER TABLE `batches` ADD `latitude` real;--> statement-breakpoint
ALTER TABLE `batches` ADD `longitude` real;