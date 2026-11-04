import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { setTestEnv, type AppEnv } from "./db";

const USER = "user-1";
const SOURCE = "gen-src";

/** When set, the next claim inserts throw this many unique-constraint errors. */
let failClaims = 0;

const database = new DatabaseSync(":memory:");
database.exec("PRAGMA foreign_keys = ON");
for (const file of readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort()) {
  database.exec(readFileSync(join("migrations", file), "utf8"));
}
database.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").run(USER, "a@b.c", 1);

function fakeD1(db: DatabaseSync) {
  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      return {
        bind(...params: (string | number | null)[]) {
          return {
            async first<T>() {
              if (failClaims > 0 && sql.includes("INSERT INTO sequence_parts")) {
                failClaims -= 1;
                throw new Error("UNIQUE constraint failed: sequence_parts.sequence_id, sequence_parts.part");
              }
              return (stmt.get(...params) as T | undefined) ?? null;
            },
            async all<T>() {
              return { results: stmt.all(...params) as T[] };
            },
            async run() {
              const info = stmt.run(...params);
              return { meta: { changes: Number(info.changes) } };
            },
          };
        },
      };
    },
  };
}

setTestEnv({
  DB: fakeD1(database) as unknown as AppEnv["DB"],
});

const { continueSequence, getGeneration } = await import("./store");

function generation(id: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ id, status: "succeeded", createdAt: 1, updatedAt: 1, ...extra });
}

function insertGeneration(id: string, createdAt: number, extra: Record<string, unknown> = {}) {
  database
    .prepare("INSERT INTO generations (id, user_id, created_at, data) VALUES (?, ?, ?, ?)")
    .run(id, USER, createdAt, generation(id, extra));
}

afterEach(() => {
  failClaims = 0;
  database.prepare("DELETE FROM fal_jobs").run();
  database.prepare("DELETE FROM generations").run();
  database.prepare("DELETE FROM sequence_parts").run();
});

describe("continueSequence", () => {
  it("gives two concurrent continues distinct part numbers", async () => {
    insertGeneration(SOURCE, 1);
    const [first, second] = await Promise.all([
      continueSequence(USER, SOURCE),
      continueSequence(USER, SOURCE),
    ]);
    assert.ok(first);
    assert.ok(second);
    assert.equal(first.sequenceId, SOURCE);
    assert.equal(second.sequenceId, SOURCE);
    assert.equal(first.sourceGenerationId, SOURCE);
    assert.equal(second.sourceGenerationId, SOURCE);
    // Without a claim inside continueSequence both reads see no later part and both return 2.
    assert.deepEqual(
      [first.part, second.part].sort((a, b) => a - b),
      [2, 3],
    );

    const third = await continueSequence(USER, SOURCE);
    assert.equal(third?.part, 4);
    assert.equal(third?.sequenceId, SOURCE);

    const source = await getGeneration(USER, SOURCE);
    assert.equal(source?.sequenceId, SOURCE);
    assert.equal(source?.part, 1);

    const claimed = database
      .prepare("SELECT part FROM sequence_parts WHERE sequence_id = ? ORDER BY part")
      .all(SOURCE) as { part: number }[];
    assert.deepEqual(
      claimed.map((row) => row.part),
      [2, 3, 4],
    );
  });

  it("retries once when the unique index rejects the claim", async () => {
    insertGeneration(SOURCE, 1);
    failClaims = 1;
    const plan = await continueSequence(USER, SOURCE);
    assert.equal(failClaims, 0);
    assert.equal(plan?.part, 2);
    assert.equal(plan?.sequenceId, SOURCE);
    const claimed = database.prepare("SELECT part FROM sequence_parts WHERE sequence_id = ?").all(SOURCE) as {
      part: number;
    }[];
    assert.deepEqual(
      claimed.map((row) => row.part),
      [2],
    );
    const source = await getGeneration(USER, SOURCE);
    assert.equal(source?.part, 1);
  });

  it("numbers the next part after generations and fal jobs already in the sequence", async () => {
    insertGeneration(SOURCE, 1, { sequenceId: SOURCE, part: 1 });
    insertGeneration("gen-4", 4, { sequenceId: SOURCE, part: 4 });
    database.prepare("INSERT INTO fal_jobs (id, user_id, created_at, data) VALUES (?, ?, ?, ?)").run(
      "job-2",
      USER,
      2,
      JSON.stringify({ sequence: { sequenceId: SOURCE, part: 2, sourceGenerationId: SOURCE } }),
    );
    const plan = await continueSequence(USER, SOURCE);
    assert.equal(plan?.part, 5);
    assert.equal(plan?.sequenceId, SOURCE);
    assert.equal(plan?.sourceGenerationId, SOURCE);
    const source = await getGeneration(USER, SOURCE);
    assert.equal(source?.part, 1);
    assert.equal(source?.sequenceId, SOURCE);
  });
});
