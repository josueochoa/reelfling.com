-- Set once CORS has been applied to the bucket, so browsers can upload straight to it.
ALTER TABLE buckets ADD COLUMN cors INTEGER NOT NULL DEFAULT 0;
