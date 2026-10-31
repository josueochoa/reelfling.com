-- Workspaces: everything (generations, assets, buckets, API keys) belongs to a workspace
-- instead of a user. Every user has a Personal workspace whose id is their user id, so
-- existing rows and R2 bucket names carry over unchanged; teams are extra workspaces.
-- Data tables are rebuilt because D1 (SQLite) can't change a foreign key in place.

PRAGMA defer_foreign_keys = true;

CREATE TABLE workspaces (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL, -- 'personal' | 'team'
  owner_id        TEXT NOT NULL REFERENCES users(id),
  active_provider TEXT,          -- which of the workspace's API keys generations use
  created_at      INTEGER NOT NULL
);

CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL, -- 'owner' | 'admin' | 'member'
  joined_at    INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_by_user ON workspace_members (user_id);

-- Email invites (email set) and invite links (token_hash set). Tokens are stored hashed.
CREATE TABLE workspace_invites (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email        TEXT,
  token_hash   TEXT UNIQUE,
  role         TEXT NOT NULL,
  invited_by   TEXT NOT NULL REFERENCES users(id),
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX workspace_invites_by_email ON workspace_invites (email);
CREATE INDEX workspace_invites_by_workspace ON workspace_invites (workspace_id);

INSERT INTO workspaces (id, name, kind, owner_id, active_provider, created_at)
  SELECT id, 'Personal', 'personal', id, active_provider, created_at FROM users;
INSERT INTO workspace_members (workspace_id, user_id, role, joined_at)
  SELECT id, id, 'owner', created_at FROM users;

-- generations
CREATE TABLE generations_new (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL,
  data         TEXT NOT NULL
);
INSERT INTO generations_new SELECT id, user_id, user_id, created_at, data FROM generations;
DROP TABLE generations;
ALTER TABLE generations_new RENAME TO generations;
CREATE INDEX generations_by_workspace ON generations (workspace_id, created_at DESC);

-- image_generations
CREATE TABLE image_generations_new (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL,
  data         TEXT NOT NULL
);
INSERT INTO image_generations_new SELECT id, user_id, user_id, created_at, data FROM image_generations;
DROP TABLE image_generations;
ALTER TABLE image_generations_new RENAME TO image_generations;
CREATE INDEX image_generations_by_workspace ON image_generations (workspace_id, created_at DESC);

-- assets
CREATE TABLE assets_new (
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  bucket        TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  content_type  TEXT NOT NULL,
  generation_id TEXT,
  created_at    INTEGER NOT NULL,
  name          TEXT,
  meta          TEXT,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (workspace_id, key)
);
INSERT INTO assets_new
  SELECT user_id, key, bucket, bytes, content_type, generation_id, created_at, name, meta, user_id FROM assets;
DROP TABLE assets;
ALTER TABLE assets_new RENAME TO assets;
CREATE INDEX assets_by_generation ON assets (workspace_id, generation_id);
CREATE INDEX assets_by_workspace_created ON assets (workspace_id, created_at DESC);

-- buckets: one per workspace
CREATE TABLE buckets_new (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  cors         INTEGER NOT NULL DEFAULT 0
);
INSERT INTO buckets_new SELECT user_id, name, created_at, cors FROM buckets;
DROP TABLE buckets;
ALTER TABLE buckets_new RENAME TO buckets;

-- api_keys: personal keys, or a team's shared keys
CREATE TABLE api_keys_new (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,
  secret       TEXT NOT NULL, -- AES-256-GCM, see crypto.ts
  last4        TEXT NOT NULL,
  base_url     TEXT,
  created_at   INTEGER NOT NULL,
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (workspace_id, provider)
);
INSERT INTO api_keys_new SELECT user_id, provider, secret, last4, base_url, created_at, user_id FROM api_keys;
DROP TABLE api_keys;
ALTER TABLE api_keys_new RENAME TO api_keys;
