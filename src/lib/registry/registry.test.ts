import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { openRouterCamera, openRouterModel, openRouterPrice } from "../../../scripts/catalog-map.mjs";
import type { GenerateRequest } from "../types";
import { ALL_MODELS, openRouterPickerModels } from "./generated";
import { MAPPERS } from "./mappers";
import {
  MAPPER_IDS,
  MODELS,
  ROUTE_PROVIDERS,
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
    assert.ok(ALL_MODELS.length > 8);
    assert.ok(ALL_MODELS.some((model) => model.routes.some((route) => route.provider === "openrouter")));
    assert.ok(ALL_MODELS.some((model) => model.routes.some((route) => route.mapper === "fal.queue")));
  });

  it("fails on an unknown provider", () => {
    const raw = JSON.parse(JSON.stringify(ALL_MODELS[0])) as { routes: { provider: string }[] };
    raw.routes[0].provider = "stripe";
    assert.throws(() => parseModel(raw), /Unknown provider "stripe"/);
  });

  it("fails on an unknown mapper", () => {
    const raw = JSON.parse(JSON.stringify(ALL_MODELS[0])) as { routes: { provider: string; mapper: string }[] };
    raw.routes[0].provider = "fal";
    raw.routes[0].mapper = "nope.mapper";
    assert.throws(() => parseModel(raw), /Unknown mapper "nope.mapper"/);
  });

  it("keeps route mapper ids stable and only implements mappers a client calls", () => {
    assert.deepEqual(Object.keys(MAPPERS).sort(), [
      "argolink.image.google",
      "argolink.image.openai",
      "openrouter.image",
    ]);
    for (const model of ALL_MODELS)
      for (const route of model.routes) {
        assert.ok(ROUTE_PROVIDERS.includes(route.provider), route.provider);
        assert.ok(MAPPER_IDS.includes(route.mapper), `${model.id} names unknown mapper ${route.mapper}`);
        if (route.mapper.startsWith("argolink.image.") || route.mapper === "openrouter.image")
          assert.equal(typeof MAPPERS[route.mapper], "function");
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

  it("bills ArgoLink Seedance 2.5 reference video at the with-video rate", () => {
    const model = getModel("seedance-2.5");
    assert.ok(model);
    const shown = (input: Parameters<typeof estimateCost>[1]) => estimateCost(model, input)?.toFixed(2);
    // 30 × $0.0874. Reference images and generated audio are not an input.
    assert.equal(shown({ resolution: "480p", duration: 30 }), "2.62");
    assert.equal(shown({ resolution: "480p", duration: 30, audio: true }), "2.62");
    // 30 + floor(23) = 53 billed seconds × $0.0523.
    assert.equal(shown({ resolution: "480p", duration: 30, referenceVideoSeconds: 23 }), "2.77");
    assert.equal(shown({ resolution: "480p", duration: 30, referenceVideoSeconds: 23, audio: true }), "2.77");
    // A short clip hits ceil(30 × 5/3) = 50 × $0.0523.
    assert.equal(shown({ resolution: "480p", duration: 30, referenceVideoSeconds: 2 }), "2.62");
    assert.equal(shown({ resolution: "480p", duration: 30, referenceVideoSeconds: 0.4 }), "2.62");
    // Official example: 5s output + 2.4s reference floors to 7, then the 9s minimum.
    assert.equal(estimateCost(model, { resolution: "480p", duration: 5, referenceVideoSeconds: 2.4 }), 9 * 0.0523);
    // Post-run: billed_seconds already include the reference. Don't multiply them by $0.0874.
    const billed = estimateCost(model, {
      resolution: "480p",
      duration: 53,
      referenceVideoSeconds: 0,
      durationIsBilled: true,
    });
    assert.equal(billed, 53 * 0.0523);
    assert.notEqual(billed?.toFixed(2), (53 * 0.0874).toFixed(2));
    // No reference video. Billed seconds above the output (a provider minimum)
    // stay on the normal rate, not the with-video rate.
    const noReference = estimateCost(model, { resolution: "480p", duration: 50 });
    assert.equal(noReference, 50 * 0.0874);
    // The other ArgoLink Seedance routes publish their own with-video rates.
    const others = [
      ["seedance-2.0", "4k", 0.397],
      ["seedance-2.0-fast", "720p", 0.0607],
      ["seedance-2.0-mini", "480p", 0.0179],
    ] as const;
    for (const [id, resolution, perSecond] of others) {
      const entry = getModel(id);
      assert.ok(entry);
      const cost = estimateCost(entry, { resolution, duration: 5, referenceVideoSeconds: 2.4 });
      assert.ok(cost !== undefined && Math.abs(cost - 9 * perSecond) < 1e-8, id);
    }
  });

  it("adds reference-video seconds on a token price and switches to the with-video rate", () => {
    // fal Seedance 2.5 reference-to-video: $0.0214 / 1k tokens, × 0.6 with any video reference.
    // 10s 720p 16:9 is 216,000 tokens (~$4.62); an 8s reference makes 388,800 tokens (~$4.99).
    const fal = {
      price: {
        type: "tokens" as const,
        usdPerToken: 0.0000214,
        usdPerTokenWithVideo: 0.0000214 * 0.6,
        fps: 24,
        pixels: { "720p": { width: 1280, height: 720 } },
      },
    };
    const imagesOnly = estimateCost(fal, { resolution: "720p", duration: 10 });
    const withVideo = estimateCost(fal, { resolution: "720p", duration: 10, referenceVideoSeconds: 8 });
    assert.ok(imagesOnly !== undefined && Math.abs(imagesOnly - 4.6224) < 1e-9);
    assert.ok(withVideo !== undefined && Math.abs(withVideo - 4.992192) < 1e-9);
    assert.equal(estimateCost(fal, { resolution: "720p", duration: 10, audio: true }), imagesOnly);

    const openrouter = ALL_MODELS.find((model) => model.id === "openrouter:bytedance/seedance-2.5");
    assert.ok(openrouter && openrouter.group === "video");
    assert.deepEqual(openrouter.capabilities.references, { image: 50, video: 50, audio: 50, total: 50 });
    assert.equal(openrouter.tasks.includes("ref2v"), true);
    assert.equal(openrouter.price?.type === "tokens" && openrouter.price.usdPerTokenWithVideo, 0.0000064);
    const cold = estimateCost(openrouter, { resolution: "480p", duration: 30 });
    const referenced = estimateCost(openrouter, { resolution: "480p", duration: 30, referenceVideoSeconds: 23 });
    const tokensPerSecond = (864 * 480 * 24) / 1024;
    assert.ok(cold !== undefined && Math.abs(cold - 30 * tokensPerSecond * 0.0000107) < 1e-8);
    assert.ok(referenced !== undefined && Math.abs(referenced - 53 * tokensPerSecond * 0.0000064) < 1e-8);

    const modelark = getModel("dreamina-seedance-2-0-260128");
    assert.ok(modelark);
    const perSecond = (1280 * 720 * 24) / 1024;
    const plain = estimateCost(modelark, { resolution: "720p", duration: 5 });
    const video = estimateCost(modelark, { resolution: "720p", duration: 5, referenceVideoSeconds: 4 });
    assert.ok(plain !== undefined && Math.abs(plain - 5 * perSecond * 0.000007) < 1e-8);
    assert.ok(video !== undefined && Math.abs(video - 9 * perSecond * 0.0000043) < 1e-8);
  });

  it("keeps extreme image ratios off higher resolutions without checking the model name", () => {
    const model = getModel("nano-banana-2.1");
    assert.ok(model && model.group === "image");
    assert.equal(model.capabilities.ratioResolutions?.["1:8"]?.includes("1k"), true);
    assert.equal(model.capabilities.ratioResolutions?.["1:8"]?.includes("2k") ?? false, false);
  });

  it("keeps the OpenRouter video models the studio runs", () => {
    const endpoints = [
      "bytedance/seedance-2.5",
      "kwaivgi/kling-v3.0-pro",
      "google/veo-3.1-fast",
      "alibaba/wan-3.0",
      "black-forest-labs/flux-3-video",
      "x-ai/grok-imagine-video-1.5",
      "minimax/hailuo-3",
    ];
    for (const endpoint of endpoints) {
      const model = ALL_MODELS.find((entry) =>
        entry.routes.some((route) => route.provider === "openrouter" && route.endpoint === endpoint),
      );
      assert.ok(model, endpoint);
      assert.equal(model.group, "video");
    }
    const picker = openRouterPickerModels();
    assert.deepEqual(
      picker.slice(0, 3).map((model) => model.routes[0]?.endpoint),
      ["bytedance/seedance-2.5", "kwaivgi/kling-v3.0-pro", "google/veo-3.1-fast"],
    );
    for (const model of picker) {
      assert.equal(
        model.routes.every((route) => route.provider === "openrouter"),
        true,
        model.id,
      );
      assert.ok(model.description.length <= 240, model.id);
    }
  });

  it("does not import generated catalogs or camera sentences from client code", () => {
    const banned = /from ["'][^"']*(?:registry\/generated|registry\/camera-apply|catalog\/(?:fal|openrouter)\.json)/;
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const instruction = "does not pan, tilt, zoom, or drift";
    assert.equal(readFileSync(new URL("./camera-presets.json", import.meta.url), "utf8").includes(instruction), true);
    assert.equal(banned.test(index), false, "index.ts");
    assert.equal(index.includes(instruction), false, "index.ts instruction");
    assert.equal(JSON.stringify(MODELS).includes(instruction), false);
    assert.equal(JSON.stringify(openRouterPickerModels()).includes(instruction), false);
    const components = fileURLToPath(new URL("../../components", import.meta.url));
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return walk(path);
        return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
      });
    for (const file of walk(components)) {
      const text = readFileSync(file, "utf8");
      assert.equal(banned.test(text), false, file);
      assert.equal(text.includes(instruction), false, file);
    }
  });

  it("does not write API keys into the generated catalogs", () => {
    for (const name of ["fal.json", "openrouter.json", "upscale.json"]) {
      const text = readFileSync(new URL(`./catalog/${name}`, import.meta.url), "utf8");
      assert.equal(text.includes("Authorization"), false, name);
      assert.equal(text.includes("FAL_KEY"), false, name);
      assert.equal(text.includes("OPENROUTER_API_KEY"), false, name);
    }
  });
});

