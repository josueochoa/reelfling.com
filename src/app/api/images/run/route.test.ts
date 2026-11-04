import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { join } from "node:path";
import { setTestEnv, type AppEnv } from "@/lib/db";

const USER = "user-1";
const OTHER = "workspace-9";

const database = new DatabaseSync(":memory:");
database.exec("PRAGMA foreign_keys = ON");
for (const file of readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort()) {
  database.exec(readFileSync(join("migrations", file), "utf8"));
}
database.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").run(USER, "a@b.c", 1);
database.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").run(OTHER, "b@b.c", 1);

function fakeD1(db: DatabaseSync) {
  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      return {
        bind(...params: (string | number | null)[]) {
          return {
            async first<T>() {
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
  AUTH_SECRET: "test-auth-secret-at-least-32-characters",
});

const { POST } = await import("./route");

function job(id: string, userId: string) {
  const data = {
    id,
    model: "missing-model",
    prompt: "hi",
    status: "queued",
    ratio: "1:1",
    resolution: "1K",
    count: 1,
    references: [],
    images: [],
    cost: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  database
    .prepare("INSERT INTO image_generations (id, user_id, created_at, data) VALUES (?, ?, ?, ?)")
    .run(id, userId, 1, JSON.stringify(data));
}

function status(id: string) {
  const row = database.prepare("SELECT json_extract(data, '$.status') AS status FROM image_generations WHERE id = ?").get(id) as {
    status: string;
  };
  return row.status;
}

const originalError = console.error;
afterEach(() => {
  console.error = originalError;
  database.prepare("DELETE FROM image_generations").run();
  globalThis.__jobTokens = new Set();
});

async function post(body: unknown, token = "job-token") {
  console.error = () => {};
  globalThis.__jobTokens = new Set(["job-token"]);
  return POST(
    new Request("https://internal.invalid/api/images/run", {
      method: "POST",
      headers: { "content-type": "application/json", "x-job-token": token },
      body: JSON.stringify(body),
    }),
  );
}

describe("image job route", () => {
  it("accepts workspaceId from the previous build's queue messages", async () => {
    job("from-workspace", USER);
    const res = await post({ workspaceId: USER, id: "from-workspace" });
    assert.equal(res.status, 204);
    assert.equal(status("from-workspace"), "failed");
  });

  it("prefers userId when both are present", async () => {
    job("for-user", USER);
    job("for-workspace", OTHER);
    const res = await post({ userId: USER, workspaceId: OTHER, id: "for-user" });
    assert.equal(res.status, 204);
    assert.equal(status("for-user"), "failed");
    assert.equal(status("for-workspace"), "queued");
  });

  it("rejects a call without the in-process token", async () => {
    const res = await post({ userId: USER, id: "nope" }, "nope");
    assert.equal(res.status, 404);
  });
});
