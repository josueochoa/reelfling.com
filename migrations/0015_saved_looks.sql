-- Named looks for one user. JSON array of { id, name, choice }.
-- The generation record still stores the chips that were used, so Reuse
-- does not need this column. This is only the saved list.
ALTER TABLE users ADD COLUMN looks TEXT;
