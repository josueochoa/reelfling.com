-- Image generations (the Image tab). Like `generations`, one JSON document per row;
-- the output files are assets with generation_id = id (see images.ts).
CREATE TABLE image_generations (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  data       TEXT NOT NULL
);
CREATE INDEX image_generations_by_user ON image_generations (user_id, created_at DESC);
