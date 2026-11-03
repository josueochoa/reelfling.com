import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { openRouterPrice } from "../../../scripts/catalog-map.mjs";
import type { GenerateRequest } from "../types";
import { MAPPERS } from "./mappers";
import {
  MAPPER_IDS,
  MODELS,
  ROUTE_PROVIDERS,
  assertRegistry,
  estimateCost,
  getModel,
  imageModels,
  isVideo,
  modelsFor,
  parseModel,
  videoRequestError,
  type VideoModel,
} from "./index";

function videoRequest(model: VideoModel, duration: number): GenerateRequest {
  const caps = model.capabilities;
  return {
    model: model.id,
    prompt: "a paper boat in the rain",
    mode: "frames",
    ratio: caps.ratios.includes("16:9") ? "16:9" : (caps.ratios[0] ?? "16:9"),
    resolution: caps.resolutions.includes("720p") ? "720p" : (caps.resolutions[0] ?? "720p"),
    duration,
  };
}

describe("model registry", () => {
  it("accepts the checked-in catalog", () => {
    assertRegistry(MODELS);
    assert.ok(MODELS.length > 8);
  });

  it("fails on an unknown provider", () => {
    const raw = JSON.parse(JSON.stringify(MODELS[0])) as { routes: { provider: string }[] };
    raw.routes[0].provider = "stripe";
    assert.throws(() => parseModel(raw), /Unknown provider "stripe"/);
  });

  it("fails on an unknown mapper", () => {
    const raw = JSON.parse(JSON.stringify(MODELS[0])) as { routes: { provider: string; mapper: string }[] };
    raw.routes[0].provider = "fal";
    raw.routes[0].mapper = "nope.mapper";
    assert.throws(() => parseModel(raw), /Unknown mapper "nope.mapper"/);
  });

  it("has an implementation for every mapper id", () => {
    for (const id of MAPPER_IDS) assert.equal(typeof MAPPERS[id], "function", id);
    for (const model of MODELS)
      for (const route of model.routes) {
        assert.ok(ROUTE_PROVIDERS.includes(route.provider), route.provider);
        assert.ok(MAPPER_IDS.includes(route.mapper), route.mapper);
      }
  });

  it("rejects 45s on a 30s model and names the limit", () => {
    const model = getModel("seedance-2.5");
    assert.ok(model && isVideo(model));
    const error = videoRequestError(model, videoRequest(model, 45));
    assert.equal(error, "Duration 45s is above Seedance 2.5's 30s limit");
    assert.equal(videoRequestError(model, videoRequest(model, 5)), null);
  });

  it("rejects an end frame the model can't take", () => {
    const model = getModel("seedance-1-0-pro-250528");
    assert.ok(model && isVideo(model));
    const error = videoRequestError(model, {
      ...videoRequest(model, 5),
      firstFrame: "https://example.com/start.jpg",
      lastFrame: "https://example.com/end.jpg",
    });
    assert.match(error ?? "", /doesn't support end frames/);
  });

  it("estimates a cost for every studio route, including ModelArk video", () => {
    const studio = [...modelsFor("modelark"), ...modelsFor("argolink"), ...imageModels()];
    assert.ok(studio.length >= 8);
    for (const model of studio) {
      const resolution = model.capabilities.resolutions[0];
      const cost = estimateCost(model, {
        resolution,
        duration: model.group === "video" ? model.capabilities.durations?.default : undefined,
        count: model.group === "image" ? 1 : undefined,
      });
      assert.equal(typeof cost, "number", model.id);
      assert.ok(cost !== undefined && cost > 0, model.id);
    }
    const seedance = getModel("dreamina-seedance-2-0-260128");
    assert.ok(seedance);
    const fiveSeconds = estimateCost(seedance, { resolution: "720p", duration: 5 });
    assert.ok(fiveSeconds !== undefined && Math.abs(fiveSeconds - 0.76) < 0.02);
  });

  it("keeps extreme image ratios off higher resolutions without checking the model name", () => {
    const model = getModel("nano-banana-2.1");
    assert.ok(model && model.group === "image");
    assert.equal(model.capabilities.ratioResolutions?.["1:8"]?.includes("1k"), true);
    assert.equal(model.capabilities.ratioResolutions?.["1:8"]?.includes("2k") ?? false, false);
  });

  it("does not write API keys into the generated catalogs", () => {
    for (const name of ["fal.json", "openrouter.json"]) {
      const text = readFileSync(new URL(`./catalog/${name}`, import.meta.url), "utf8");
      assert.equal(text.includes("Authorization"), false, name);
      assert.equal(text.includes("FAL_KEY"), false, name);
      assert.equal(text.includes("OPENROUTER_API_KEY"), false, name);
    }
  });
});

describe("openrouter price formulas", () => {
  it("maps per-second audio rates, token rates, and megapixels", () => {
    const veo = openRouterPrice({
      supported_resolutions: ["720p", "1080p", "4K"],
      pricing_skus: {
        duration_seconds_with_audio: "0.40",
        duration_seconds_with_audio_4k: "0.60",
        duration_seconds_without_audio: "0.20",
        duration_seconds_without_audio_4k: "0.40",
      },
    }) as { type: string; byResolution: Record<string, number>; byResolutionWithAudio: Record<string, number> };
    assert.equal(veo.type, "per_second");
    assert.equal(veo.byResolution["4K"], 0.4);
    assert.equal(veo.byResolutionWithAudio["*"], 0.4);

    const seedance = openRouterPrice({
      supported_resolutions: ["720p", "1080p"],
      pricing_skus: { video_tokens: "0.000007", video_tokens_1080p: "0.0000077" },
    }) as {
      type: string;
      byResolution: Record<string, number>;
      pixels: Record<string, { width: number }>;
    };
    assert.equal(seedance.type, "tokens");
    assert.equal(seedance.byResolution["720p"], 0.000007);
    assert.equal(seedance.pixels["1080p"].width, 1920);

    const upscale = openRouterPrice({
      pricing_skus: { cents_per_megapixel_second_precise: "3.5" },
    });
    assert.deepEqual(upscale, { type: "per_megapixel", usd: 0.035, perSecond: true });
  });
});
