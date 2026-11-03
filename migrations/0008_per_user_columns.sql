-- Main queries generations, image_generations, assets, buckets, and api_keys by user_id.
-- 0005_workspaces replaced that column with workspace_id (NOT NULL, no default) and
-- created_by. This puts user_id back so those statements work, and keeps every
-- workspace, member, invite, plan, and Stripe column. Workspace ids and created_by
-- stay on the rows; nothing in workspaces / workspace_members / workspace_invites
-- or on users' plan columns is dropped.
--
-- Backfill: user_id comes from created_by, else the workspace owner. That is the
-- pre-0005 user id for personal workspaces (their id equals the user id, and 0005
-- copied user_id into both workspace_id and created_by).
--
-- buckets and api_keys can only have one row per user (main's PRIMARY KEY / ON
-- CONFLICT). A personal row wins. Any other row for that user is kept, with
-- user_id left null so the team secret or bucket is not overwritten or deleted.
-- assets are unique on (user_id, key); a real duplicate fails this migration
-- instead of dropping a row.

PRAGMA defer_foreign_keys = true;

-- ---------------------------------------------------------------- generations

CREATE TABLE generations_new (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  data         TEXT NOT NULL,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL
);
INSERT INTO generations_new (id, user_id, created_at, data, workspace_id, created_by)
SELECT
  g.id,
  COALESCE(g.created_by, (SELECT w.owner_id FROM workspaces w WHERE w.id = g.workspace_id)),
  g.created_at,
  g.data,
  g.workspace_id,
  g.created_by
FROM generations g;
DROP TABLE generations;
ALTER TABLE generations_new RENAME TO generations;
CREATE INDEX generations_by_user ON generations (user_id, created_at DESC);
CREATE INDEX generations_by_workspace ON generations (workspace_id, created_at DESC);

-- ---------------------------------------------------------------- image_generations

CREATE TABLE image_generations_new (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  data         TEXT NOT NULL,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL
);
INSERT INTO image_generations_new (id, user_id, created_at, data, workspace_id, created_by)
SELECT
  g.id,
  COALESCE(g.created_by, (SELECT w.owner_id FROM workspaces w WHERE w.id = g.workspace_id)),
  g.created_at,
  g.data,
  g.workspace_id,
  g.created_by
FROM image_generations g;
DROP TABLE image_generations;
ALTER TABLE image_generations_new RENAME TO image_generations;
CREATE INDEX image_generations_by_user ON image_generations (user_id, created_at DESC);
CREATE INDEX image_generations_by_workspace ON image_generations (workspace_id, created_at DESC);

-- ---------------------------------------------------------------- assets

CREATE TABLE assets_new (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  bucket        TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  content_type  TEXT NOT NULL,
  generation_id TEXT,
  created_at    INTEGER NOT NULL,
  name          TEXT,
  meta          TEXT,
  workspace_id  TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, key)
);
INSERT INTO assets_new (
  user_id, key, bucket, bytes, content_type, generation_id, created_at, name, meta, workspace_id, created_by
)
SELECT
  COALESCE(a.created_by, (SELECT w.owner_id FROM workspaces w WHERE w.id = a.workspace_id)),
  a.key, a.bucket, a.bytes, a.content_type, a.generation_id, a.created_at, a.name, a.meta,
  a.workspace_id, a.created_by
FROM assets a;
DROP TABLE assets;
ALTER TABLE assets_new RENAME TO assets;
CREATE INDEX assets_by_generation ON assets (user_id, generation_id);
CREATE INDEX assets_by_user_created ON assets (user_id, created_at DESC);
CREATE INDEX assets_by_creator ON assets (created_by);
CREATE INDEX assets_by_workspace_created ON assets (workspace_id, created_at DESC);

-- ---------------------------------------------------------------- buckets
-- user_id is UNIQUE rather than the primary key so a preserved team bucket can
-- keep a null user_id. Main inserts (user_id, name, created_at) and hits that
-- unique index via INSERT OR IGNORE.

CREATE TABLE buckets_new (
  user_id      TEXT REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  cors         INTEGER NOT NULL DEFAULT 0,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE
);
INSERT INTO buckets_new (user_id, name, created_at, cors, workspace_id)
SELECT
  CASE
    WHEN b.workspace_id = (
      SELECT b2.workspace_id
      FROM buckets b2
      JOIN workspaces w2 ON w2.id = b2.workspace_id
      WHERE w2.owner_id = w.owner_id
      ORDER BY CASE w2.kind WHEN 'personal' THEN 0 ELSE 1 END, b2.created_at, b2.workspace_id
      LIMIT 1
    ) THEN w.owner_id
    ELSE NULL
  END,
  b.name,
  b.created_at,
  b.cors,
  b.workspace_id
FROM buckets b
JOIN workspaces w ON w.id = b.workspace_id;
DROP TABLE buckets;
ALTER TABLE buckets_new RENAME TO buckets;
CREATE UNIQUE INDEX buckets_by_user ON buckets (user_id);
CREATE UNIQUE INDEX buckets_by_workspace ON buckets (workspace_id);

-- ---------------------------------------------------------------- api_keys
-- Same rule: one visible row per (user_id, provider), personal workspace first.
-- ON CONFLICT (user_id, provider) matches api_keys_by_user.

CREATE TABLE api_keys_new (
  user_id      TEXT REFERENCES users(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,
  secret       TEXT NOT NULL, -- AES-256-GCM, see crypto.ts
  last4        TEXT NOT NULL,
  base_url     TEXT,
  created_at   INTEGER NOT NULL,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL
);
INSERT INTO api_keys_new (user_id, provider, secret, last4, base_url, created_at, workspace_id, created_by)
SELECT
  CASE
    WHEN k.workspace_id = (
      SELECT k2.workspace_id
      FROM api_keys k2
      JOIN workspaces w2 ON w2.id = k2.workspace_id
      WHERE k2.provider = k.provider
        AND COALESCE(k2.created_by, w2.owner_id) = COALESCE(k.created_by, w.owner_id)
      ORDER BY CASE w2.kind WHEN 'personal' THEN 0 ELSE 1 END, k2.created_at, k2.workspace_id
      LIMIT 1
    ) THEN COALESCE(k.created_by, w.owner_id)
    ELSE NULL
  END,
  k.provider,
  k.secret,
  k.last4,
  k.base_url,
  k.created_at,
  k.workspace_id,
  k.created_by
FROM api_keys k
JOIN workspaces w ON w.id = k.workspace_id;
DROP TABLE api_keys;
ALTER TABLE api_keys_new RENAME TO api_keys;
CREATE UNIQUE INDEX api_keys_by_user ON api_keys (user_id, provider);
CREATE UNIQUE INDEX api_keys_by_workspace ON api_keys (workspace_id, provider);
