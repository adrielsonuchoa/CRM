ALTER TABLE `leads` ADD `place_id` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `leads_place_id_idx` ON `leads` (`place_id`);