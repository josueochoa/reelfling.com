import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GenerateRequest } from "./types";
import { catalogModel } from "./registry/generated";
import { estimateRouteCost, isVideo, mentionSyntax, videoRequestError } from "./registry";
import { normalizeMentions } from "./mentions";
import { editEstimateInput, editVideoError, editVideoLimits, nearestRatio } from "./videoEdit";

const MiB = 1024 * 1024;
const seedance = catalogModel("seedance-2.5");
assert.ok(seedance && isVideo(seedance));

function video(id: string) {
  const model = catalogModel(id);
  if (!model || !isVideo(model)) throw new Error(`${id} isn't a video model`);
  return model;
}

describe("the video to edit", () => {
  it("takes an MP4 or MOV of 4–30 s and up to 100 MiB", () => {
    const limits = seedance.capabilities.edit!.seconds;
    const check = (file: Parameters<typeof editVideoError>[0]) => editVideoError(file, limits);
    assert.equal(check({ contentType: "video/mp4", bytes: 20 * MiB, duration: 5 }), null);
    assert.equal(check({ contentType: "video/quicktime", bytes: 100 * MiB, duration: 30 }), null);
    assert.match(check({ contentType: "video/webm", bytes: MiB, duration: 5 })!, /MP4 or MOV/);
    assert.match(check({ contentType: "video/mp4", bytes: 100 * MiB + 1, duration: 5 })!, /100\.0 MiB/);
    assert.match(check({ contentType: "video/mp4", bytes: MiB, duration: 3.6 })!, /3\.6 s long\. It must be 4–30 s/);
    assert.match(check({ contentType: "video/mp4", bytes: MiB, duration: 31 })!, /4–30 s/);
    assert.match(check({ contentType: "video/mp4", bytes: MiB })!, /Couldn't read/);
    assert.equal(editVideoLimits(limits), "MP4 or MOV · 4–30 s · 100 MiB");
  });

  it("uses each model's own length limits", () => {
    const clip = (duration: number) => ({ contentType: "video/mp4", bytes: MiB, duration });
    const kling = video("kling-4.0").capabilities.edit!.seconds;
    const wan = video("wan-3").capabilities.edit!.seconds;
    assert.equal(editVideoError(clip(3), kling), null);
    assert.equal(editVideoError(clip(30), kling), null);
    assert.match(editVideoError(clip(2.9), kling)!, /3–30 s/);
    assert.equal(editVideoError(clip(1), wan), null);
    assert.equal(editVideoError(clip(15), wan), null);
    assert.match(editVideoError(clip(15.5), wan)!, /1–15 s/);
    assert.equal(editVideoLimits(wan), "MP4 or MOV · 1–15 s · 100 MiB");
    assert.equal(video("wan-3-prime").capabilities.edit, undefined);
  });

  it("bills a Kling 4.0 or Wan 3.0 edit as twice its length", () => {
    const cost = (id: string, resolution: string, seconds: number) =>
      estimateRouteCost(video(id), "argolink", editEstimateInput(resolution, seconds));
    // Kling: the with-video rate. Wan: one rate either way.
    assert.equal(cost("kling-4.0", "720p", 5), 0.848);
    assert.equal(cost("kling-4.0", "1080p", 5), 1.27);
    assert.equal(cost("wan-3", "720p", 5), 0.65);
    assert.equal(cost("wan-3", "1080p", 10), 2.6);
  });

  it("is billed as twice its length at the with-video rate", () => {
    const cost = (resolution: string, seconds: number) =>
      estimateRouteCost(seedance, "argolink", editEstimateInput(resolution, seconds));
    assert.equal(cost("480p", 5), 0.523);
    assert.equal(cost("720p", 5), 1.17);
    assert.equal(cost("1080p", 5), 2.89);
    assert.equal(cost("720p", 4.5), 1.053);
  });

  it("records the nearest listed ratio for the card", () => {
    assert.equal(nearestRatio(["adaptive", "16:9", "9:16", "1:1"], 1920, 1080), "16:9");
    assert.equal(nearestRatio(["adaptive", "16:9", "9:16", "1:1"], 720, 1280), "9:16");
    assert.equal(nearestRatio(["16:9", "1:1"]), "16:9");
  });
});

describe("edit requests", () => {
  const edit = (extra: Partial<GenerateRequest> = {}): GenerateRequest => ({
    model: "seedance-2.5",
    prompt: "Edit the video: make it snow",
    mode: "edit",
    ratio: "16:9",
    resolution: "720p",
    duration: 0,
    editVideo: "upload:uploads/clip.mp4",
    ...extra,
  });

  it("needs the video and a prompt, and skips duration and ratio checks", () => {
    assert.equal(videoRequestError(seedance, edit()), null);
    assert.equal(videoRequestError(seedance, edit({ ratio: "nonsense", duration: 2.5 })), null);
    assert.equal(videoRequestError(seedance, edit({ editVideo: undefined })), "Add the video to edit");
    assert.equal(videoRequestError(seedance, edit({ prompt: " " })), "Describe the edit in the prompt");
    assert.match(videoRequestError(seedance, edit({ resolution: "4k" }))!, /Resolution 4k/);
    assert.match(
      videoRequestError(seedance, edit({ referenceImages: Array(31).fill("https://x/a.png") }))!,
      /up to 30 reference images/,
    );
    assert.match(videoRequestError(seedance, edit({ referenceVideos: ["https://x/b.mp4"] }))!, /one video/);
  });

  it("rewrites @video1 and @image1 into ArgoLink's @Video 1 and @Image 1", () => {
    assert.equal(
      normalizeMentions("Edit the video: @video1 in snow like @image1 and @Imagen 2", mentionSyntax(seedance.refSyntax)),
      "Edit the video: @Video 1 in snow like @Image 1 and @Image 2",
    );
  });

  it("is refused by a model that can't edit", () => {
    const other = catalogModel("seedance-2.0");
    assert.ok(other && isVideo(other));
    assert.equal(videoRequestError(other, edit({ model: other.id })), "Seedance 2.0 can't edit a video");
  });
});
