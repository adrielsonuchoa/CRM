-- Add diagnostic columns for Instagram enrichment
ALTER TABLE leads ADD COLUMN profile_score REAL;
ALTER TABLE leads ADD COLUMN profile_accepted INTEGER;
ALTER TABLE leads ADD COLUMN keyword_hits INTEGER;
ALTER TABLE leads ADD COLUMN profile_snippet TEXT;
ALTER TABLE leads ADD COLUMN posts_count INTEGER;
ALTER TABLE leads ADD COLUMN profile_diagnostics TEXT;
