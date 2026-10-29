// SQLite via Node's built-in driver. One file at $DATA_DIR/app.db (default ./data).

import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  google_sub      TEXT NOT NULL UNIQUE,
  email           TEXT NOT NULL,
  name            TEXT,
  avatar_url      TEXT,
  active_provider TEXT,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider   TEXT NOT NULL,
  secret     TEXT NOT NULL, -- AES-256-GCM, see crypto.ts
  last4      TEXT NOT NULL,
  base_url   TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider)
);

CREATE TABLE IF NOT EXISTS generations (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  data       TEXT NOT NULL -- JSON-encoded Generation
);
CREATE INDEX IF NOT EXISTS generations_by_user ON generations (user_id, created_at DESC);

-- One R2 bucket per user (see storage.ts).
CREATE TABLE IF NOT EXISTS buckets (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- Every stored object, wherever it lives. Usage is SUM(bytes) per user.
CREATE TABLE IF NOT EXISTS assets (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  driver        TEXT NOT NULL, -- 'r2' | 'local'
  bucket        TEXT,
  bytes         INTEGER NOT NULL,
  content_type  TEXT NOT NULL,
  generation_id TEXT,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE INDEX IF NOT EXISTS assets_by_generation ON assets (user_id, generation_id);
`;

function open() {
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(DATA_DIR, "app.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  return db;
}

// Reuse one connection across dev hot reloads.
const g = globalThis as unknown as { __db?: DatabaseSync };
export const db = (g.__db ??= open());
