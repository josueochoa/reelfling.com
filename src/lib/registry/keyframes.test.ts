import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { falModel } from "../../../scripts/catalog-map.mjs";
import { buildArgoVideoBody } from "../providers/argolink";
import { falQueueInput, keyframeIndexes } from "../providers/fal";
import { buildOpenRouterVideo } from "../providers/openrouter";
import type { GenerateRequest } from "../types";
import { ALL_MODELS } from "./generated";
import { buildModelArkVideo } from "./bodies";
import { ratioForStartFrame } from "./frames";
import { isVideo, MODELS, videoRequestError } from "./index";
import type { VideoModel } from "./types";

const start = "https://cdn.example/start.jpg";
const mid = "https://cdn.example/mid.jpg";
const end = "https://cdn.example/end.jpg";

function video(endpoint: string): VideoModel {
  const model = ALL_MODELS.find(
    (item) => isVideo(item) && item.routes.some((route) => route.endpoint === endpoint),
  );
  assert.ok(model && isVideo(model), endpoint);
  return model;
}

function request(model: VideoModel, extra: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    model: model.id,
    prompt: "walk",
    mode: "frames",
    ratio: "16:9",
    resolution: model.capabilities.resolutions.includes("720p") ? "720p" : (model.capabilities.resolutions[0] ?? "720p"),
    duration: model.capabilities.durations?.default ?? 5,
    firstFrame: start,
    ...extra,
  };
}

