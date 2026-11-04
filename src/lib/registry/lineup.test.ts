import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { falImageInput, falQueueInput } from "../providers/fal";
import { ALL_MODELS, catalogImageModels, catalogPickerModels } from "./generated";
import { groupByFamily, modelBadges } from "./badges";
import { estimateCost, imageRequestError, isImage, isVideo, outputMegapixels, videoRequestError } from "./index";
import { lookupModelName } from "./lookup";
import { reuseSelection } from "./routing";
import type { ImageModel, VideoModel } from "./types";

const VIDEO = [
  "kling/v4/text-to-video",
  "kling/v4/image-to-video",
  "kling/v4/reference-to-video",
  "fal-ai/kling-video/v3/pro/image-to-video",
  "alibaba/wan-3.0/text-to-video",
  "alibaba/wan-3.0/image-to-video",
  "alibaba/wan-3.0/reference-to-video",
  "minimax/h3/text-to-video",
  "minimax/h3/image-to-video",
  "minimax/h3/reference-to-video",
  "blackforestlabs/flux-3/image-to-video",
  "google/gemini-omni-flash/v1.1/text-to-video",
  "google/gemini-omni-flash/v1.1/image-to-video",
  "google/gemini-omni-flash/v1.1/reference-to-video",
  "xai/grok-imagine-video/v1.5/image-to-video",
  "luma/agent/ray/v3.2/image-to-video",
] as const;

const IMAGE = [
  "bytedance/seedream/v5/pro/text-to-image",
  "bytedance/seedream/v5/pro/edit",
  "fal-ai/flux-2-pro",
  "fal-ai/flux-2-pro/edit",
  "ideogram/v4.5",
  "fal-ai/recraft/v4.1/text-to-image",
  "xai/grok-imagine-image/v2.0/edit",
  "fal-ai/z-image/turbo",
] as const;

function byEndpoint(endpoint: string) {
  const model = ALL_MODELS.find((item) => item.routes.some((route) => route.provider === "fal" && route.endpoint === endpoint));
  assert.ok(model, endpoint);
  return model;
}

function video(endpoint: string) {
  const model = byEndpoint(endpoint);
  assert.ok(isVideo(model));
  return model;
}

function image(endpoint: string) {
  const model = byEndpoint(endpoint);
  assert.ok(isImage(model));
  return model;
}

function close(actual: number | undefined, expected: number) {
  assert.equal(typeof actual, "number");
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-6, `${actual} vs ${expected}`);
}

