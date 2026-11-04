-- Copy the personal workspace's active provider onto the user.
--
-- Main reads users.active_provider (src/lib/auth.ts). The rolled-back build writes
-- workspaces.active_provider. 0005_workspaces.sql creates that table and column
-- (kind, active_provider) and seeds it from users. Nothing in 0006–0011 drops
-- either. A NULL workspace value does not wipe the user: the WHERE clause
-- requires a non-null personal provider.
--
-- Prod D1 restored to 0001–0006 already has this column, so 0012 applies there
-- after 0007–0011. A fresh database applies 0005 first, so the column exists
-- here too.
--
-- If the workspaces table or active_provider column is missing, this statement
-- fails before it changes a row, and wrangler does not record the migration.
-- That is fail-closed: there is no SQL way to skip a statement that names a
-- missing table without creating a fake workspaces object, which would block
-- 0005. Do not apply 0012 to a database that has never run 0005.

UPDATE users
SET active_provider = (
  SELECT w.active_provider
  FROM workspaces w
  WHERE w.id = users.id AND w.kind = 'personal'
)
WHERE EXISTS (
  SELECT 1
  FROM workspaces w
  WHERE w.id = users.id AND w.kind = 'personal' AND w.active_provider IS NOT NULL
);
