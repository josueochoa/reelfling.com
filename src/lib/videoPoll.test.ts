import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { STALE_VIDEO_ERROR, STALE_VIDEO_MS, staleVideoFailure } from "./staleVideo";

const KEY = "sk-argolink-TESTSECRET-do-not-store";

function generation(status: string) {
  return JSON.stringify({
    status,
    provider: "argolink",
    taskId: "task-1",
    progress: 43,
    model: "seedance-2.5",
    prompt: `@Imagen 1 es el personaje principal. secret ${KEY}`,
    mode: "references",
    ratio: "9:16",
    resolution: "480p",
    duration: 30,
    generateAudio: false,
  });
}

describe("video sweep timeout", () => {
  it("fails a video that has been running for 2 hours and leaves a 1 hour one running", () => {
    const now = 1_700_000_000_000;
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE generations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      data TEXT NOT NULL
    )`);
    const insert = db.prepare("INSERT INTO generations (id, user_id, created_at, data) VALUES (?, 'user', ?, ?)");
    insert.run("old-running", now - STALE_VIDEO_MS, generation("running"));
    insert.run("old-queued", now - STALE_VIDEO_MS - 60_000, generation("queued"));
    insert.run("young-running", now - 60 * 60 * 1000, generation("running"));
    insert.run("just-under", now - STALE_VIDEO_MS + 1, generation("running"));
    insert.run("old-done", now - STALE_VIDEO_MS - 60_000, generation("succeeded"));

    const { sql, params } = staleVideoFailure(now);
    const changed = db.prepare(sql).run(...params);
    assert.equal(changed.changes, 2);

    const rows = db.prepare("SELECT id, data FROM generations ORDER BY id").all() as { id: string; data: string }[];
    const byId = Object.fromEntries(rows.map((row) => [row.id, JSON.parse(row.data)]));

    assert.equal(STALE_VIDEO_ERROR, "Timed out after 2 hours. The provider never finished this job.");
    assert.equal(byId["old-running"].status, "failed");
    assert.equal(byId["old-running"].error, STALE_VIDEO_ERROR);
    assert.equal(byId["old-running"].completedAt, now);
    assert.equal(byId["old-queued"].status, "failed");
    assert.equal(byId["old-queued"].error, STALE_VIDEO_ERROR);

    assert.equal(byId["young-running"].status, "running");
    assert.equal(byId["young-running"].error, undefined);
    assert.equal(byId["just-under"].status, "running");
    assert.equal(byId["old-done"].status, "succeeded");

    for (const row of rows) {
      const error = JSON.parse(row.data).error;
      if (typeof error === "string") assert.equal(error.includes(KEY), false, row.id);
    }
    assert.equal(STALE_VIDEO_ERROR.includes(KEY), false);
  });
});