describe("fal lineup catalog", () => {
  it("keeps every listed endpoint and routes Veo through OpenRouter", () => {
    for (const endpoint of [...VIDEO, ...IMAGE]) {
      const model = byEndpoint(endpoint);
      assert.equal(model.routes[0]?.provider, "fal");
      assert.equal(model.routes[0]?.mapper, "fal.queue");
    }
    const veo = ALL_MODELS.filter((model) => /veo/i.test(model.id) || /veo/i.test(model.name));
    assert.ok(veo.length >= 1);
    for (const model of veo) assert.ok(model.routes.every((route) => route.provider === "openrouter"));
    assert.equal(
      ALL_MODELS.some((model) => model.routes.some((route) => route.provider === "fal" && /veo/i.test(route.endpoint))),
      false,
    );
  });

  it("maps @Image and @Video onto each model's fields", () => {
    const imageUrl = "https://cdn.example/ref.jpg";
    const imageUrl2 = "https://cdn.example/ref-2.jpg";
    const videoUrl = "https://cdn.example/ref.mp4";

    const kling = falQueueInput(
      { prompt: "walk", referenceImages: [imageUrl], referenceVideos: [videoUrl], duration: 5, resolution: "720p", ratio: "16:9" },
      video("kling/v4/reference-to-video").inputs,
    );
    assert.deepEqual(kling.image_urls, [imageUrl]);
    assert.deepEqual(kling.video_urls, [videoUrl]);
    assert.equal(kling.elements, undefined);

    const klingV3 = falQueueInput(
      { prompt: "walk", referenceImages: [imageUrl, imageUrl2], referenceVideos: [videoUrl], duration: 5 },
      video("fal-ai/kling-video/v3/pro/image-to-video").inputs,
    );
    assert.equal(klingV3.start_image_url, imageUrl);
    assert.deepEqual(klingV3.elements, [{ frontal_image_url: imageUrl2 }, { video_url: videoUrl }]);
    assert.equal(klingV3.duration, "5");

    const wan = falQueueInput(
      { prompt: "walk", referenceImages: [imageUrl], referenceVideos: [videoUrl], duration: 5, resolution: "720p" },
      video("alibaba/wan-3.0/reference-to-video").inputs,
    );
    assert.deepEqual(wan.reference_image_urls, [imageUrl]);
    assert.deepEqual(wan.reference_video_urls, [videoUrl]);
    assert.equal(wan.audio, undefined);

    const gemini = falQueueInput(
      { prompt: "walk", referenceImages: [imageUrl], referenceVideos: [videoUrl] },
      video("google/gemini-omni-flash/v1.1/reference-to-video").inputs,
    );
    assert.deepEqual(gemini.image_urls, [imageUrl]);
    assert.deepEqual(gemini.reference_video_urls, [videoUrl]);

    const luma = falQueueInput({ prompt: "walk", duration: 5, firstFrame: imageUrl }, video("luma/agent/ray/v3.2/image-to-video").inputs);
    assert.equal(luma.duration, "5s");
    assert.equal(luma.image_url, imageUrl);

    const flux = falQueueInput({ prompt: "walk", duration: 5, firstFrame: imageUrl }, video("blackforestlabs/flux-3/image-to-video").inputs);
    assert.equal(flux.duration, 5);
    assert.equal(flux.image_url, imageUrl);

    const grok = falQueueInput({ prompt: "walk", duration: 6, ratio: "16:9", firstFrame: imageUrl }, video("xai/grok-imagine-video/v1.5/image-to-video").inputs);
    assert.equal(grok.aspect_ratio, undefined);
    assert.equal(grok.image_url, imageUrl);

    const seedream = falImageInput(
      { prompt: "edit", resolution: "1k", ratio: "1:1", images: [imageUrl], count: 1 },
      image("bytedance/seedream/v5/pro/edit").inputs ?? {},
    );
    assert.deepEqual(seedream.image_urls, [imageUrl]);
    assert.equal(seedream.image_size, "auto_1K");
  });

  it("blocks over-limit references before a request would be submitted", () => {
    const kling = video("kling/v4/reference-to-video");
    const tooMany = videoRequestError(kling, {
      model: kling.id,
      prompt: "walk",
      mode: "references",
      ratio: "16:9",
      resolution: "720p",
      duration: 5,
      referenceImages: Array.from({ length: 11 }, (_, i) => `https://cdn.example/${i}.jpg`),
    });
    assert.match(tooMany ?? "", /up to 10 reference images/);

    const wan = video("alibaba/wan-3.0/reference-to-video");
    const tooManyVideos = videoRequestError(wan, {
      model: wan.id,
      prompt: "walk",
      mode: "references",
      ratio: "16:9",
      resolution: "720p",
      duration: 5,
      referenceVideos: Array.from({ length: 6 }, (_, i) => `https://cdn.example/${i}.mp4`),
    });
    assert.match(tooManyVideos ?? "", /up to 5 reference videos/);

    const mini = video("minimax/h3/reference-to-video");
    const tooManyTotal = videoRequestError(mini, {
      model: mini.id,
      prompt: "walk",
      mode: "references",
      ratio: "16:9",
      resolution: "768P",
      duration: 5,
      referenceImages: Array.from({ length: 9 }, (_, i) => `https://cdn.example/${i}.jpg`),
      referenceVideos: Array.from({ length: 3 }, (_, i) => `https://cdn.example/${i}.mp4`),
      referenceAudios: ["https://cdn.example/a.mp3"],
    });
    assert.match(tooManyTotal ?? "", /up to 12 references/);

    const grok = image("xai/grok-imagine-image/v2.0/edit");
    const tooManyEdits = imageRequestError(grok, {
      prompt: "edit",
      ratio: "1:1",
      resolution: "1k",
      count: 1,
      references: Array.from({ length: 6 }, (_, i) => `upload:${i}`),
    });
    assert.match(tooManyEdits ?? "", /up to 5 reference images/);
  });

  it("prices from the published formulas, including reference video", () => {
    close(estimateCost(video("kling/v4/text-to-video"), { resolution: "720p", duration: 5 }), 0.785);
    close(estimateCost(video("kling/v4/text-to-video"), { resolution: "1080p", duration: 5 }), 1.175);
    // 5s output + 3s reference bills max(8, 10) seconds at the with-video 720p rate.
    close(
      estimateCost(video("kling/v4/reference-to-video"), { resolution: "720p", duration: 5, referenceVideoSeconds: 3 }),
      0.94,
    );
    close(
      estimateCost(video("alibaba/wan-3.0/reference-to-video"), { resolution: "720p", duration: 5, referenceVideoSeconds: 4 }),
      0.9,
    );
    close(
      estimateCost(video("minimax/h3/reference-to-video"), { resolution: "768P", duration: 5, referenceImages: 6 }),
      0.38,
    );
    close(estimateCost(video("luma/agent/ray/v3.2/image-to-video"), { resolution: "720p", duration: 5 }), 0.3);
    close(estimateCost(video("xai/grok-imagine-video/v1.5/image-to-video"), { resolution: "480p", duration: 5 }), 0.4);
    close(estimateCost(image("bytedance/seedream/v5/pro/text-to-image"), { resolution: "2k", count: 1 }), 0.135);
    close(
      estimateCost(image("bytedance/seedream/v5/pro/edit"), { resolution: "1k", count: 1, referenceImages: 3 }),
      0.0675 + 0.0045 * 2,
    );
    close(estimateCost(image("fal-ai/flux-2-pro"), { megapixels: 1 }), 0.03);
    close(estimateCost(image("fal-ai/flux-2-pro"), { megapixels: (1920 * 1080) / (1024 * 1024) }), 0.045);
    close(estimateCost(image("ideogram/v4.5"), { quality: "high", count: 1 }), 0.22);
    close(estimateCost(image("fal-ai/recraft/v4.1/text-to-image"), { count: 2 }), 0.014);
    close(
      estimateCost(image("xai/grok-imagine-image/v2.0/edit"), { resolution: "2k", quality: "medium", count: 1, referenceImages: 2 }),
      0.1,
    );
    close(estimateCost(image("fal-ai/z-image/turbo"), { megapixels: 1 }), 0.02);
    const oneMegapixel = outputMegapixels("1k", "1:1");
    const above = outputMegapixels("2k", "16:9");
    assert.equal(oneMegapixel, 1);
    assert.ok(above > 1);
    const small = estimateCost(image("fal-ai/z-image/turbo"), { megapixels: oneMegapixel });
    const large = estimateCost(image("fal-ai/z-image/turbo"), { megapixels: above });
    assert.ok(small !== undefined && large !== undefined && large > small);
    const fluxSmall = estimateCost(image("fal-ai/flux-2-pro"), { megapixels: oneMegapixel });
    const fluxLarge = estimateCost(image("fal-ai/flux-2-pro"), { megapixels: above });
    assert.ok(fluxSmall !== undefined && fluxLarge !== undefined && fluxLarge > fluxSmall);
  });

  it("groups the picker by family and badges audio, end frame, references, and duration", () => {
    const shown = catalogPickerModels();
    const kling = shown.filter((model) => model.family === "Kling");
    assert.ok(kling.length >= 2);
    const ref = kling.find((model) => model.routes.some((route) => route.endpoint === "kling/v4/reference-to-video"));
    assert.ok(ref);
    const badges = modelBadges(ref);
    assert.deepEqual(
      badges.map((badge) => badge.id),
      ["end", "refs", "duration"],
    );
    assert.equal(badges.find((badge) => badge.id === "duration")?.label, "30s");
    const wan = shown.find((model) => model.routes.some((route) => route.endpoint === "alibaba/wan-3.0/text-to-video"));
    assert.ok(wan);
    assert.ok(modelBadges(wan).some((badge) => badge.id === "audio"));
    const groups = groupByFamily(shown);
    assert.ok(groups.some((group) => group.family === "Kling" && group.models.length === kling.length));
    assert.ok(groups.some((group) => group.family === "Google" && group.models.some((model) => /veo/i.test(model.id))));
    assert.ok(catalogImageModels().some((model) => model.family === "Seedream"));
    assert.ok(catalogImageModels().some((model) => model.family === "Flux"));
  });

  it("hides an endpoint that left the catalog without breaking reuse", () => {
    const gone = "fal:removed/from/catalog";
    assert.equal(catalogPickerModels().some((model) => model.id === gone), false);
    assert.equal(catalogImageModels().some((model) => model.id === gone), false);
    assert.deepEqual(reuseSelection(catalogPickerModels(), gone, "fal"), { id: gone, route: "fal" });
    assert.equal(lookupModelName(gone), gone);
    const name = (model: VideoModel | ImageModel | undefined, id: string) => model?.name ?? id;
    assert.equal(name(undefined, gone), gone);
  });
});
