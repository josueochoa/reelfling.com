import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { candidateUserIds, referencedKeySet, restoreInputs, withoutReferenced } from "./inputs";
import type { Generation } from "./types";

const counts = { firstFrame: false, lastFrame: false, images: 0, videos: 0, audios: 0 };

function gen(partial: Pick<Generation, "mode" | "prompt" | "inputs">): Pick<Generation, "mode" | "prompt" | "inputs"> {
  return partial;
}

describe("restoreInputs", () => {
  it("restores reference blocks in order and leaves @mentions untouched", () => {
    const prompt = "The cat from @Image 1 dances on @Image 2 while @Video 1 plays";
    const restored = restoreInputs(
      gen({
        mode: "references",
        prompt,
        inputs: {
          ...counts,
          images: 2,
          videos: 1,
          blocks: [
            { kind: "image", key: "uploads/cat.jpg", name: "cat.png" },
            { kind: "video", key: "uploads/clip.mp4", name: "clip.mp4" },
            { kind: "image", key: "uploads/roof.jpg", name: "roof.png" },
          ],
        },
      }),
      new Set(["uploads/cat.jpg", "uploads/clip.mp4", "uploads/roof.jpg"]),
    );
    assert.equal(restored.mode, "references");
    assert.equal(restored.prompt, prompt);
    assert.deepEqual(restored.referenceKeys, ["uploads/cat.jpg", "uploads/clip.mp4", "uploads/roof.jpg"]);
    assert.equal(restored.notice, undefined);
    assert.equal(restored.firstFrameKey, undefined);
  });

  it("restores start and end frames", () => {
    const restored = restoreInputs(
      gen({
        mode: "frames",
        prompt: "A dolly in",
        inputs: {
          ...counts,
          firstFrame: true,
          lastFrame: true,
          firstFrameKey: "uploads/start.jpg",
          firstFrameName: "start.png",
          lastFrameKey: "uploads/end.jpg",
          lastFrameName: "end.png",
        },
      }),
      new Set(["uploads/start.jpg", "uploads/end.jpg"]),
    );
    assert.equal(restored.mode, "frames");
    assert.equal(restored.prompt, "A dolly in");
    assert.equal(restored.firstFrameKey, "uploads/start.jpg");
    assert.equal(restored.lastFrameKey, "uploads/end.jpg");
    assert.deepEqual(restored.referenceKeys, []);
    assert.equal(restored.notice, undefined);
  });

  it("restores middle keyframes that are still in the library and names the ones that are gone", () => {
    const restored = restoreInputs(
      gen({
        mode: "frames",
        prompt: "Hold the middle",
        inputs: {
          ...counts,
          firstFrame: true,
          lastFrame: true,
          firstFrameKey: "uploads/start.jpg",
          firstFrameName: "start.png",
          lastFrameKey: "uploads/end.jpg",
          lastFrameName: "end.png",
          middleFrames: [
            { kind: "image", key: "uploads/mid.jpg", name: "mid.png" },
            { kind: "image", key: "uploads/gone.jpg", name: "gone.png" },
          ],
        },
      }),
      new Set(["uploads/start.jpg", "uploads/end.jpg", "uploads/mid.jpg"]),
    );
    assert.deepEqual(restored.middleFrameKeys, ["uploads/mid.jpg"]);
    assert.match(restored.notice ?? "", /Keyframe "gone.png"/);
    const referenced = referencedKeySet([
      {
        userId: "u1",
        data: JSON.stringify({
          inputs: { middleFrames: [{ kind: "image", key: "uploads/mid.jpg" }] },
        }),
      },
    ]);
    assert.equal(referenced.has("u1\0uploads/mid.jpg"), true);
  });

  it("names a deleted upload, restores the rest, and keeps the surviving mention pointed at the same file", () => {
    const restored = restoreInputs(
      gen({
        mode: "references",
        prompt: "Cut from @Image 1 to @Image 2 with @Audio 1",
        inputs: {
          ...counts,
          images: 2,
          audios: 1,
          blocks: [
            { kind: "image", key: "uploads/gone.jpg", name: "lobby.png" },
            { kind: "audio", key: "uploads/room.mp3", name: "room.mp3" },
            { kind: "image", key: "uploads/kept.jpg", name: "street.png" },
          ],
        },
      }),
      new Set(["uploads/room.mp3", "uploads/kept.jpg"]),
    );
    assert.deepEqual(restored.referenceKeys, ["uploads/room.mp3", "uploads/kept.jpg"]);
    // @Image 1 was deleted, so the surviving image keeps its identity as @Image 1.
    assert.equal(restored.prompt, "Cut from @Image ? to @Image 1 with @Audio 1");
    assert.equal(
      restored.notice,
      '@Image 1 (lobby.png) is no longer in your uploads. Everything else was restored.',
    );
  });

  it("names a missing frame and still restores the other one", () => {
    const restored = restoreInputs(
      gen({
        mode: "frames",
        prompt: "Hold",
        inputs: {
          ...counts,
          firstFrame: true,
          lastFrame: true,
          firstFrameKey: "uploads/start.jpg",
          firstFrameName: "open.png",
          lastFrameKey: "uploads/end.jpg",
          lastFrameName: "close.png",
        },
      }),
      new Set(["uploads/start.jpg"]),
    );
    assert.equal(restored.firstFrameKey, "uploads/start.jpg");
    assert.equal(restored.lastFrameKey, undefined);
    assert.equal(restored.prompt, "Hold");
    assert.equal(
      restored.notice,
      'End frame "close.png" is no longer in your uploads. Everything else was restored.',
    );
  });

  it("lists every missing input when more than one is gone", () => {
    const restored = restoreInputs(
      gen({
        mode: "frames",
        prompt: "Hold",
        inputs: {
          ...counts,
          firstFrame: true,
          lastFrame: true,
          firstFrameKey: "uploads/start.jpg",
          firstFrameName: "open.png",
          lastFrameKey: "uploads/end.jpg",
          lastFrameName: "close.png",
        },
      }),
      new Set(),
    );
    assert.equal(restored.firstFrameKey, undefined);
    assert.equal(restored.lastFrameKey, undefined);
    assert.equal(
      restored.notice,
      'Start frame "open.png" and End frame "close.png" are no longer in your uploads. Everything else was restored.',
    );
  });

  it("restores prompt and settings inputs for old count-only generations without inventing a missing file", () => {
    const prompt = "Neon ramen, @Image 1";
    const restored = restoreInputs(
      gen({
        mode: "references",
        prompt,
        inputs: { firstFrame: true, lastFrame: false, images: 2, videos: 1, audios: 0 },
      }),
      new Set(),
    );
    assert.equal(restored.prompt, prompt);
    assert.equal(restored.mode, "references");
    assert.deepEqual(restored.referenceKeys, []);
    assert.equal(restored.firstFrameKey, undefined);
    assert.equal(restored.notice, undefined);
  });
});

