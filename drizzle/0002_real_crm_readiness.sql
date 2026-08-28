ALTER TABLE `settings` ADD `prospecting_cities` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `prospecting_segments` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `prospecting_search_terms` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `max_profiles_per_run` integer DEFAULT 20;--> statement-breakpoint
ALTER TABLE `settings` ADD `max_approved_leads_per_day` integer DEFAULT 5;--> statement-breakpoint
ALTER TABLE `settings` ADD `min_action_interval_seconds` integer DEFAULT 90;--> statement-breakpoint
ALTER TABLE `settings` ADD `ignore_private_profiles` integer DEFAULT true;--> statement-breakpoint
ALTER TABLE `settings` ADD `ignore_already_analyzed` integer DEFAULT true;--> statement-breakpoint
ALTER TABLE `settings` ADD `ignore_existing_leads` integer DEFAULT true;--> statement-breakpoint
ALTER TABLE `settings` ADD `ignore_already_contacted` integer DEFAULT true;--> statement-breakpoint
ALTER TABLE `settings` ADD `ignore_duplicates` integer DEFAULT true;--> statement-breakpoint
ALTER TABLE `settings` ADD `prospection_dry_run` integer DEFAULT true;--> statement-breakpoint
ALTER TABLE `settings` ADD `auto_reply_enabled` integer DEFAULT false;--> statement-breakpoint
CREATE TABLE `worker_state` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'PAUSED' NOT NULL,
	`activity` text,
	`chrome_connected` integer DEFAULT false,
	`instagram_profile` text,
	`last_error` text,
	`paused_reason` text,
	`dry_run` integer DEFAULT true,
	`started_at` integer,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE TABLE `daily_action_counters` (
	`id` text PRIMARY KEY NOT NULL,
	`day` text NOT NULL,
	`action` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`limit` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `daily_action_counters_day_action_idx` ON `daily_action_counters` (`day`,`action`);--> statement-breakpoint
CREATE TABLE `webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text DEFAULT 'META' NOT NULL,
	`event_id` text NOT NULL,
	`lead_id` text,
	`payload_hash` text NOT NULL,
	`processed_at` integer NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_events_provider_event_idx` ON `webhook_events` (`provider`,`event_id`);
