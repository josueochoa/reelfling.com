import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toolMenu } from "./generated";
import { getImageModel, getModel, isVideo } from "./index";
import {
  availability,
  availabilityError,
  availabilityHint,
  availableRoute,
  keyedForAccount,
  keyedProviders,
  modeBlock,
  modeRoutes,
  pickRoute,
  routesForProviders,
  sortByAvailability,
} from "./availability";

const secret = "sk-live-SUPERSECRET-9999";

describe("availability", () => {
  it("is unavailable with no keys and names every route provider", () => {
    const model = getImageModel("nano-banana-2.1");
    assert.ok(model);
    const result = availability(model, keyedProviders({ workspaceProviders: [] }));
    assert.equal(result.available, false);
    assert.deepEqual(result.needs, ["argolink", "openrouter"]);
    assert.equal(availabilityHint(result.needs), "needs an argolink or openrouter key");
    assert.equal(availabilityError(result.needs), "This needs an argolink or openrouter key.");
    assert.equal(availabilityError(result.needs).includes(secret), false);
  });

  it("is available for the one provider that has a key, and not for the others", () => {
    const keyed = keyedProviders({ workspaceProviders: ["argolink"] });
    const argolink = getModel("seedance-2.5");
    const modelark = getModel("seedance-1-0-pro-250528");
    assert.ok(argolink && isVideo(argolink));
    assert.ok(modelark && isVideo(modelark));
    assert.equal(availability(argolink, keyed).available, true);
    assert.deepEqual(availability(argolink, keyed).needs, []);
    const blocked = availability(modelark, keyed);
    assert.equal(blocked.available, false);
    assert.equal(availabilityHint(blocked.needs), "needs a modelark key");
    const sorted = sortByAvailability([modelark, argolink], (model) => availability(model, keyed).available);
    assert.deepEqual(
      sorted.map((model) => model.id),
      ["seedance-2.5", "seedance-1-0-pro-250528"],
    );
  });

  it("treats a multi-route model as available when one route is keyed", () => {
    const model = getImageModel("nano-banana-2.1");
    assert.ok(model);
    assert.equal(model.routes.length, 2);
    const open = availability(model, new Set(["openrouter"]));
    assert.equal(open.available, true);
    assert.equal(availableRoute(model, new Set(["openrouter", "argolink"]), "openrouter")?.provider, "openrouter");
    assert.equal(availableRoute(model, new Set(["openrouter", "argolink"]), "openrouter")?.endpoint, "google/gemini-nano-banana-2.1");
    // A key for a provider this model does not route to does not unlock it.
    const blocked = availability(model, new Set(["modelark"]));
    assert.equal(blocked.available, false);
    assert.deepEqual(blocked.needs, ["argolink", "openrouter"]);
    assert.equal(availableRoute(model, new Set(["argolink", "openrouter"]), "modelark")?.provider, "argolink");
  });

  it("drops availability when a key is removed mid-session", () => {
    const model = getImageModel("nano-banana-2.1");
    assert.ok(model);
    // The picker reads this set on each render, so a removed key updates it with no reload.
    const session = ["argolink", "openrouter"];
    const see = () => availability(model, keyedProviders({ workspaceProviders: session }));
    assert.equal(see().available, true);
    session.splice(session.indexOf("openrouter"), 1);
    assert.equal(see().available, true);
    session.splice(0, session.length);
    const after = see();
    assert.equal(after.available, false);
    assert.equal(availabilityHint(after.needs), "needs an argolink or openrouter key");
  });

  it("uses a team member's own key only when the owner allows it", () => {
    const model = getModel("seedance-2.5");
    assert.ok(model);
    const teamOnly = keyedForAccount({
      keys: [{ provider: "modelark" }],
      personalKeys: [{ provider: "argolink" }],
      workspace: { kind: "team", memberKeys: false },
    });
    assert.equal(teamOnly.has("argolink"), false);
    assert.equal(availability(model, teamOnly).available, false);
    const allowed = keyedForAccount({
      keys: [{ provider: "modelark" }],
      personalKeys: [{ provider: "argolink" }],
      workspace: { kind: "team", memberKeys: true },
    });
    assert.equal(allowed.has("argolink"), true);
    assert.equal(availability(model, allowed).available, true);
    const personal = keyedForAccount({
      keys: [{ provider: "argolink" }],
      personalKeys: [{ provider: "openrouter" }],
      workspace: { kind: "personal", memberKeys: false },
    });
    assert.equal(personal.has("openrouter"), false);
    assert.equal(availability(model, personal).available, true);
  });

  it("names every provider that can run a tool, and one keyed route unlocks it", () => {
    const upscale = toolMenu().find((tool) => tool.task === "upscale");
    assert.ok(upscale);
    assert.deepEqual(upscale.providers, ["fal", "openrouter"]);
    const routes = routesForProviders(upscale.providers);
    assert.equal(availabilityHint(availability({ routes }, new Set()).needs), "needs a fal or openrouter key");
    assert.equal(availability({ routes }, new Set(["fal"])).available, true);
    assert.equal(availability({ routes }, new Set(["openrouter"])).available, true);
    assert.equal(availability({ routes }, new Set(["argolink"])).available, false);
    const extend = toolMenu().find((tool) => tool.task === "extend");
    assert.ok(extend);
    assert.deepEqual(extend.providers, ["fal"]);
  });

  it("grays references when that mode's routes have no key", () => {
    const withRefs = getModel("seedance-2.5");
    const noRefs = getModel("seedance-1-0-pro-250528");
    assert.ok(withRefs && isVideo(withRefs));
    assert.ok(noRefs && isVideo(noRefs));
    assert.equal(availability({ routes: modeRoutes(withRefs, "references") }, new Set(["argolink"])).available, true);
    assert.equal(modeBlock(withRefs, "references", new Set()), "This needs an argolink, fal or openrouter key.");
    assert.equal(modeRoutes(noRefs, "references").length, 0);
    assert.equal(modeBlock(noRefs, "references", new Set(["modelark"])), null);
    assert.equal(modeBlock(noRefs, "frames", new Set()), "This needs a modelark key.");
    assert.equal(modeBlock(noRefs, "frames", new Set(["modelark"])), null);
  });

  it("picks the keyed route and refuses with providers only, never key material", () => {
    const model = getImageModel("nano-banana-2.1");
    assert.ok(model);
    const both = {
      keyed: new Set(["argolink", "openrouter"]),
      workspace: new Set(["argolink"]),
      personal: new Set(["openrouter"]),
    };
    const team = pickRoute(model, both, { team: true, memberKeys: true, requested: "team", prefer: "argolink" });
    assert.equal(team.route.provider, "argolink");
    assert.equal(team.source, "team");
    const member = pickRoute(model, both, {
      team: true,
      memberKeys: true,
      requested: "member",
      prefer: "openrouter",
    });
    assert.equal(member.source, "member");
    assert.equal(member.route.provider, "openrouter");
    const onlyMember = pickRoute(
      model,
      { keyed: new Set(["openrouter"]), workspace: new Set(["fal"]), personal: new Set(["openrouter"]) },
      { team: true, memberKeys: true, requested: "team", prefer: "fal" },
    );
    assert.equal(onlyMember.source, "member");
    assert.equal(onlyMember.route.provider, "openrouter");
    assert.throws(
      () => pickRoute(model, { keyed: new Set(), workspace: new Set(), personal: new Set([secret]) }, { team: false, memberKeys: false }),
      (error: unknown) => {
        const message = (error as Error).message;
        assert.equal(message, "This needs an argolink or openrouter key.");
        assert.equal(message.includes(secret), false);
        assert.equal((error as { status?: number }).status, 400);
        return true;
      },
    );
  });
});
