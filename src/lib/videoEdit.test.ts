import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GenerateRequest } from "./types";
import { catalogModel } from "./registry/generated";
import { estimateRouteCost, isVideo, mentionSyntax, videoRequestError } from "./registry";
import { normalizeMentions } from "./mentions";
import { editEstimateInput, editVideoError, nearestRatio } from "./videoEdit";

const MiB = 1024 * 1024;
const seedance = catalogModel("seedance-2.5");
assert.ok(seedance && isVideo(seedance));

describe("the video to edit", () => {
  it("takes an MP4 or MOV of 4–30 s and up to 100 MiB", () => {
    assert.equal(editVideoError({ contentType: "video/mp4", bytes: 20 * MiB, duration: 5 }), null);
    assert.equal(editVideoError({ contentType: "video/quicktime", bytes: 100 * MiB, duration: 30 }), null);
    assert.match(editVideoError({ contentType: "video/webm", bytes: MiB, duration: 5 })!, /MP4 or MOV/);
    assert.match(editVideoError({ contentType: "video/mp4", bytes: 100 * MiB + 1, duration: 5 })!, /100\.0 MiB/);
    assert.match(editVideoError({ contentType: "video/mp4", bytes: MiB, duration: 3.6 })!, /3\.6 s long\. It must be 4–30 s/);
    assert.match(editVideoError({ contentType: "video/mp4", bytes: MiB, duration: 31 })!, /4–30 s/);
    assert.match(editVideoError({ contentType: "video/mp4", bytes: MiB })!, /Couldn't read/);
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
