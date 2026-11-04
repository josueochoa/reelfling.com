import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

const FILES = readdirSync("migrations")
  .filter((name) => name.endsWith(".sql"))
  .sort();

function splitSql(sql: string) {
  return sql
    .split("\n")
    .map((line) => {
      const cut = line.indexOf("--");
      return cut === -1 ? line : line.slice(0, cut);
    })
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/** Runs a migration file. A second run skips "duplicate column name" and reapplies the data statements. */
function applyFile(db: DatabaseSync, name: string, tolerant: boolean) {
  const sql = readFileSync(`migrations/${name}`, "utf8");
  if (!tolerant) {
    db.exec(sql);
    return;
  }
  for (const statement of splitSql(sql)) {
    try {
      db.exec(statement);
    } catch (e) {
      if (!/duplicate column name/i.test((e as Error).message)) throw e;
    }
  }
}

function applyThrough(db: DatabaseSync, last: string) {
  for (const name of FILES) {
    if (name > last) break;
    applyFile(db, name, false);
  }
}

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function row(db: DatabaseSync, sql: string, ...params: (string | number | null)[]) {
  return db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
}

function val(db: DatabaseSync, sql: string, ...params: (string | number | null)[]) {
  const found = row(db, sql, ...params);
  return found && Object.values(found)[0];
}

describe("0010 on a fresh database", () => {
  it("applies 0001 through 0010, then again, without dropping the empty schema", () => {
    const db = open();
    for (const name of FILES) applyFile(db, name, false);
    applyFile(db, "0010_team_scope.sql", true);
    assert.equal(val(db, "SELECT COUNT(*) FROM workspaces"), 0);
    assert.ok(FILES.some((name) => name.startsWith("0010_")));
    const cols = db.prepare("PRAGMA table_info(fal_jobs)").all() as { name: string }[];
    assert.ok(cols.some((c) => c.name === "workspace_id"));
    assert.ok(cols.some((c) => c.name === "created_by"));
    const index = row(db, "SELECT name FROM sqlite_master WHERE name = 'fal_jobs_by_workspace'");
    assert.ok(index);
  });

  it("backfills rows written after 0008 and is safe to run twice", () => {
    const db = open();
    applyThrough(db, "0008_per_user_columns.sql");
    db.exec(`
      INSERT INTO users (id, email, name, active_provider, created_at) VALUES
        ('u1', 'a@example.com', 'Ada', 'argolink', 10);
      INSERT INTO generations (id, user_id, created_at, data) VALUES
        ('g-new', 'u1', 20, '{"prompt":"personal"}');
      INSERT INTO fal_jobs (id, user_id, created_at, data) VALUES
        ('f-new', 'u1', 20, '{}');
    `);
    applyFile(db, "0010_team_scope.sql", false);
    applyFile(db, "0010_team_scope.sql", true);

    assert.equal(val(db, "SELECT workspace_id FROM generations WHERE id = 'g-new'"), "u1");
    assert.equal(val(db, "SELECT created_by FROM generations WHERE id = 'g-new'"), "u1");
    assert.equal(val(db, "SELECT workspace_id FROM fal_jobs WHERE id = 'f-new'"), "u1");
    assert.equal(val(db, "SELECT created_by FROM fal_jobs WHERE id = 'f-new'"), "u1");
    assert.equal(val(db, "SELECT kind FROM workspaces WHERE id = 'u1'"), "personal");
    assert.equal(val(db, "SELECT role FROM workspace_members WHERE workspace_id = 'u1' AND user_id = 'u1'"), "owner");
    assert.equal(val(db, "SELECT active_provider FROM workspaces WHERE id = 'u1'"), "argolink");
    assert.equal(val(db, "SELECT COUNT(*) FROM workspace_members"), 1);
  });
});

describe("0010 on a prod-shaped database", () => {
  it("keeps dormant teams, keys and plan columns, and fills new personal rows", () => {
    const db = open();
    applyThrough(db, "0004_image_generations.sql");
    db.exec(`
      INSERT INTO users (id, email, name, active_provider, created_at) VALUES
        ('owner', 'owner@example.com', 'Owner', 'modelark', 1),
        ('member', 'member@example.com', 'Member', NULL, 2);
      INSERT INTO generations (id, user_id, created_at, data) VALUES
        ('g-personal', 'owner', 3, '{"prompt":"old"}');
      INSERT INTO image_generations (id, user_id, created_at, data) VALUES
        ('i-personal', 'owner', 3, '{}');
      INSERT INTO buckets (user_id, name, created_at) VALUES ('owner', 'reelfling-owner', 3);
      INSERT INTO api_keys (user_id, provider, secret, last4, created_at) VALUES
        ('owner', 'argolink', 'enc-personal-argolink', 'pers', 3);
      INSERT INTO assets (user_id, key, bucket, bytes, content_type, created_at) VALUES
        ('owner', 'videos/old.mp4', 'reelfling-owner', 10, 'video/mp4', 3);
    `);
    applyFile(db, "0005_workspaces.sql", false);

    // Dormant team, in the shape 0005 left behind, before 0006 stamped plan_override.
    db.exec(`
      INSERT INTO workspaces (id, name, kind, owner_id, active_provider, created_at) VALUES
        ('team1', 'Studio', 'team', 'owner', 'openrouter', 4);
      INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES
        ('team1', 'owner', 'owner', 4),
        ('team1', 'member', 'member', 5);
      INSERT INTO workspace_invites (id, workspace_id, email, token_hash, role, invited_by, created_at, expires_at) VALUES
        ('inv1', 'team1', 'new@example.com', 'hash-only', 'admin', 'owner', 6, 6 + 14 * 86400000);
      INSERT INTO generations (id, workspace_id, created_by, created_at, data) VALUES
        ('g-team', 'team1', 'member', 7, '{"prompt":"team"}');
      INSERT INTO api_keys (workspace_id, provider, secret, last4, base_url, created_at, created_by) VALUES
        ('team1', 'argolink', 'enc-team-argolink', 'team', NULL, 7, 'owner'),
        ('team1', 'openrouter', 'enc-team-openrouter', 'open', NULL, 7, 'owner');
      INSERT INTO buckets (workspace_id, name, created_at, cors) VALUES
        ('team1', 'reelfling-team1', 7, 0);
    `);
    applyFile(db, "0006_plans.sql", false);
    applyFile(db, "0007_fal_jobs.sql", false);
    db.exec(`INSERT INTO fal_jobs (id, user_id, created_at, data) VALUES ('f-old', 'owner', 8, '{}')`);
    applyFile(db, "0008_per_user_columns.sql", false);

    // What main writes today: user_id set, workspace_id left NULL.
    db.exec(`
      INSERT INTO generations (id, user_id, created_at, data, workspace_id, created_by) VALUES
        ('g-after', 'owner', 9, '{"prompt":"after"}', NULL, NULL);
      UPDATE users SET active_provider = 'argolink' WHERE id = 'owner';
      UPDATE workspaces SET active_provider = 'modelark' WHERE id = 'owner';
      UPDATE users SET plan_override = 'pro' WHERE id = 'owner';
    `);

    applyFile(db, "0010_team_scope.sql", false);
    const before = snapshot(db);
    applyFile(db, "0010_team_scope.sql", true);
    assert.deepEqual(snapshot(db), before);

    assert.equal(val(db, "SELECT workspace_id FROM generations WHERE id = 'g-after'"), "owner");
    assert.equal(val(db, "SELECT created_by FROM generations WHERE id = 'g-after'"), "owner");
    assert.equal(val(db, "SELECT workspace_id FROM generations WHERE id = 'g-personal'"), "owner");
    assert.equal(val(db, "SELECT workspace_id FROM generations WHERE id = 'g-team'"), "team1");
    assert.equal(val(db, "SELECT created_by FROM generations WHERE id = 'g-team'"), "member");
    assert.equal(val(db, "SELECT data FROM generations WHERE id = 'g-team'"), '{"prompt":"team"}');

    assert.equal(val(db, "SELECT user_id FROM api_keys WHERE secret = 'enc-team-argolink'"), null);
    assert.equal(val(db, "SELECT user_id FROM api_keys WHERE secret = 'enc-team-openrouter'"), null);
    assert.equal(val(db, "SELECT workspace_id FROM api_keys WHERE secret = 'enc-team-argolink'"), "team1");
    assert.equal(val(db, "SELECT secret FROM api_keys WHERE workspace_id = 'owner' AND provider = 'argolink'"), "enc-personal-argolink");
    assert.equal(val(db, "SELECT user_id FROM buckets WHERE name = 'reelfling-team1'"), null);
    assert.equal(val(db, "SELECT user_id FROM buckets WHERE name = 'reelfling-owner'"), "owner");

    assert.equal(val(db, "SELECT active_provider FROM workspaces WHERE id = 'owner'"), "argolink");
    assert.equal(val(db, "SELECT active_provider FROM workspaces WHERE id = 'team1'"), "openrouter");
    assert.equal(val(db, "SELECT kind FROM workspaces WHERE id = 'member'"), "personal");
    assert.equal(val(db, "SELECT token_hash FROM workspace_invites WHERE id = 'inv1'"), "hash-only");
    assert.equal(val(db, "SELECT COUNT(*) FROM workspace_members WHERE workspace_id = 'team1'"), 2);

    assert.equal(val(db, "SELECT workspace_id FROM fal_jobs WHERE id = 'f-old'"), "owner");
    assert.equal(val(db, "SELECT created_by FROM fal_jobs WHERE id = 'f-old'"), "owner");

    assert.equal(val(db, "SELECT plan_override FROM users WHERE id = 'owner'"), "pro");
    assert.equal(val(db, "SELECT plan FROM users WHERE id = 'owner'"), "free");
    const userCols = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
    for (const name of ["plan", "plan_override", "stripe_customer_id", "stripe_subscription_id"]) {
      assert.ok(userCols.some((c) => c.name === name), name);
    }
    assert.ok(row(db, "SELECT name FROM sqlite_master WHERE name = 'users_by_stripe_customer'"));
    assert.equal(val(db, "SELECT member_keys FROM workspaces WHERE id = 'team1'"), 0);
    assert.equal(val(db, "SELECT admins_manage_keys FROM workspaces WHERE id = 'team1'"), 0);
  });
});

describe("0013 route preferences", () => {
  it("keeps users.active_provider and copies the route off each generation", () => {
    const db = open();
    applyThrough(db, "0010_team_scope.sql");
    db.exec(`
      INSERT INTO users (id, email, name, active_provider, created_at) VALUES
        ('u1', 'a@example.com', 'Ada', 'modelark', 1);
      INSERT INTO workspaces (id, name, kind, owner_id, active_provider, created_at) VALUES
        ('u1', 'Personal', 'personal', 'u1', 'modelark', 1);
      INSERT INTO generations (id, user_id, workspace_id, created_by, created_at, data) VALUES
        ('g1', 'u1', 'u1', 'u1', 2, '{"route":"fal","model":"dreamina-seedance-2-0-260128"}');
      INSERT INTO image_generations (id, user_id, workspace_id, created_by, created_at, data) VALUES
        ('i1', 'u1', 'u1', 'u1', 2, '{"route":"openrouter","model":"nano-banana-2.1"}');
    `);
    applyFile(db, "0013_model_routes.sql", false);
    applyFile(db, "0013_model_routes.sql", true);

    assert.equal(val(db, "SELECT active_provider FROM users WHERE id = 'u1'"), "modelark");
    assert.equal(val(db, "SELECT route FROM generations WHERE id = 'g1'"), "fal");
    assert.equal(val(db, "SELECT route FROM image_generations WHERE id = 'i1'"), "openrouter");
    db.exec(`INSERT INTO route_preferences (user_id, model_id, provider) VALUES ('u1', 'dreamina-seedance-2-0-260128', 'fal')`);
    db.exec(
      `INSERT INTO route_preferences (user_id, model_id, provider) VALUES ('u1', 'dreamina-seedance-2-0-260128', 'modelark')
       ON CONFLICT (user_id, model_id) DO UPDATE SET provider = excluded.provider`,
    );
    assert.equal(
      val(db, "SELECT provider FROM route_preferences WHERE user_id = 'u1' AND model_id = 'dreamina-seedance-2-0-260128'"),
      "modelark",
    );
  });
});

function snapshot(db: DatabaseSync) {
  const tables = ["users", "workspaces", "workspace_members", "workspace_invites", "generations", "image_generations", "assets", "buckets", "api_keys", "fal_jobs"];
  const out: Record<string, unknown[]> = {};
  for (const table of tables) {
    out[table] = db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
  }
  return out;
}
