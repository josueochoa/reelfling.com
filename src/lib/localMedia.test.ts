import assert from "node:assert/strict";
import path from "node:path";
import { after, describe, it } from "node:test";
import { localMediaPath, readLocal, removeLocal, writeLocal } from "./localMedia";

describe("local media paths", () => {
  it("rejects keys that leave the dev folder", () => {
    assert.throws(() => localMediaPath("user-1", "../secret.mp4"));
    assert.throws(() => localMediaPath("user-1", "/etc/passwd"));
    assert.throws(() => localMediaPath("../user", "videos/a.mp4"));
  });

  it("keeps a normal asset key under the user folder", () => {
    const full = localMediaPath("user-1", "videos/clip.mp4");
    assert.ok(full.endsWith(`${path.sep}user-1${path.sep}videos${path.sep}clip.mp4`));
  });
});

describe("local media range reads", () => {
  const userId = "range-user";
  const key = "videos/range.mp4";

  after(async () => {
    await removeLocal(userId, key).catch(() => {});
  });

  it("returns a byte range and the full length", async () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await writeLocal(userId, key, bytes);
    const part = await readLocal(userId, key, "bytes=2-5");
    assert.equal(part.status, 206);
    assert.equal(part.contentRange, "bytes 2-5/10");
    assert.equal(part.contentLength, "4");
    const body = new Uint8Array(await new Response(part.body).arrayBuffer());
    assert.deepEqual([...body], [2, 3, 4, 5]);
  });
});
