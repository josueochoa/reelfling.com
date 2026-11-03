-- Team scope.
-- Prod already applied 0005, 0006 and 0008. Rows the app wrote after 0008 have
-- user_id and a NULL workspace_id. This fills those in, gives every user a
-- Personal workspace, and adds the team columns. It does not drop teams, members,
-- invites, keys, buckets, plan columns, the stripe index, or plan_override.
--
-- The UPDATE / INSERT statements only fill NULLs or missing rows, so running them
-- again does not change data that is already in place. SQLite has no
-- "ADD COLUMN IF NOT EXISTS"; a second run of the three ALTER statements reports
-- "duplicate column name" and does not change the column. Wrangler records this
-- file and applies it once.

PRAGMA defer_foreign_keys = true;

-- Personal workspace for every account. Its id is the user id, same as 0005.
INSERT OR IGNORE INTO workspaces (id, name, kind, owner_id, active_provider, created_at)
SELECT id, 'Personal', 'personal', id, active_provider, created_at FROM users;

INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, joined_at)
SELECT id, id, 'owner', created_at FROM users;

-- Rows written after 0008 left workspace_id NULL. A personal workspace id is the user id.
UPDATE generations SET workspace_id = user_id WHERE workspace_id IS NULL;
UPDATE generations SET created_by = user_id WHERE created_by IS NULL;

UPDATE image_generations SET workspace_id = user_id WHERE workspace_id IS NULL;
UPDATE image_generations SET created_by = user_id WHERE created_by IS NULL;

UPDATE assets SET workspace_id = user_id WHERE workspace_id IS NULL;
UPDATE assets SET created_by = user_id WHERE created_by IS NULL;

UPDATE buckets SET workspace_id = user_id WHERE workspace_id IS NULL AND user_id IS NOT NULL;

UPDATE api_keys SET workspace_id = user_id WHERE workspace_id IS NULL AND user_id IS NOT NULL;
UPDATE api_keys SET created_by = user_id WHERE created_by IS NULL AND user_id IS NOT NULL;

-- Team keys and buckets stay on the team. 0008 may have copied the owner's user_id
-- onto a team row so the old per-user queries could see it. The secret and the
-- bucket stay; user_id is cleared so the row does not occupy that person's slot.
UPDATE api_keys
SET user_id = NULL
WHERE workspace_id IN (SELECT id FROM workspaces WHERE kind = 'team');

UPDATE buckets
SET user_id = NULL
WHERE workspace_id IN (SELECT id FROM workspaces WHERE kind = 'team');

-- Personal route preference: users.active_provider wins. Team rows are not touched.
UPDATE workspaces
SET active_provider = (SELECT u.active_provider FROM users u WHERE u.id = workspaces.owner_id)
WHERE kind = 'personal';

-- fal jobs get the same scope columns as the other generation tables.
ALTER TABLE fal_jobs ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE fal_jobs ADD COLUMN created_by TEXT REFERENCES users(id) ON DELETE SET NULL;

UPDATE fal_jobs SET workspace_id = user_id WHERE workspace_id IS NULL;
UPDATE fal_jobs SET created_by = user_id WHERE created_by IS NULL;

CREATE INDEX IF NOT EXISTS fal_jobs_by_workspace ON fal_jobs (workspace_id, created_at DESC);

-- Owner options. Defaults leave an existing team on the shared key, owner-managed.
ALTER TABLE workspaces ADD COLUMN member_keys INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspaces ADD COLUMN admins_manage_keys INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspace_members ADD COLUMN monthly_cap_usd REAL;
