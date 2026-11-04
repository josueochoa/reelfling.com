import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeMentions } from "../mentions";
import { availabilityFor, routeProviders } from "./availability";
import { catalogPickerModels } from "./generated";
import { estimateRouteCost, getModel, imageProviderFor, isVideo, mentionSyntax, MODELS } from "./index";
import { pickerModels, preferredRoute, reuseSelection, routeChoiceError } from "./routing";

const seedance = () => {
  const model = getModel("dreamina-seedance-2-0-260128");
  assert.ok(model && isVideo(model));
  return model;
};

function studioCatalog() {
  const hand = MODELS.filter(isVideo);
  const extra = catalogPickerModels().filter((model) => !hand.some((item) => item.id === model.id));
  return pickerModels([...hand, ...extra]);
}

describe("per-model routes", () => {
  it("keeps ArgoLink Seedance 2.0 on its own row, with @ mentions and 4K", () => {
    const argolink = getModel("seedance-2.0");
    const modelark = getModel("dreamina-seedance-2-0-260128");
    assert.ok(argolink && isVideo(argolink));
    assert.ok(modelark && isVideo(modelark));
    assert.equal(argolink.routes.some((route) => route.provider === "argolink"), true);
    assert.equal(modelark.routes.some((route) => route.provider === "argolink"), false);
    assert.equal(argolink.capabilities.resolutions.includes("4k"), true);
    assert.equal(modelark.capabilities.resolutions.includes("4k"), false);
    const sent = normalizeMentions("the boat in @Image 1", mentionSyntax(argolink.refSyntax));
    assert.equal(sent, "the boat in @Image 1");
    assert.equal(studioCatalog().some((model) => model.id === "seedance-2.0"), true);
  });

  it("uses the saved route, then the old active provider, then the first keyed route", () => {
    const model = getModel("nano-banana-2.1");
    assert.ok(model);
    const both = new Set(["argolink", "openrouter"]);
    assert.equal(preferredRoute(model, both, ["openrouter", "argolink"])?.provider, "openrouter");
    assert.equal(preferredRoute(model, both, [null, "fal", "argolink"])?.provider, "argolink");
    assert.equal(preferredRoute(model, new Set(["openrouter"]), [null, "argolink"])?.provider, "openrouter");
  });

  it("prices each route, including reference-video seconds", () => {
    const modelarkModel = seedance();
    const argolinkModel = getModel("seedance-2.0");
    assert.ok(argolinkModel);
    const plain = { resolution: "720p", duration: 5 };
    const modelark = estimateRouteCost(modelarkModel, "modelark", plain);
    const argolink = estimateRouteCost(argolinkModel, "argolink", plain);
    assert.ok(modelark !== undefined && Math.abs(modelark - 0.756) < 0.02);
    assert.ok(argolink !== undefined && Math.abs(argolink - 0.129 * 5) < 1e-6);
    const withVideo = estimateRouteCost(modelarkModel, "modelark", { ...plain, referenceVideoSeconds: 10 });
    const tokens = (15 * 1280 * 720 * 24) / 1024;
    assert.ok(withVideo !== undefined && Math.abs(withVideo - tokens * 0.0000043) < 1e-6);
    const billed = estimateRouteCost(argolinkModel, "argolink", { ...plain, referenceVideoSeconds: 2.4 });
    assert.ok(billed !== undefined && Math.abs(billed - 0.0792 * 9) < 1e-6);
  });

  it("runs the Image tab on OpenRouter when that is the only image key", () => {
    const model = getModel("nano-banana-2.1");
    assert.ok(model);
    const keyed = new Set(["openrouter"]);
    assert.equal(availabilityFor(routeProviders(model.routes), keyed).available, true);
    assert.equal(imageProviderFor("modelark", ["openrouter"]), "openrouter");
    assert.equal(preferredRoute(model, keyed, [imageProviderFor("modelark", ["openrouter"])])?.provider, "openrouter");
    assert.equal(estimateRouteCost(model, "argolink", { resolution: "1k", count: 1 }), 0.02);
    assert.equal(estimateRouteCost(model, "openrouter", { resolution: "1k", count: 1 }), 0.034);
  });

  it("reuses the route stored on the generation without folding the ArgoLink row", () => {
    const again = reuseSelection(MODELS.filter(isVideo), "seedance-2.0", "argolink");
    assert.deepEqual(again, { id: "seedance-2.0", route: "argolink" });
  });

  it("leaves unchecked fal catalog models out of the picker", () => {
    const endpoints = catalogPickerModels().flatMap((model) => model.routes.map((route) => `${route.provider}:${route.endpoint}`));
    for (const dropped of [
      "fal:fal-ai/kling-video/v3/pro/text-to-video",
      "fal:fal-ai/wan/v2.2-a14b/text-to-video",
      "fal:alibaba/wan-3.0/reference-to-video",
      "fal:fal-ai/minimax/video-01/image-to-video",
    ]) {
      assert.equal(endpoints.includes(dropped), false, dropped);
    }
    assert.equal(endpoints.some((endpoint) => endpoint.startsWith("fal:")), false);
  });

  it("rejects an unknown model id and a provider that is not a route of that model", () => {
    const model = seedance();
    assert.equal(routeChoiceError(undefined, "fal"), "Unknown model");
    assert.equal(routeChoiceError(model, "not-a-provider"), "That model has no route on this provider");
    assert.equal(routeChoiceError(getModel("seedance-1-0-pro-250528"), "fal"), "That model has no route on this provider");
    assert.equal(routeChoiceError(model, "fal"), "That model has no route on this provider");
    assert.equal(routeChoiceError(model, "modelark"), null);
    assert.equal(routeChoiceError(getModel("nano-banana-2.1"), "openrouter"), null);
  });
});
