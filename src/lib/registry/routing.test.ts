import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { falVideoEndpoint } from "../providers/fal";
import { availabilityFor, routeProviders } from "./availability";
import { catalogPickerModels } from "./generated";
import { estimateRouteCost, getModel, imageProviderFor, isVideo, MODELS } from "./index";
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
  it("shows Seedance and Kling together when ModelArk and fal keys are saved", () => {
    const keyed = new Set(["modelark", "fal"]);
    const open = studioCatalog().filter((model) => availabilityFor(routeProviders(model.routes), keyed).available);
    assert.ok(open.some((model) => model.name.includes("Seedance")));
    assert.ok(open.some((model) => /kling/i.test(model.name)));
    assert.equal(open.some((model) => model.id === "seedance-2.0"), false);
    const row = open.find((model) => model.id === "dreamina-seedance-2-0-260128");
    assert.ok(row);
    assert.ok(row.routes.some((route) => route.provider === "modelark"));
    assert.ok(row.routes.some((route) => route.provider === "fal"));
  });

  it("uses the saved route, then the old active provider, then the first keyed route", () => {
    const model = seedance();
    const both = new Set(["modelark", "fal"]);
    assert.equal(preferredRoute(model, both, ["fal", "modelark"])?.provider, "fal");
    assert.equal(preferredRoute(model, both, [null, "argolink", "modelark"])?.provider, "modelark");
    assert.equal(preferredRoute(model, new Set(["fal"]), [null, "modelark"])?.provider, "fal");
    assert.equal(preferredRoute(model, new Set(["openrouter"]), ["fal"])?.provider, "openrouter");
  });

  it("prices each route, including reference-video seconds", () => {
    const model = seedance();
    const plain = { resolution: "720p", duration: 5 };
    const modelark = estimateRouteCost(model, "modelark", plain);
    const argolink = estimateRouteCost(model, "argolink", plain);
    const fal = estimateRouteCost(model, "fal", { ...plain, audio: true });
    assert.ok(modelark !== undefined && Math.abs(modelark - 0.756) < 0.02);
    assert.ok(argolink !== undefined && Math.abs(argolink - 0.129 * 5) < 1e-6);
    assert.ok(fal !== undefined && Math.abs(fal - 0.3034 * 5) < 1e-6);
    const withVideo = estimateRouteCost(model, "modelark", { ...plain, referenceVideoSeconds: 10 });
    const tokens = (15 * 1280 * 720 * 24) / 1024;
    assert.ok(withVideo !== undefined && Math.abs(withVideo - tokens * 0.0000043) < 1e-6);
    const billed = estimateRouteCost(model, "argolink", { ...plain, referenceVideoSeconds: 2.4 });
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

  it("reuses the route stored on the generation", () => {
    const again = reuseSelection(MODELS.filter(isVideo), "dreamina-seedance-2-0-260128", "fal");
    assert.deepEqual(again, { id: "dreamina-seedance-2-0-260128", route: "fal" });
    const fromOldId = reuseSelection(MODELS.filter(isVideo), "seedance-2.0", "argolink");
    assert.equal(fromOldId.id, "dreamina-seedance-2-0-260128");
    assert.equal(fromOldId.route, "argolink");
    assert.equal(falVideoEndpoint("bytedance/seedance-2.0/text-to-video", "frames", true), "bytedance/seedance-2.0/image-to-video");
  });

  it("rejects an unknown model id and a provider that is not a route of that model", () => {
    const model = seedance();
    assert.equal(routeChoiceError(undefined, "fal"), "Unknown model");
    assert.equal(routeChoiceError(model, "not-a-provider"), "That model has no route on this provider");
    assert.equal(routeChoiceError(getModel("seedance-1-0-pro-250528"), "fal"), "That model has no route on this provider");
    assert.equal(routeChoiceError(model, "fal"), null);
    assert.equal(routeChoiceError(model, "modelark"), null);
  });
});
