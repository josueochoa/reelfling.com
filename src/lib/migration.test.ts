import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

const FILES = readdirSync("migrations")
  .filter((name) => name.endsWith(".sql"))
  .sort();

function applyUntil(db: DatabaseSync, last: string) {
  for (const name of FILES) {
    if (name > last) break;
    db.exec(readFileSync(`migrations/${name}`, "utf8"));
  }
}

describe("0013 model routes", () => {
  it("is the only migration after 0012 and copies the route off each generation", () => {
    const numbers = FILES.map((name) => name.slice(0, 4));
    assert.equal(new Set(numbers).size, numbers.length);
    assert.equal(FILES.filter((name) => name.startsWith("0013")).length, 1);
    assert.ok(FILES.some((name) => name === "0013_model_routes.sql"));
    assert.equal(FILES.some((name) => name.startsWith("0014")), false);

    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    applyUntil(db, "0012_users_active_provider.sql");
    db.exec(`
      INSERT INTO users (id, email, name, active_provider, created_at) VALUES
        ('u1', 'a@example.com', 'Ada', 'modelark', 1);
      INSERT INTO generations (id, user_id, created_at, data) VALUES
        ('g1', 'u1', 2, '{"route":"fal","model":"dreamina-seedance-2-0-260128"}');
      INSERT INTO image_generations (id, user_id, created_at, data) VALUES
        ('i1', 'u1', 2, '{"route":"openrouter","model":"nano-banana-2.1"}');
    `);
    db.exec(readFileSync("migrations/0013_model_routes.sql", "utf8"));
    const route = db.prepare("SELECT route FROM generations WHERE id = 'g1'").get() as { route: string };
    const image = db.prepare("SELECT route FROM image_generations WHERE id = 'i1'").get() as { route: string };
    const active = db.prepare("SELECT active_provider FROM users WHERE id = 'u1'").get() as { active_provider: string };
    assert.equal(route.route, "fal");
    assert.equal(image.route, "openrouter");
    assert.equal(active.active_provider, "modelark");
  });
});
