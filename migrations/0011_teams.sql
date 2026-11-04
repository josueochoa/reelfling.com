-- Teams are a grouping only. Members keep their own API keys and their own
-- R2 buckets. A team does not store a key, a bucket, or a copy of anyone's files.
--
-- Numbered 0011: 0009 is claimed by open PRs #11 and #12, and 0010 by PR #13.
-- This file does not alter generations, assets, buckets, or keys.

CREATE TABLE teams (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE TABLE team_members (
  team_id   TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_members_by_user ON team_members (user_id);

-- Copyable invite links. Only the hash of the token is stored.
-- used_by is set when someone claims the link. A repeat by that same person,
-- while they are still a member, succeeds. After they are removed it does not.
CREATE TABLE team_invites (
  id         TEXT PRIMARY KEY,
  team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  used_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX team_invites_by_team ON team_invites (team_id);
