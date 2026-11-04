import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildExtendBody, extendForm, extendOffers, runnableExtends } from "./extend";
import { LAST_FRAME_EPSILON_S, lastFrameTime } from "./lastFrame";
import { buildArgoVideoBody } from "./providers/argolink";
import { falQueueInput } from "./providers/fal";
import { buildOpenRouterVideo } from "./providers/openrouter";
import { buildModelArkVideo } from "./registry/bodies";
import { ALL_MODELS } from "./registry/generated";
import { toolLimitError } from "./registry/tool-forms";
import { isVideo } from "./registry/types";
import { groupFeed, isNumberedSequence } from "./sequence";
import type { GenerateRequest } from "./types";

const FRAME = "https://cdn.example/frame.jpg";
const FRAME_KEY = "uploads/frame.jpg";

/** Listed by the catalog, but OpenAPI expansion failed or the id 404'd, so they are not offered. */
const DROPPED = [
  "google/gemini-omni/extend-video",
  "google/gemini-omni-1.1-flash/extend-video",
  "google/gemini-omni-flash/v1.1/extend-video",
  "google/gemini-omni-flash/extend-video",
  "google/gemini-omni-flash/v1/extend-video",
  "fal-ai/gemini-omni-flash/extend-video",
];

const KEPT = [
  "blackforestlabs/flux-3/extend-video",
  "google/gemini-omni-flash/v1.1/extend",
  "minimax/h3-max/extend-video",
  "xai/grok-imagine-video/extend-video",
];

describe("continue from last frame", () => {
  it("sends the uploaded frame as the start frame on every route", async () => {
    // The shape ControlPanel submits: one upload key, on whichever route is selected.
    const request: GenerateRequest = {
      model: "seedance-2.5",
      prompt: "keep going",
      mode: "frames",
      ratio: "16:9",
      resolution: "720p",
      duration: 5,
      route: "argolink",
      firstFrame: `upload:${FRAME_KEY}`,
      continueFrom: "gen-1",
    };
    assert.equal(request.firstFrame, `upload:${FRAME_KEY}`);
    for (const key of ["start_image", "frame_images", "image_url", "video_url", "content"]) {
      assert.equal(key in request, false, key);
    }

    const shared = { ...request, firstFrame: FRAME };
    const ark = buildModelArkVideo({ ...shared, model: "dreamina-seedance-2-0-260128" });
    assert.deepEqual(
      ark.content.find((item) => item.type === "image_url"),
      { type: "image_url", image_url: { url: FRAME }, role: "first_frame" },
    );

    const argo = await buildArgoVideoBody({ apiKey: "argo-test-key" }, shared);
    assert.deepEqual(argo.start_image, { url: FRAME });
    assert.equal(JSON.stringify(argo).includes("argo-test-key"), false);

    const openrouter = buildOpenRouterVideo(shared, "bytedance/seedance-2.5");
    assert.deepEqual(openrouter.frame_images, [
      { type: "image_url", image_url: { url: FRAME }, frame_type: "first_frame" },
    ]);

    const falModels = ALL_MODELS.filter(isVideo).filter(
      (model) => model.capabilities.frames.start && model.routes.some((route) => route.provider === "fal"),
    );
    assert.ok(falModels.length > 3);
    for (const model of falModels) {
      const body = falQueueInput(
        {
          prompt: "keep going",
          firstFrame: FRAME,
          duration: model.capabilities.durations?.default ?? 5,
          ratio: "16:9",
          resolution: model.capabilities.resolutions[0] ?? "720p",
        },
        model.inputs,
      );
      // Flux keyframes has no start field. The uploaded frame is the first keyframe.
      if (model.inputs?.keyframeShape === "objects" && model.inputs.keyframes) {
        const frames = body[model.inputs.keyframes] as { image_url: string }[];
        assert.equal(frames[0]?.image_url, FRAME, model.id);
        assert.equal(body.image_url, undefined, model.id);
        assert.equal(body.start_image_url, undefined, model.id);
      } else {
        const field = model.inputs?.start ?? "image_url";
        assert.equal(body[field], FRAME, model.id);
      }
    }
  });

  it("seeks just before the end so the canvas is not a blank frame", () => {
    assert.equal(lastFrameTime(2), 2 - LAST_FRAME_EPSILON_S);
    assert.equal(lastFrameTime(0.02), 0.01);
    assert.equal(lastFrameTime(0), 0);
    assert.equal(lastFrameTime(Number.NaN), 0);
  });
});

describe("native extend", () => {
  it("sends the source clip on the endpoints whose schema was verified", () => {
    assert.deepEqual(
      runnableExtends().map((tool) => tool.endpoint).sort(),
      [...KEPT].sort(),
    );
    for (const endpoint of DROPPED) {
      assert.equal(
        runnableExtends().some((tool) => tool.endpoint === endpoint),
        false,
        endpoint,
      );
    }
    for (const tool of runnableExtends()) {
      const body = buildExtendBody(tool.id, "videos/clip.mp4", { prompt: "  Continue the scene. " });
      assert.deepEqual(body, { prompt: "Continue the scene.", video_url: "upload:videos/clip.mp4" });
    }
    assert.throws(() => buildExtendBody(runnableExtends()[0].id, "videos/clip.mp4", { prompt: "  " }), /what happens next/);
    const grok = extendForm("fal:xai/grok-imagine-video/extend-video");
    assert.ok(grok);
    assert.match(toolLimitError(grok, { contentType: "video/mp4", duration: 16 }, "Grok Imagine Extend") ?? "", /16s/);
  });

  it("offers extend only on the matching model families", () => {
    const offers = extendOffers();
    const ids = (suffix: string) => offers.find((offer) => offer.id.endsWith(suffix))?.modelIds ?? [];
    assert.ok(ids("grok-imagine-video/extend-video").includes("fal:xai/grok-imagine-video/v1.5/image-to-video"));
    assert.ok(ids("minimax/h3-max/extend-video").includes("fal:minimax/h3/image-to-video"));
    assert.ok(ids("flux-3/extend-video").includes("fal:blackforestlabs/flux-3/image-to-video"));
    assert.ok(ids("gemini-omni-flash/v1.1/extend").includes("fal:google/gemini-omni-flash/v1.1/image-to-video"));
    assert.equal(offers.some((offer) => offer.modelIds.includes("seedance-2.5")), false);
    assert.equal(offers.some((offer) => offer.modelIds.includes("dreamina-seedance-2-0-260128")), false);
  });
});

describe("sequence grouping", () => {
  it("numbers parts and keeps an unrelated clip on its own", () => {
    const groups = groupFeed([
      { id: "a", sequenceId: "a", part: 1, createdAt: 1 },
      { id: "job", sequenceId: "a", part: 2, createdAt: 5 },
      { id: "z", createdAt: 3 },
    ]);
    assert.equal(groups[0].id, "a");
    assert.deepEqual(
      groups[0].parts.map((part) => part.part),
      [1, 2],
    );
    assert.equal(isNumberedSequence(groups[0].parts), true);
    assert.equal(groups[1].id, "z");
    assert.equal(isNumberedSequence(groups[1].parts), false);
  });
});

describe("extend client boundary", () => {
  it("does not import the extend catalog into client components", () => {
    const files = walk("src/components").filter((file) => file.endsWith(".tsx") || file.endsWith(".ts"));
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (!text.includes("use client")) continue;
      assert.equal(text.includes("lib/extend"), false, file);
      assert.equal(text.includes("catalog/extend"), false, file);
    }
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