describe("openrouter camera passthrough", () => {
  it("maps only the documented camera_fixed boolean", () => {
    assert.equal(openRouterCamera([]), false);
    assert.equal(openRouterCamera(["negative_prompt", "cfg_scale"]), false);
    assert.equal(openRouterCamera(["shot_type"]), false);
    assert.equal(openRouterCamera(["motion_prompt"]), false);
    assert.deepEqual(openRouterCamera(["camera_fixed"]), {
      fixed: true,
      prompt: true,
      params: ["camera_fixed"],
    });
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

    const withVideo = openRouterPrice({
      supported_resolutions: ["480p", "720p", "1080p"],
      pricing_skus: {
        video_tokens: "0.0000107",
        video_tokens_1080p: "0.0000117",
        video_tokens_with_video_input: "0.0000064",
        video_tokens_1080p_with_video_input: "0.000007",
      },
    }) as {
      type: string;
      usdPerTokenWithVideo: number;
      byResolutionWithVideo: Record<string, number>;
    };
    assert.equal(withVideo.type, "tokens");
    assert.equal(withVideo.usdPerTokenWithVideo, 0.0000064);
    assert.equal(withVideo.byResolutionWithVideo["480p"], 0.0000064);
    assert.equal(withVideo.byResolutionWithVideo["1080p"], 0.000007);

    const seedance25 = openRouterModel({
      id: "bytedance/seedance-2.5",
      name: "ByteDance: Seedance 2.5",
      description: "up to 50 image, video, and audio reference assets",
      supported_resolutions: ["480p", "720p"],
      supported_aspect_ratios: ["16:9"],
      supported_durations: [4, 5, 30],
      supported_frame_images: ["first_frame", "last_frame"],
      generate_audio: true,
      seed: true,
      pricing_skus: { video_tokens: "0.0000107", video_tokens_with_video_input: "0.0000064" },
    }) as {
      tasks: string[];
      capabilities: { references: { image: number; video: number; audio: number; total: number } };
      price: { usdPerTokenWithVideo: number };
    };
    assert.deepEqual(seedance25.capabilities.references, { image: 50, video: 50, audio: 50, total: 50 });
    assert.equal(seedance25.tasks.includes("ref2v"), true);
    assert.equal(seedance25.price.usdPerTokenWithVideo, 0.0000064);

    const upscale = openRouterPrice({
      pricing_skus: { cents_per_megapixel_second_precise: "3.5" },
    });
    assert.deepEqual(upscale, { type: "per_megapixel", usd: 0.035, perSecond: true });
  });
});
