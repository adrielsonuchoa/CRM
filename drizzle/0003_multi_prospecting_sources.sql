ALTER TABLE `leads` ADD `google_place_id` text;
--> statement-breakpoint
ALTER TABLE `leads` ADD `google_maps_url` text;
--> statement-breakpoint
ALTER TABLE `leads` ADD `website` text;
--> statement-breakpoint
ALTER TABLE `leads` ADD `website_domain` text;
--> statement-breakpoint
ALTER TABLE `leads` ADD `rating` real;
--> statement-breakpoint
ALTER TABLE `leads` ADD `review_count` integer;
--> statement-breakpoint
ALTER TABLE `settings` ADD `prospecting_sources` text DEFAULT '["GOOGLE_PLACES"]';
--> statement-breakpoint
CREATE UNIQUE INDEX `leads_google_place_id_idx` ON `leads` (`google_place_id`);
--> statement-breakpoint
CREATE INDEX `leads_website_domain_idx` ON `leads` (`website_domain`);
