import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { falVideoEndpoint } from "../providers/fal";
import { availability } from "./availability";
import { catalogPickerModels } from "./generated";
import {
  estimateRouteCost,
  getModel,
  imageProviderFor,
  isVideo,
  MODELS,
} from "./index";
import { pickerModels, preferredRoute, reuseSelection } from "./routing";

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
    const open = studioCatalog().filter((model) => availability(model, keyed).available);
    assert.ok(open.some((model) => model.name.includes("Seedance")));
    assert.ok(open.some((model) => /kling/i.test(model.name)));
    assert.equal(open.some((model) => model.id === "seedance-2.0"), false);
    const seedanceRow = open.find((model) => model.id === "dreamina-seedance-2-0-260128");
    assert.ok(seedanceRow);
    assert.ok(seedanceRow.routes.some((route) => route.provider === "modelark"));
    assert.ok(seedanceRow.routes.some((route) => route.provider === "fal"));
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
    assert.notEqual(modelark, argolink);

    // ModelArk: (5 + 10) seconds at the with-video token rate.
    const withVideo = estimateRouteCost(model, "modelark", { ...plain, referenceVideoSeconds: 10 });
    const tokens = (15 * 1280 * 720 * 24) / 1024;
    assert.ok(withVideo !== undefined && Math.abs(withVideo - tokens * 0.0000043) < 1e-6);

    // ArgoLink: 5s output + 2.4s reference bills 9s at the with-video 720p rate.
    const billed = estimateRouteCost(model, "argolink", { ...plain, referenceVideoSeconds: 2.4 });
    assert.ok(billed !== undefined && Math.abs(billed - 0.0792 * 9) < 1e-6);
  });

  it("runs the Image tab on OpenRouter when that is the only image key", () => {
    const model = getModel("nano-banana-2.1");
    assert.ok(model);
    const keyed = new Set(["openrouter"]);
    assert.equal(availability(model, keyed).available, true);
    assert.equal(availability(model, keyed).needs.length, 0);
    const provider = imageProviderFor("modelark", ["openrouter"]);
    assert.equal(provider, "openrouter");
    assert.equal(preferredRoute(model, keyed, [provider])?.provider, "openrouter");
    const argolink = estimateRouteCost(model, "argolink", { resolution: "1k", count: 1 });
    const openrouter = estimateRouteCost(model, "openrouter", { resolution: "1k", count: 1 });
    assert.equal(argolink, 0.02);
    assert.equal(openrouter, 0.034);
  });

  it("reuses the route stored on the generation", () => {
    const catalog = studioCatalog();
    const hidden = MODELS.filter(isVideo);
    const again = reuseSelection(hidden, "dreamina-seedance-2-0-260128", "fal");
    assert.deepEqual(again, { id: "dreamina-seedance-2-0-260128", route: "fal" });
    const fromOldId = reuseSelection([...hidden, ...catalog], "seedance-2.0", "argolink");
    assert.equal(fromOldId.id, "dreamina-seedance-2-0-260128");
    assert.equal(fromOldId.route, "argolink");
    assert.equal(falVideoEndpoint("bytedance/seedance-2.0/text-to-video", "frames", true), "bytedance/seedance-2.0/image-to-video");
    assert.equal(
      falVideoEndpoint("fal-ai/kling-video/v3/pro/text-to-video", "frames", true),
      "fal-ai/kling-video/v3/pro/text-to-video",
    );
  });
});
