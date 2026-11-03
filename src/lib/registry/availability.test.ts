import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ALL_MODELS } from "./generated";
import { getImageModel, getModel, isVideo } from "./index";
import {
  availabilityError,
  availabilityFor,
  availabilityHint,
  availableRoute,
  routeProviders,
  sortByAvailability,
} from "./availability";

describe("availability", () => {
  it("is unavailable with no keys and names every route's display name", () => {
    const model = getImageModel("nano-banana-2.1");
    assert.ok(model);
    const result = availabilityFor(routeProviders(model.routes), new Set());
    assert.equal(result.available, false);
    assert.deepEqual(result.needs, ["argolink", "openrouter"]);
    assert.equal(availabilityHint(result.needs), "needs an ArgoLink or OpenRouter key");
    assert.equal(availabilityError(result.needs), "This needs an ArgoLink or OpenRouter key.");
    assert.equal(availabilityHint(["fal"]), "needs a fal key");
    assert.equal(availabilityHint(["openrouter"]), "needs an OpenRouter key");
    assert.equal(availabilityHint(["modelark"]), "needs a BytePlus ModelArk key");
  });

  it("is available for the one provider that has a key, and not for the others", () => {
    const keyed = new Set(["argolink"]);
    const argolink = getModel("seedance-2.5");
    const modelark = getModel("seedance-1-0-pro-250528");
    assert.ok(argolink && isVideo(argolink));
    assert.ok(modelark && isVideo(modelark));
    assert.equal(availabilityFor(routeProviders(argolink.routes), keyed).available, true);
    const blocked = availabilityFor(routeProviders(modelark.routes), keyed);
    assert.equal(blocked.available, false);
    assert.equal(availabilityHint(blocked.needs), "needs a BytePlus ModelArk key");
    const sorted = sortByAvailability([modelark, argolink], (model) =>
      availabilityFor(routeProviders(model.routes), keyed).available,
    );
    assert.deepEqual(
      sorted.map((model) => model.id),
      ["seedance-2.5", "seedance-1-0-pro-250528"],
    );
  });

  it("treats a multi-route model as available when one real route is keyed", () => {
    const model = getImageModel("nano-banana-2.1");
    assert.ok(model);
    assert.equal(model.routes.length, 2);
    assert.equal(availabilityFor(routeProviders(model.routes), new Set(["openrouter"])).available, true);
    assert.equal(availableRoute(model, new Set(["openrouter", "argolink"]), "openrouter")?.endpoint, "google/gemini-nano-banana-2.1");
    const blocked = availabilityFor(routeProviders(model.routes), new Set(["modelark"]));
    assert.equal(blocked.available, false);
    assert.deepEqual(blocked.needs, ["argolink", "openrouter"]);
    assert.equal(availableRoute(model, new Set(["argolink", "openrouter"]), "modelark")?.provider, "argolink");
  });

  it("uses the providers on real upscale routes", () => {
    const providers = routeProviders(
      ALL_MODELS.filter((model) => model.task === "upscale").flatMap((model) => model.routes),
    );
    assert.deepEqual(providers, ["fal", "openrouter"]);
    const none = availabilityFor(providers, new Set());
    assert.equal(none.available, false);
    assert.equal(availabilityHint(none.needs), "needs a fal or OpenRouter key");
    assert.equal(availabilityFor(providers, new Set(["fal"])).available, true);
    assert.equal(availabilityFor(providers, new Set(["argolink"])).available, false);
  });

  it("treats references as the model's own routes when the model accepts them", () => {
    const withRefs = getModel("seedance-2.5");
    const noRefs = getModel("seedance-1-0-pro-250528");
    assert.ok(withRefs && isVideo(withRefs) && withRefs.capabilities.references.total > 0);
    assert.ok(noRefs && isVideo(noRefs) && noRefs.capabilities.references.total === 0);
    const providers = routeProviders(withRefs.routes);
    assert.equal(availabilityFor(providers, new Set()).available, false);
    assert.equal(availabilityHint(availabilityFor(providers, new Set()).needs), "needs an ArgoLink key");
    assert.equal(availabilityFor(providers, new Set(["argolink"])).available, true);
  });
});
