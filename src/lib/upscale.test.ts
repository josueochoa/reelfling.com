import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { catalogModel } from "./registry/generated";
import { buildToolBody, formFor, toolLimitError } from "./registry/tool-forms";
import { publicTools } from "./toolCatalog";
import { formatUpscaleCost, planBulkToolJobs, upscaleCost, upscaleResolution } from "./upscaleQuote";

const REF = "upload:uploads/clip.mp4";

function body(id: string, params: Record<string, unknown> = {}) {
  const form = formFor(id);
  assert.ok(form, id);
  return buildToolBody(form, params, REF);
}

describe("upscale request mapping", () => {
  it("maps each endpoint's target onto that endpoint's real fields", () => {
    assert.deepEqual(body("fal:fal-ai/seedvr/upscale/video", { target: "2x" }), {
      upscale_mode: "factor",
      upscale_factor: 2,
      video_url: REF,
    });
    assert.deepEqual(body("fal:fal-ai/seedvr/upscale/video", { target: "4x" }), {
      upscale_mode: "factor",
      upscale_factor: 4,
      video_url: REF,
    });
    assert.deepEqual(body("fal:fal-ai/seedvr/upscale/video", { target: "1080p" }), {
      upscale_mode: "target",
      target_resolution: "1080p",
      video_url: REF,
    });
    assert.deepEqual(body("fal:fal-ai/seedvr/upscale/video", { target: "4K" }), {
      upscale_mode: "target",
      target_resolution: "2160p",
      video_url: REF,
    });
    assert.deepEqual(body("fal:fal-ai/seedvr/upscale/image", { target: "4K" }), {
      upscale_mode: "target",
      target_resolution: "2160p",
      image_url: REF,
    });
    assert.deepEqual(body("fal:fal-ai/flashvsr/upscale/video", { target: "2x" }), {
      upscale_factor: 2,
      video_url: REF,
    });
    assert.deepEqual(body("fal:fal-ai/flashvsr/upscale/video", { target: "4x" }), {
      upscale_factor: 4,
      video_url: REF,
    });
    assert.deepEqual(body("fal:topaz/upscale/video/precision", { target: "4x" }), {
      model: "Proteus",
      upscale_factor: 4,
      video_url: REF,
    });
    assert.deepEqual(body("fal:topaz/upscale/video/precision", { target: "2x", model: "Gaia 2" }), {
      model: "Gaia 2",
      upscale_factor: 2,
      video_url: REF,
    });
    assert.deepEqual(body("fal:topaz/upscale/image/precision", { target: "2x", model: "Faces" }), {
      model: "Faces",
      upscale_factor: 2,
      image_url: REF,
    });
    assert.deepEqual(body("fal:fal-ai/recraft/upscale/crisp"), { image_url: REF });
    assert.throws(() => body("fal:fal-ai/flashvsr/upscale/video", { target: "1080p" }), /isn't one of the listed choices/);
    assert.throws(() => body("fal:fal-ai/recraft/upscale/crisp", { target: "2x" }), /Unknown tool setting/);
    assert.throws(() => body("fal:fal-ai/seedvr/upscale/video", { sync_mode: true }), /Unknown tool setting/);
  });

  it("owns the upscale catalog entries as tools", () => {
    for (const id of [
      "fal:fal-ai/seedvr/upscale/video",
      "fal:fal-ai/flashvsr/upscale/video",
      "fal:topaz/upscale/video/precision",
      "fal:fal-ai/seedvr/upscale/image",
      "fal:topaz/upscale/image/precision",
      "fal:fal-ai/recraft/upscale/crisp",
    ]) {
      const model = catalogModel(id);
      assert.equal(model?.group, "tool", id);
      assert.equal(model?.routes[0]?.mapper, "fal.queue", id);
      assert.ok(formFor(id), id);
    }
    const seedvr = catalogModel("fal:fal-ai/seedvr/upscale/video");
    assert.equal(seedvr?.group, "tool");
    if (seedvr?.group === "tool") assert.equal(seedvr.capabilities.accepts, "video");
    assert.equal(publicTools().some((tool) => "endpoint" in tool), false);
  });
});

describe("upscale limits", () => {
  it("names the limit and allows an input on the limit", () => {
    const topaz = formFor("fal:topaz/upscale/video/precision");
    const recraft = formFor("fal:fal-ai/recraft/upscale/crisp");
    assert.ok(topaz && recraft);
    assert.match(toolLimitError(topaz, { contentType: "video/mp4", duration: 301 }, "Topaz Precision") ?? "", /5 minutes/);
    assert.equal(toolLimitError(topaz, { contentType: "video/mp4", duration: 300 }, "Topaz Precision"), undefined);
    assert.equal(toolLimitError(topaz, { contentType: "video/mp4" }, "Topaz Precision"), undefined);
    assert.match(toolLimitError(recraft, { contentType: "image/jpeg" }, "Recraft Crisp") ?? "", /PNG/);
    assert.equal(toolLimitError(recraft, { contentType: "image/png" }, "Recraft Crisp"), undefined);
  });
});

describe("upscale cost", () => {
  it("uses fal's published image formulas from width and height", () => {
    const image = formFor("fal:fal-ai/seedvr/upscale/image")!.quote;
    const topazImage = formFor("fal:topaz/upscale/image/precision")!.quote;
    const recraft = formFor("fal:fal-ai/recraft/upscale/crisp")!.quote;
    assert.equal(upscaleCost(image, { width: 1000, height: 1000, target: "2x" }), 0.004);
    assert.equal(formatUpscaleCost(0.004), "$0.004");
    assert.equal(upscaleCost(topazImage, { width: 3000, height: 2000, target: "2x" }), 0.08);
    assert.equal(upscaleCost(topazImage, { width: 3001, height: 2000, target: "2x" }), 0.16);
    assert.equal(upscaleCost(recraft, {}), 0.004);
    assert.equal(upscaleCost(image, { width: 5000, height: 2500, target: "2x" }), 0.05);
  });

  it("shows no video number when the published price is per frame", () => {
    assert.equal(formFor("fal:fal-ai/seedvr/upscale/video")?.quote, undefined);
    assert.equal(formFor("fal:fal-ai/flashvsr/upscale/video")?.quote, undefined);
    assert.equal(formFor("fal:topaz/upscale/video/precision")?.quote, undefined);
    assert.equal(upscaleCost(undefined, { width: 1280, height: 720, target: "2x" }), undefined);
  });
});

describe("upscale output resolution", () => {
  it("prefers measured pixels, then the scale, then the named target", () => {
    assert.deepEqual(upscaleResolution({ upscale_factor: 2 }, { width: 960, height: 540 }), {
      width: 1920,
      height: 1080,
      resolution: "1920×1080",
    });
    assert.deepEqual(upscaleResolution({ upscale_factor: 2 }, { width: 960, height: 540 }, { width: 100, height: 80 }), {
      width: 100,
      height: 80,
      resolution: "100×80",
    });
    assert.deepEqual(upscaleResolution({ target_resolution: "2160p" }), { resolution: "4K" });
    assert.deepEqual(upscaleResolution({ target_resolution: "1080p" }), { resolution: "1080p" });
    assert.deepEqual(upscaleResolution({ upscale_factor: 4 }), { resolution: "4×" });
  });
});

describe("bulk upscale jobs", () => {
  it("plans one job per asset and rejects a mixed selection", () => {
    const params = { target: "2x" };
    const jobs = planBulkToolJobs(
      [
        { key: "uploads/a.png", kind: "image" },
        { key: "uploads/b.png", kind: "image" },
        { key: "uploads/c.png", kind: "image" },
      ],
      { id: "fal:fal-ai/seedvr/upscale/image", accepts: "image" },
      params,
    );
    assert.equal(jobs.length, 3);
    assert.deepEqual(
      jobs.map((job) => job.assetIds[0]),
      ["uploads/a.png", "uploads/b.png", "uploads/c.png"],
    );
    assert.equal(jobs.every((job) => job.assetIds.length === 1 && job.toolId === "fal:fal-ai/seedvr/upscale/image"), true);
    jobs[0].params.target = "4x";
    assert.equal(params.target, "2x");
    assert.equal(jobs[1].params.target, "2x");
    assert.throws(
      () =>
        planBulkToolJobs(
          [
            { key: "uploads/a.png", kind: "image" },
            { key: "uploads/b.mp4", kind: "video" },
          ],
          { id: "fal:fal-ai/seedvr/upscale/image", accepts: "image" },
          params,
        ),
      /images only/,
    );
    assert.throws(() => planBulkToolJobs([], { id: "x", accepts: "image" }, {}), /at least one/);
  });
});
