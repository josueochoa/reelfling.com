-- The uploads library: display name, and per-file details (JSON: duration, waveform peaks,
-- thumbnail key) so the library and reference blocks render without loading the media.
ALTER TABLE assets ADD COLUMN name TEXT;
ALTER TABLE assets ADD COLUMN meta TEXT;
CREATE INDEX assets_by_user_created ON assets (user_id, created_at DESC);
