-- Per-model route, and the route each generation actually called.
--
-- No preference row means the resolver still reads users.active_provider.
-- 0012 copied the personal workspace's provider onto the user. The
-- single-provider switch is gone. This file does not write a preference
-- row, because a global provider is not a choice for every model.
--
-- `route` is the provider name. Older rows keep it inside data JSON; the
-- column is filled from that. A second run of the ALTER statements reports
-- "duplicate column name" and does not change the column. The UPDATEs only
-- fill NULLs.

CREATE TABLE IF NOT EXISTS route_preferences (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  PRIMARY KEY (user_id, model_id)
);

ALTER TABLE generations ADD COLUMN route TEXT;
ALTER TABLE image_generations ADD COLUMN route TEXT;

UPDATE generations
SET route = json_extract(data, '$.route')
WHERE route IS NULL AND json_extract(data, '$.route') IS NOT NULL;

UPDATE image_generations
SET route = json_extract(data, '$.route')
WHERE route IS NULL AND json_extract(data, '$.route') IS NOT NULL;