describe("orphan sweep exclusion", () => {
  const records = [
    {
      userId: "u1",
      data: JSON.stringify({
        inputs: {
          firstFrameKey: "refs/start.jpg",
          lastFrameKey: "refs/end.jpg",
          blocks: [
            { kind: "image", key: "refs/block-a.jpg" },
            { kind: "video", key: "refs/block-b.mp4" },
          ],
        },
      }),
    },
    { userId: "u1", data: JSON.stringify({ references: ["refs/image-ref.png", "uploads/library.jpg"] }) },
    { userId: "u1", data: "not json" },
    { userId: "u2", data: JSON.stringify({ inputs: { images: 3 } }) },
  ];

  it("never selects media referenced by a saved generation, including legacy refs/ keys", () => {
    const referenced = referencedKeySet(records);
    const rows = [
      { user_id: "u1", key: "refs/start.jpg" },
      { user_id: "u1", key: "refs/end.jpg" },
      { user_id: "u1", key: "refs/block-a.jpg" },
      { user_id: "u1", key: "refs/block-b.mp4" },
      { user_id: "u1", key: "refs/image-ref.png" },
      { user_id: "u1", key: "refs/orphan.jpg" },
      // Same key, different user: that user never referenced it.
      { user_id: "u2", key: "refs/start.jpg" },
      { user_id: "u1", key: "uploads/library.jpg" },
    ];
    const doomed = withoutReferenced(rows, referenced);
    assert.deepEqual(
      doomed.map((r) => `${r.user_id}:${r.key}`),
      ["u1:refs/orphan.jpg", "u2:refs/start.jpg"],
    );
  });

  it("only needs the generations of users who have a candidate on this page", () => {
    const candidates = [
      { user_id: "u1", key: "refs/keep.jpg" },
      { user_id: "u1", key: "refs/drop.jpg" },
    ];
    const users = new Set(candidateUserIds(candidates));
    assert.deepEqual([...users], ["u1"]);
    // u9 references the same key string, but that row is not loaded: it isn't this user's file.
    const records = [
      { userId: "u1", data: JSON.stringify({ inputs: { firstFrameKey: "refs/keep.jpg" } }) },
      { userId: "u9", data: JSON.stringify({ inputs: { blocks: [{ key: "refs/drop.jpg", kind: "image" }] } }) },
    ].filter((r) => users.has(r.userId));
    assert.deepEqual(
      withoutReferenced(candidates, referencedKeySet(records)).map((r) => r.key),
      ["refs/drop.jpg"],
    );
  });

  it("does not protect a file just because an old generation counted it", () => {
    const referenced = referencedKeySet([{ userId: "u1", data: JSON.stringify({ inputs: { images: 2, firstFrame: true } }) }]);
    const rows = [{ user_id: "u1", key: "refs/old.jpg" }];
    assert.deepEqual(withoutReferenced(rows, referenced), rows);
  });
});
