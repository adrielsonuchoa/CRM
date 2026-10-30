-- Add diagnostic columns for Instagram enrichment
ALTER TABLE leads ADD COLUMN profile_score REAL;
--> statement-breakpoint
ALTER TABLE leads ADD COLUMN profile_accepted INTEGER;
--> statement-breakpoint
ALTER TABLE leads ADD COLUMN keyword_hits INTEGER;
--> statement-breakpoint
ALTER TABLE leads ADD COLUMN profile_snippet TEXT;
--> statement-breakpoint
ALTER TABLE leads ADD COLUMN posts_count INTEGER;
--> statement-breakpoint
ALTER TABLE leads ADD COLUMN profile_diagnostics TEXT;
