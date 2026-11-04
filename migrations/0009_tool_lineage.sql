-- Tool outputs point at the asset they were made from. The parent row is not rewritten.
ALTER TABLE assets ADD COLUMN parent_id TEXT;
ALTER TABLE assets ADD COLUMN tool TEXT;
CREATE INDEX IF NOT EXISTS assets_by_parent ON assets (user_id, parent_id);
