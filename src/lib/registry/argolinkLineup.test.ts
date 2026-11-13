// Kling 4.0, Wan 3.0 and Wan 3.0 Prime on ArgoLink. Limits are the ones published on
// https://argolink.io/en/models/kling-4.0, /wan-3 and /wan-3-prime.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GenerateRequest } from "../types";
import { estimateRouteCost, isVideo, modelsFor, videoRequestError } from "./index";
import { catalogModel } from "./generated";
import { referenceClipError } from "./refClips";

function video(id: string) {
  const model = catalogModel(id);
  if (!model || !isVideo(model)) throw new Error(`${id} isn't a video model`);
  return model;
}

const request = (model: string, extra: Partial<GenerateRequest> = {}): GenerateRequest => ({
  model,
  prompt: "A fox runs through snow",
  mode: "frames",
  ratio: "16:9",
  resolution: "720p",
  duration: 5,
  ...extra,
});

const urls = (count: number, ext: string) => Array.from({ length: count }, (_, i) => `https://x/${i}.${ext}`);

describe("Kling 4.0 and Wan 3.0 on ArgoLink", () => {
  const kling = video("kling-4.0");
  const wan = video("wan-3");
  const prime = video("wan-3-prime");

  it("are offered on the ArgoLink route only", () => {
    const ids = modelsFor("argolink").map((model) => model.id);
    for (const model of [kling, wan, prime]) {
      assert.ok(ids.includes(model.id), model.id);
      assert.deepEqual(model.routes.map((route) => `${route.provider}:${route.endpoint}`), [`argolink:${model.id}`]);
    }
  });

  it("Kling 4.0 takes frames, references and edits", () => {
    assert.equal(videoRequestError(kling, request(kling.id)), null);
    assert.equal(videoRequestError(kling, request(kling.id, { duration: 30, resolution: "1080p", ratio: "21:9" })), null);
    assert.match(videoRequestError(kling, request(kling.id, { duration: 2 }))!, /below Kling 4\.0's 3s limit/);
    assert.match(videoRequestError(kling, request(kling.id, { resolution: "480p" }))!, /Resolution 480p/);
    assert.match(videoRequestError(kling, request(kling.id, { ratio: "4:3" }))!, /Ratio 4:3/);
    assert.equal(
      videoRequestError(kling, request(kling.id, { ratio: "adaptive", firstFrame: "https://x/a.png", lastFrame: "https://x/b.png" })),
      null,
    );
    assert.equal(kling.capabilities.frames.adaptiveOnly, true);

    const refs = (extra: Partial<GenerateRequest>) => request(kling.id, { mode: "references", ...extra });
    assert.equal(videoRequestError(kling, refs({ referenceImages: urls(10, "png"), referenceVideos: urls(5, "mp4") })), null);
    assert.match(videoRequestError(kling, refs({ referenceImages: urls(11, "png") }))!, /up to 10 reference images/);
    assert.match(videoRequestError(kling, refs({ referenceVideos: urls(6, "mp4") }))!, /up to 5 reference videos/);
    assert.match(
      videoRequestError(kling, refs({ referenceImages: urls(1, "png"), referenceAudios: urls(1, "mp3") }))!,
      /up to 0 reference audio/,
    );
    assert.match(videoRequestError(kling, request(kling.id, { seed: 7 }))!, /doesn't take a seed/);

    const edit = (extra: Partial<GenerateRequest> = {}) =>
      request(kling.id, { mode: "edit", duration: 0, editVideo: "upload:uploads/clip.mp4", ...extra });
    assert.equal(videoRequestError(kling, edit({ referenceImages: urls(10, "png") })), null);
    assert.match(videoRequestError(kling, edit({ referenceImages: urls(11, "png") }))!, /up to 10 reference images/);
    assert.match(videoRequestError(kling, edit({ resolution: "480p" }))!, /Resolution 480p/);
  });

  it("Wan 3.0 takes frames, references with audio, a seed and edits", () => {
    assert.equal(videoRequestError(wan, request(wan.id, { duration: 2, resolution: "480p", ratio: "4:3", seed: 42 })), null);
    assert.equal(videoRequestError(wan, request(wan.id, { ratio: "adaptive", firstFrame: "https://x/a.png" })), null);
    const refs = (extra: Partial<GenerateRequest>) => request(wan.id, { mode: "references", ...extra });
    assert.equal(
      videoRequestError(
        wan,
        refs({ referenceImages: urls(10, "png"), referenceVideos: urls(5, "mp4"), referenceAudios: urls(5, "mp3") }),
      ),
      null,
    );
    assert.match(videoRequestError(wan, refs({ referenceAudios: urls(6, "mp3"), referenceImages: urls(1, "png") }))!, /up to 5/);
    assert.equal(
      videoRequestError(wan, request(wan.id, { mode: "edit", duration: 0, editVideo: "upload:uploads/clip.mp4" })),
      null,
    );
  });

  it("Wan 3.0 Prime takes text and references only, always with audio", () => {
    assert.equal(videoRequestError(prime, request(prime.id, { generateAudio: true })), null);
    assert.equal(prime.capabilities.audio, "required");
    assert.match(videoRequestError(prime, request(prime.id, { firstFrame: "https://x/a.png" }))!, /doesn't support a start frame/);
    assert.match(videoRequestError(prime, request(prime.id, { duration: 3 }))!, /below Wan 3\.0 Prime's 4s limit/);
    assert.match(videoRequestError(prime, request(prime.id, { ratio: "4:3" }))!, /Ratio 4:3/);
    assert.match(videoRequestError(prime, request(prime.id, { seed: 7 }))!, /doesn't take a seed/);
    assert.equal(
      videoRequestError(prime, request(prime.id, { mode: "references", referenceImages: urls(2, "png"), referenceAudios: urls(1, "mp3") })),
      null,
    );
    assert.equal(
      videoRequestError(prime, request(prime.id, { mode: "edit", duration: 0, editVideo: "upload:uploads/clip.mp4" })),
      "Wan 3.0 Prime can't edit a video",
    );
  });

  it("refuses reference clips the provider would reject for their length", () => {
    // Wan: 1–15 s per clip, 15 s per kind, and 30 s of output plus reference videos.
    assert.equal(referenceClipError(prime, { videos: [10], audios: [15], duration: 15 }), null);
    assert.match(referenceClipError(prime, { videos: [29.167], duration: 15 })!, /reference video is 29\.2 s long\. Wan 3\.0 Prime takes reference videos of 1–15 s/);
    assert.match(referenceClipError(wan, { audios: [29.167], duration: 5 })!, /reference audio clip is 29\.2 s long/);
    assert.match(referenceClipError(wan, { videos: [9, 9], duration: 5 })!, /add up to 18 s\. Wan 3\.0 takes 15 s/);
    assert.match(referenceClipError(wan, { videos: [12], duration: 20 })!, /is 32 s\. Wan 3\.0 takes 30 s in total/);
    assert.equal(referenceClipError(wan, { videos: [12], duration: 18 }), null);
    // Unread lengths are left to the provider.
    assert.equal(referenceClipError(wan, { videos: [undefined], audios: [undefined], duration: 30 }), null);
    // Kling: 3–30 s per video, 30 s together.
    assert.equal(referenceClipError(kling, { videos: [29.167], duration: 30 }), null);
    assert.match(referenceClipError(kling, { videos: [2] })!, /3–30 s/);
    assert.match(referenceClipError(kling, { videos: [20, 15] })!, /add up to 35 s/);
    // A model with no published clip limits is not checked.
    assert.equal(referenceClipError(video("seedance-2.5"), { videos: [29.167], duration: 30 }), null);
  });

  it("estimates the published per-second prices", () => {
    const cost = (id: string, input: Parameters<typeof estimateRouteCost>[2]) => estimateRouteCost(video(id), "argolink", input);
    assert.equal(cost("kling-4.0", { resolution: "720p", duration: 5 }), 0.7065);
    assert.equal(cost("kling-4.0", { resolution: "1080p", duration: 10 }), 2.115);
    // A reference video: the with-video rate, for at least twice the output.
    assert.equal(cost("kling-4.0", { resolution: "720p", duration: 5, referenceVideoSeconds: 2.4 }), 0.848);
    assert.equal(cost("kling-4.0", { resolution: "720p", duration: 5, referenceVideoSeconds: 8 }), 1.1024);
    assert.equal(cost("wan-3", { resolution: "480p", duration: 10 }), 0.325);
    assert.equal(cost("wan-3", { resolution: "720p", duration: 10 }), 0.65);
    // Output plus reference seconds, fractions dropped: 5 + 2.4 bills 7.
    assert.equal(cost("wan-3", { resolution: "720p", duration: 5, referenceVideoSeconds: 2.4 }), 0.455);
    assert.equal(cost("wan-3-prime", { resolution: "720p", duration: 5 }), 0.55);
    assert.equal(cost("wan-3-prime", { resolution: "1080p", duration: 5, referenceVideoSeconds: 2.4 }), 1.47);
  });
});
