import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { join } from "node:path";

const files = readdirSync("migrations")
  .filter((name) => name.endsWith(".sql"))
  .sort();

function fresh() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function apply(db: DatabaseSync, opts: { from?: string; through?: string } = {}) {
  for (const file of files) {
    if (opts.from && file < opts.from) continue;
    if (opts.through && file > opts.through) break;
    db.exec(readFileSync(join("migrations", file), "utf8"));
  }
}

const backfill = () => readFileSync(join("migrations", "0012_users_active_provider.sql"), "utf8");

function providers(db: DatabaseSync) {
  return (
    db.prepare("SELECT id, active_provider FROM users ORDER BY id").all() as {
      id: string;
      active_provider: string | null;
    }[]
  ).map((row) => ({ id: row.id, active_provider: row.active_provider }));
}

describe("migration 0012", () => {
  it("is numbered 0012 and does not reuse 0010", () => {
    assert.equal(files.includes("0010_anything.sql"), false);
    assert.equal(
      files.some((file) => file.startsWith("0010")),
      false,
    );
    assert.equal(files.filter((file) => file.startsWith("0012_")).length, 1);
    assert.equal(files.at(-1), "0012_users_active_provider.sql");
  });

  it("copies a personal workspace provider and leaves nulls alone", () => {
    const db = fresh();
    apply(db);
    db.exec(`
      INSERT INTO users (id, email, created_at, active_provider) VALUES
        ('u1', 'a@b.c', 1, 'stale'),
        ('u2', 'b@b.c', 1, 'keep-me'),
        ('u3', 'c@b.c', 1, 'no-workspace');
      INSERT INTO workspaces (id, name, kind, owner_id, active_provider, created_at) VALUES
        ('u1', 'Personal', 'personal', 'u1', 'openrouter', 1),
        ('u2', 'Personal', 'personal', 'u2', NULL, 1);
    `);
    db.exec(backfill());
    assert.deepEqual(providers(db), [
      { id: "u1", active_provider: "openrouter" },
      { id: "u2", active_provider: "keep-me" },
      { id: "u3", active_provider: "no-workspace" },
    ]);
  });

  it("applies 0007–0012 on a 0001–0006 database that already has workspace providers", () => {
    const db = fresh();
    apply(db, { through: "0006_plans.sql" });
    db.exec(`
      INSERT INTO users (id, email, created_at, active_provider) VALUES
        ('u1', 'a@b.c', 1, 'stale'),
        ('u2', 'b@b.c', 1, 'keep-me');
      INSERT INTO workspaces (id, name, kind, owner_id, active_provider, created_at) VALUES
        ('u1', 'Personal', 'personal', 'u1', 'openrouter', 1),
        ('u2', 'Personal', 'personal', 'u2', NULL, 1);
      INSERT INTO assets (workspace_id, key, bucket, bytes, content_type, created_at, created_by)
        VALUES ('u1', 'images/x.png', 'reelfling-media', 4, 'image/png', 1, 'u1');
      INSERT INTO buckets (workspace_id, name, created_at, cors)
        VALUES ('u1', 'old-bucket', 1, 1);
      INSERT INTO api_keys (workspace_id, provider, secret, last4, created_at, created_by)
        VALUES ('u1', 'argolink', 'ciphertext-not-a-key', 'abcd', 1, 'u1');
    `);
    apply(db, { from: "0007_fal_jobs.sql" });
    assert.deepEqual(providers(db), [
      { id: "u1", active_provider: "openrouter" },
      { id: "u2", active_provider: "keep-me" },
    ]);
    const asset = db.prepare("SELECT user_id, workspace_id, key, bucket FROM assets").get() as {
      user_id: string;
      workspace_id: string;
      key: string;
      bucket: string;
    };
    assert.equal(asset.user_id, "u1");
    assert.equal(asset.workspace_id, "u1");
    assert.equal(asset.key, "images/x.png");
    assert.equal(asset.bucket, "reelfling-media");
  });

  it("changes nothing when workspaces or active_provider is missing", () => {
    const noTable = fresh();
    apply(noTable, { through: "0004_image_generations.sql" });
    noTable.prepare("UPDATE users SET active_provider = 'stale'").run();
    noTable.exec(`INSERT INTO users (id, email, created_at, active_provider) VALUES ('u1', 'a@b.c', 1, 'stale')`);
    assert.throws(() => noTable.exec(backfill()), /no such table: workspaces/);
    assert.equal(
      (noTable.prepare("SELECT active_provider FROM users WHERE id = 'u1'").get() as { active_provider: string })
        .active_provider,
      "stale",
    );

    const noColumn = fresh();
    noColumn.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, active_provider TEXT);
      INSERT INTO users VALUES ('u1', 'stale');
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, kind TEXT);
      INSERT INTO workspaces VALUES ('u1', 'personal');
    `);
    assert.throws(() => noColumn.exec(backfill()), /no such column: w\.active_provider/);
    assert.equal(
      (noColumn.prepare("SELECT active_provider FROM users WHERE id = 'u1'").get() as { active_provider: string })
        .active_provider,
      "stale",
    );
  });
});
