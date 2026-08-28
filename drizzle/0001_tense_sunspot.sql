ALTER TABLE `settings` ADD `ai_analysis_model` text DEFAULT 'gpt-4o-mini';--> statement-breakpoint
ALTER TABLE `settings` ADD `ai_message_model` text DEFAULT 'gpt-4o-mini';--> statement-breakpoint
ALTER TABLE `settings` ADD `daily_queue_size` integer DEFAULT 10;--> statement-breakpoint
ALTER TABLE `settings` ADD `min_score_for_queue` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `settings` ADD `follow_up_days` integer DEFAULT 3;--> statement-breakpoint
ALTER TABLE `settings` ADD `max_follow_ups` integer DEFAULT 2;--> statement-breakpoint
ALTER TABLE `settings` ADD `operational_mode` text DEFAULT 'ASSISTIDO';