describe("keyframe mapping", () => {
  it("maps frames onto each family's published fields", async () => {
    const kling = falQueueInput(
      { prompt: "walk", duration: 5, firstFrame: start, middleFrames: [mid], lastFrame: end },
      video("kling/v4/image-to-video").inputs,
    );
    assert.equal(kling.start_image_url, start);
    assert.deepEqual(kling.middle_image_urls, [mid]);
    assert.equal(kling.end_image_url, end);
    assert.equal(kling.keyframes, undefined);

    const wan = falQueueInput(
      { prompt: "walk", duration: 5, firstFrame: start, middleFrames: [mid], lastFrame: end },
      video("alibaba/wan-3.0/image-to-video").inputs,
    );
    assert.equal(wan.start_image_url, start);
    assert.equal(wan.end_image_url, end);
    assert.equal(wan.middle_image_urls, undefined);
    assert.equal(wan.keyframes, undefined);

    const flux = falQueueInput(
      { prompt: "walk", duration: 5, firstFrame: start, middleFrames: [mid], lastFrame: end },
      video("blackforestlabs/flux-3/keyframes-to-video").inputs,
    );
    assert.deepEqual(flux.keyframes, [
      { image_url: start, frame_index: 0 },
      { image_url: mid, frame_index: 60 },
      { image_url: end, frame_index: 120 },
    ]);
    assert.equal(flux.image_url, undefined);
    assert.equal(flux.end_image_url, undefined);

    const fluxStill = falQueueInput(
      { prompt: "walk", duration: 5, firstFrame: start, middleFrames: [mid], lastFrame: end },
      video("blackforestlabs/flux-3/image-to-video").inputs,
    );
    assert.equal(fluxStill.image_url, start);
    assert.equal(fluxStill.end_image_url, undefined);
    assert.equal(fluxStill.keyframes, undefined);
    assert.equal(fluxStill.middle_image_urls, undefined);

    const minimax = falQueueInput(
      { prompt: "walk", duration: 5, firstFrame: start, lastFrame: end, middleFrames: [mid] },
      video("minimax/h3/image-to-video").inputs,
    );
    assert.equal(minimax.image_url, start);
    assert.equal(minimax.end_image_url, end);
    assert.equal(minimax.middle_image_urls, undefined);

    const gemini = falQueueInput(
      { prompt: "walk", duration: 5, firstFrame: start, lastFrame: end, middleFrames: [mid] },
      video("google/gemini-omni-flash/v1.1/image-to-video").inputs,
    );
    assert.equal(gemini.image_url, start);
    assert.equal(gemini.end_image_url, end);
    assert.equal(gemini.keyframes, undefined);

    const grok = falQueueInput(
      { prompt: "walk", duration: 6, firstFrame: start, lastFrame: end, middleFrames: [mid] },
      video("xai/grok-imagine-video/v1.5/image-to-video").inputs,
    );
    assert.equal(grok.image_url, start);
    assert.equal(grok.end_image_url, undefined);
    assert.equal(grok.keyframes, undefined);

    const lumaPair = falQueueInput(
      { prompt: "walk", duration: 5, firstFrame: start, lastFrame: end },
      video("luma/agent/ray/v3.2/image-to-video").inputs,
    );
    assert.equal(lumaPair.image_url, start);
    assert.equal(lumaPair.end_image_url, end);
    assert.equal(lumaPair.keyframes, undefined);

    const lumaList = falQueueInput(
      { prompt: "walk", duration: 5, firstFrame: start, middleFrames: [mid], lastFrame: end },
      video("luma/agent/ray/v3.2/image-to-video").inputs,
    );
    assert.equal(lumaList.image_url, undefined);
    assert.equal(lumaList.end_image_url, undefined);
    assert.deepEqual(lumaList.keyframes, [start, mid, end]);
    assert.deepEqual(lumaList.keyframe_indexes, [0, 60, 120]);

    const openrouter = buildOpenRouterVideo(
      request(video("alibaba/wan-3.0"), { firstFrame: start, lastFrame: end, middleFrames: [mid] }),
      "alibaba/wan-3.0",
    );
    assert.deepEqual(openrouter.frame_images, [
      { type: "image_url", image_url: { url: start }, frame_type: "first_frame" },
      { type: "image_url", image_url: { url: end }, frame_type: "last_frame" },
    ]);
    assert.equal(JSON.stringify(openrouter).includes("middle_frame"), false);

    const seedance = MODELS.find((model) => model.id === "dreamina-seedance-2-0-260128");
    assert.ok(seedance && isVideo(seedance));
    const modelark = buildModelArkVideo(
      request(seedance, { model: "dreamina-seedance-2-0-260128", firstFrame: start, lastFrame: end, middleFrames: [mid] }),
    );
    assert.deepEqual(
      modelark.content.filter((item) => item.type === "image_url"),
      [
        { type: "image_url", image_url: { url: start }, role: "first_frame" },
        { type: "image_url", image_url: { url: end }, role: "last_frame" },
      ],
    );

    const argolinkModel = MODELS.find((model) => model.id === "seedance-2.5");
    assert.ok(argolinkModel && isVideo(argolinkModel));
    const argolink = await buildArgoVideoBody(
      { apiKey: "placeholder" },
      request(argolinkModel, { model: "seedance-2.5", firstFrame: start, lastFrame: end, middleFrames: [mid] }),
    );
    assert.deepEqual(argolink.start_image, { url: start });
    assert.deepEqual(argolink.end_image, { url: end });
    assert.equal("middleFrames" in argolink, false);
  });

  it("rejects keyframes past the published limit and on models whose schema has none", () => {
    const kling = video("kling/v4/image-to-video");
    assert.equal(kling.capabilities.frames.keyframeLimit, 8);
    assert.equal(kling.capabilities.frames.sharedKeyframes, undefined);
    assert.equal(videoRequestError(kling, request(kling, { middleFrames: Array.from({ length: 8 }, () => mid), lastFrame: end })), null);
    assert.match(
      videoRequestError(kling, request(kling, { middleFrames: Array.from({ length: 9 }, () => mid) })) ?? "",
      /up to 8 keyframes/,
    );

    const flux = video("blackforestlabs/flux-3/keyframes-to-video");
    assert.equal(flux.capabilities.frames.keyframeLimit, 10);
    assert.equal(flux.capabilities.frames.sharedKeyframes, true);
    assert.equal(
      videoRequestError(flux, request(flux, { middleFrames: Array.from({ length: 8 }, () => mid), lastFrame: end })),
      null,
    );
    assert.match(
      videoRequestError(flux, request(flux, { middleFrames: Array.from({ length: 9 }, () => mid), lastFrame: end })) ?? "",
      /up to 10 keyframes/,
    );
    // A keyframes array with no images at all. The prompt is set, so this is the objects-shape check.
    assert.equal(
      videoRequestError(flux, request(flux, { firstFrame: undefined })),
      `${flux.name} needs a start frame`,
    );

    const wan = video("alibaba/wan-3.0/image-to-video");
    assert.equal(wan.capabilities.frames.middle, false);
    assert.equal(wan.capabilities.frames.end, true);
    assert.match(videoRequestError(wan, request(wan, { middleFrames: [mid] })) ?? "", /doesn't support keyframes/);

    const grok = video("xai/grok-imagine-video/v1.5/image-to-video");
    assert.equal(grok.capabilities.frames.end, false);
    assert.match(videoRequestError(grok, request(grok, { lastFrame: end })) ?? "", /doesn't support end frames/);

    const seedance = MODELS.find((model) => model.id === "dreamina-seedance-2-0-260128");
    assert.ok(seedance && isVideo(seedance));
    assert.equal(seedance.capabilities.frames.end, true);
    assert.equal(seedance.capabilities.frames.middle, false);
    assert.match(videoRequestError(seedance, request(seedance, { middleFrames: [mid] })) ?? "", /doesn't support keyframes/);

    for (const model of ALL_MODELS.filter(isVideo)) {
      if (!model.routes.some((route) => route.provider === "fal")) continue;
      if (model.capabilities.frames.middle) {
        assert.ok(model.inputs?.middle || model.inputs?.keyframes, model.id);
        assert.ok((model.capabilities.frames.keyframeLimit ?? 0) > 0, model.id);
      } else {
        assert.equal(model.inputs?.middle, undefined, model.id);
        assert.equal(model.inputs?.keyframes, undefined, model.id);
      }
      if (model.capabilities.frames.end && !model.inputs?.keyframes)
        assert.equal(model.inputs?.end, "end_image_url", model.id);
    }
  });

  it("keeps adaptive ratio on the start frame", () => {
    const wan = video("alibaba/wan-3.0/image-to-video");
    assert.match(
      videoRequestError(wan, request(wan, { ratio: "adaptive", firstFrame: undefined })) ?? "",
      /Auto ratio needs a start frame/,
    );
    assert.equal(videoRequestError(wan, request(wan, { ratio: "adaptive", firstFrame: start })), null);
    assert.equal(ratioForStartFrame("adaptive", true), "adaptive");
    assert.equal(ratioForStartFrame("adaptive", false), "16:9");
    assert.equal(ratioForStartFrame("9:16", false), "9:16");
    assert.deepEqual(keyframeIndexes(3, 5), [0, 60, 120]);
    assert.deepEqual(keyframeIndexes(1, 5), [0]);
  });

  it("reads a middle-image limit from the published schema", () => {
    const model = falModel(
      { endpoint: "example/image-to-video", task: "i2v", family: "Example" },
      {
        metadata: { display_name: "Example" },
        openapi: {
          openapi: "3.0.0",
          components: {
            schemas: {
              ExampleInput: {
                properties: {
                  prompt: { type: "string" },
                  start_image_url: { type: "string" },
                  end_image_url: { type: "string" },
                  middle_image_urls: {
                    type: "array",
                    maxItems: 8,
                    items: { type: "string" },
                    description: "Ordered keyframes (max 8).",
                  },
                },
                required: ["start_image_url"],
              },
            },
          },
        },
      },
    ) as {
      capabilities: { frames: { middle: boolean; keyframeLimit?: number; sharedKeyframes?: boolean; end: boolean } };
      inputs: { middle?: string; frameLimit?: number; keyframes?: string };
    };
    assert.equal(model.capabilities.frames.middle, true);
    assert.equal(model.capabilities.frames.end, true);
    assert.equal(model.capabilities.frames.keyframeLimit, 8);
    assert.equal(model.capabilities.frames.sharedKeyframes, undefined);
    assert.equal(model.inputs.middle, "middle_image_urls");
    assert.equal(model.inputs.frameLimit, 8);
    assert.equal(model.inputs.keyframes, undefined);
  });
});
