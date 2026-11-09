ALTER TABLE claims ADD COLUMN release_at INTEGER;
ALTER TABLE claims ADD COLUMN release_rule TEXT;
ALTER TABLE claims ADD COLUMN post_id TEXT;
ALTER TABLE claims ADD COLUMN post_hours INTEGER;
ALTER TABLE claims ADD COLUMN release_checked_at INTEGER;
ALTER TABLE claims ADD COLUMN release_note TEXT;
ALTER TABLE batches ADD COLUMN release_mode TEXT;
