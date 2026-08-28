CREATE TABLE `activities` (
	`id` text PRIMARY KEY NOT NULL,
	`lead_id` text NOT NULL,
	`type` text NOT NULL,
	`channel` text,
	`direction` text,
	`content` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `demos` (
	`id` text PRIMARY KEY NOT NULL,
	`lead_id` text NOT NULL,
	`scheduled_at` integer NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'AGENDADA' NOT NULL,
	`notes` text,
	`result` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `leads` (
	`id` text PRIMARY KEY NOT NULL,
	`business_name` text NOT NULL,
	`instagram_username` text,
	`instagram_url` text,
	`phone` text,
	`whatsapp` text,
	`email` text,
	`address` text,
	`neighborhood` text,
	`city` text,
	`state` text,
	`category` text,
	`subcategory` text,
	`followers` integer,
	`instagram_active` integer,
	`has_delivery` integer,
	`has_dining_room` integer,
	`has_waiters` integer,
	`has_multiple_units` integer,
	`has_online_ordering` integer,
	`estimated_size` text,
	`estimated_operation_complexity` text,
	`current_system` text,
	`pain_points` text,
	`notes` text,
	`source` text,
	`lead_score` integer,
	`qualification_status` text,
	`pipeline_stage` text DEFAULT 'NOVO' NOT NULL,
	`first_contact_at` integer,
	`last_contact_at` integer,
	`next_follow_up_at` integer,
	`do_not_contact` integer DEFAULT false,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `instagram_idx` ON `leads` (`instagram_username`);--> statement-breakpoint
CREATE UNIQUE INDEX `phone_idx` ON `leads` (`phone`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`commercial_name` text,
	`instagram` text,
	`whatsapp` text,
	`phone` text,
	`email` text,
	`city` text,
	`territory` text,
	`represented_company` text DEFAULT 'Sirrus',
	`role` text,
	`institutional_text` text
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`lead_id` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`due_at` integer,
	`completed_at` integer,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade
);
