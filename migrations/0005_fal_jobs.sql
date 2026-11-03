-- Generic fal queue jobs. One JSON document per row (see falJobs.ts). Output files are
-- assets with generation_id = id, under fal/<id>/ in the user's bucket.
CREATE TABLE fal_jobs (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  data       TEXT NOT NULL
);
CREATE INDEX fal_jobs_by_user ON fal_jobs (user_id, created_at DESC);
