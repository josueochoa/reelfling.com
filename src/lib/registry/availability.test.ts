import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toolMenu } from "./generated";
import { getImageModel, getModel, isVideo } from "./index";
import {
  availabilityError,
  availabilityFor,
  availabilityHint,
  availableRoute,
  hasTask,
  modeBlock,
  modeRoutes,
  routeProviders,
  sortByAvailability,
} from "./availability";

const secret = "sk-live-SUPERSECRET-9999";

describe("availability", () => {
  it("is unavailable with no keys and names every route's display name", () => {
    const model = getImageModel("nano-banana-2.1");
    assert.ok(model);
    const result = availabilityFor(routeProviders(model.routes), new Set());
    assert.equal(result.available, false);
    assert.deepEqual(result.needs, ["argolink", "openrouter"]);
    assert.equal(availabilityHint(result.needs), "needs an ArgoLink or OpenRouter key");
    assert.equal(availabilityError(result.needs), "This needs an ArgoLink or OpenRouter key.");
    assert.equal(availabilityError(result.needs).includes(secret), false);
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

  it("drops availability when a key is removed mid-session", () => {
    const model = getImageModel("nano-banana-2.1");
    assert.ok(model);
    const session = ["argolink", "openrouter"];
    const see = () => availabilityFor(routeProviders(model.routes), new Set(session));
    assert.equal(see().available, true);
    session.splice(session.indexOf("openrouter"), 1);
    assert.equal(see().available, true);
    session.splice(0, session.length);
    const after = see();
    assert.equal(after.available, false);
    assert.equal(availabilityHint(after.needs), "needs an ArgoLink or OpenRouter key");
  });

  it("names the real providers of a tool, and one keyed route unlocks it", () => {
    const upscale = toolMenu().find((tool) => tool.task === "upscale");
    assert.ok(upscale);
    assert.deepEqual(upscale.providers, ["fal", "openrouter"]);
    assert.equal(availabilityHint(availabilityFor(upscale.providers, new Set()).needs), "needs a fal or OpenRouter key");
    assert.equal(availabilityFor(upscale.providers, new Set(["fal"])).available, true);
    assert.equal(availabilityFor(upscale.providers, new Set(["argolink"])).available, false);
    const extend = toolMenu().find((tool) => tool.task === "extend");
    assert.ok(extend && hasTask({ task: extend.task, tasks: [extend.task] }, "extend"));
    assert.deepEqual(extend.providers, ["fal"]);
    assert.equal(availabilityError(availabilityFor(extend.providers, new Set()).needs), "This needs a fal key.");
  });

  it("grays references when that mode's routes have no key", () => {
    const withRefs = getModel("seedance-2.5");
    const noRefs = getModel("seedance-1-0-pro-250528");
    assert.ok(withRefs && isVideo(withRefs));
    assert.ok(noRefs && isVideo(noRefs));
    assert.equal(availabilityFor(routeProviders(modeRoutes(withRefs, "references")), new Set(["argolink"])).available, true);
    assert.equal(modeBlock(withRefs, "references", new Set()), "This needs an ArgoLink key.");
    assert.equal(modeRoutes(noRefs, "references").length, 0);
    assert.equal(modeBlock(noRefs, "references", new Set(["modelark"])), null);
    assert.equal(modeBlock(noRefs, "frames", new Set()), "This needs a BytePlus ModelArk key.");
    assert.equal(modeBlock(noRefs, "frames", new Set(["modelark"])), null);
  });
});
