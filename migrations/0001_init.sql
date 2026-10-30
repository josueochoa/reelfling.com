-- Accounts are keyed by email, so the sign-in method (Cloudflare Access or Google)
-- can change without users losing their keys and videos.
CREATE TABLE users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE, -- lowercased
  name            TEXT,
  avatar_url      TEXT,
  active_provider TEXT,
  created_at      INTEGER NOT NULL
);

-- Only used with AUTH_MODE=google. Cloudflare Access manages its own sessions.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE api_keys (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider   TEXT NOT NULL,
  secret     TEXT NOT NULL, -- AES-256-GCM, see crypto.ts
  last4      TEXT NOT NULL,
  base_url   TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider)
);

CREATE TABLE generations (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  data       TEXT NOT NULL -- JSON-encoded Generation
);
CREATE INDEX generations_by_user ON generations (user_id, created_at DESC);

-- One R2 bucket per user (see storage.ts).
CREATE TABLE buckets (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- Every stored object. Usage is SUM(bytes) per user.
CREATE TABLE assets (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  bucket        TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  content_type  TEXT NOT NULL,
  generation_id TEXT,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE INDEX assets_by_generation ON assets (user_id, generation_id);
