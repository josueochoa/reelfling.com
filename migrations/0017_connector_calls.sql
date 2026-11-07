-- The Claude connector (src/mcp). A paid tool only runs a request it priced first:
-- connector_quotes holds that request for 15 minutes under a short id Claude passes back,
-- and connector_calls records each job it started. The quote id is unique there, so a
-- quote starts at most one job, and the daily spend cap sums cost per user and OAuth
-- client over the last 24 hours.
CREATE TABLE connector_quotes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  request TEXT NOT NULL,
  cost REAL NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE connector_calls (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  quote_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  job_id TEXT,
  cost REAL NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX connector_calls_user_client ON connector_calls (user_id, client_id, created_at);
