import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeMentions } from "../mentions";
import type { GenerateRequest } from "../types";
import { buildArgoVideoBody } from "../providers/argolink";
import { buildOpenRouterVideo } from "../providers/openrouter";
import { buildModelArkVideo } from "./bodies";
import { CAMERA_MOVE_MAX, applyCameraMoves, compileCamera, keptCameraMoves } from "./camera";
import { ALL_MODELS } from "./generated";
import { assertRegistry, getModel, isVideo, mentionSyntax, videoRequestError, type VideoModel } from "./index";

function video(id: string): VideoModel {
  const model = getModel(id) ?? ALL_MODELS.find((entry) => entry.id === id);
  assert.ok(model && isVideo(model), id);
  return model;
}

function request(model: VideoModel, extra: Partial<GenerateRequest> = {}): GenerateRequest {
  const caps = model.capabilities;
  return {
    model: model.id,
    prompt: "a paper boat in the rain",
    mode: "frames",
    ratio: caps.ratios.includes("16:9") ? "16:9" : (caps.ratios[0] ?? "16:9"),
    resolution: caps.resolutions.includes("720p") ? "720p" : (caps.resolutions[0] ?? "720p"),
    duration: caps.durations?.default ?? 5,
    ...extra,
  };
}

describe("camera chips", () => {
  it("compiles chips in order and stops at three", () => {
    const model = video("seedance-2.5");
    const compiled = compileCamera(model, "Rain", ["pan-left", "tilt-up", "push-in"]);
    assert.deepEqual(compiled.applied, ["pan-left", "tilt-up", "push-in"]);
    assert.equal(
      compiled.prompt,
      "Rain. The camera pans smoothly to the left. The camera tilts up. The camera slowly pushes in toward the subject.",
    );
    assert.equal(compiled.cameraFixed, undefined);
    const four = request(model, { cameraMoves: ["pan-left", "tilt-up", "push-in", "orbit"] });
    assert.match(videoRequestError(model, four) ?? "", /takes up to 3 camera moves/);
    assert.equal(CAMERA_MOVE_MAX, 3);
  });

  it("uses the model family's prompt line", () => {
    const seedance = compileCamera(video("seedance-2.5"), "Rain.", ["push-in"]);
    const kling = compileCamera(video("openrouter:kwaivgi/kling-v3.0-pro"), "Rain.", ["push-in"]);
    assert.match(seedance.prompt, /slowly pushes in/);
    assert.match(kling.prompt, /Slow push in on the subject/);
    assert.notEqual(seedance.prompt, kling.prompt);
  });

  it("maps Static to camera_fixed on Seedance 1.0 Pro and leaves that chip out of the prompt", () => {
    const model = video("seedance-1-0-pro-250528");
    const compiled = compileCamera(model, "a paper boat in the rain", ["static", "push-in"]);
    assert.equal(compiled.cameraFixed, true);
    assert.match(compiled.prompt, /slowly pushes in/);
    assert.equal(compiled.prompt.includes("locked"), false);
    const applied = applyCameraMoves(model, request(model, { cameraMoves: ["static", "push-in"], cameraFixed: true }));
    assert.equal(applied.cameraFixed, true);
    assert.equal("cameraMoves" in applied, false);
    const body = buildModelArkVideo({ ...applied, model: "seedance-1-0-pro-250528" });
    assert.equal(body.camera_fixed, true);
    assert.equal(body.content[0].type === "text" && body.content[0].text, compiled.prompt);
  });

  it("does not send camera_fixed for Seedance 2.0", () => {
    const model = video("dreamina-seedance-2-0-260128");
    const applied = applyCameraMoves(model, request(model, { cameraMove: "static", cameraFixed: true }));
    assert.match(applied.prompt, /locked off/);
    assert.equal(applied.cameraFixed, undefined);
    const body = buildModelArkVideo({ ...applied, model: "dreamina-seedance-2-0-260128" });
    assert.equal("camera_fixed" in body, false);
  });

  it("keeps the chip text when the model has no wired native parameter", () => {
    const model = video("openrouter:minimax/hailuo-3-max");
    assert.equal(model.capabilities.camera, false);
    const compiled = compileCamera(model, "Rain.", ["push-in", "pan-left"]);
    const pushAt = compiled.prompt.indexOf("pushes in toward the subject");
    const panAt = compiled.prompt.indexOf("pans left");
    assert.ok(pushAt !== -1 && pushAt < panAt);
    assert.equal(compiled.cameraFixed, undefined);
    const applied = applyCameraMoves(model, request(model, { prompt: "Rain.", cameraMoves: ["push-in", "pan-left"] }));
    assert.equal(applied.prompt, compiled.prompt);
    const body = buildOpenRouterVideo(applied, "minimax/hailuo-3-max");
    assert.equal(body.prompt, compiled.prompt);
    assert.equal("camera_fixed" in body, false);
  });

  it("appends a prompt line for ArgoLink and OpenRouter", async () => {
    const argo = video("seedance-2.5");
    const argoApplied = applyCameraMoves(argo, request(argo, { cameraMoves: ["orbit"] }));
    const argoBody = await buildArgoVideoBody({ apiKey: "local-test" }, { ...argoApplied, model: "seedance-2.5" });
    assert.match(argoBody.prompt, /orbits around the subject/);
    assert.equal("camera_fixed" in argoBody, false);

    const veo = video("openrouter:google/veo-3.1-fast");
    const veoApplied = applyCameraMoves(veo, request(veo, { cameraMove: "pan-left" }));
    const veoBody = buildOpenRouterVideo(veoApplied, "google/veo-3.1-fast");
    assert.match(String(veoBody.prompt), /pans left across the scene/);
    assert.equal("camera_fixed" in veoBody, false);
  });

  it("hides the picker where a camera line would do nothing", () => {
    const upscale = video("openrouter:black-forest-labs/flux-video-upscale");
    const avatar = video("openrouter:heygen/avatar-iv");
    assert.equal(compileCamera(upscale, "make it sharper", ["dolly-zoom"]).prompt, "make it sharper");
    assert.match(videoRequestError(avatar, request(avatar, { cameraMoves: ["pan-left"] })) ?? "", /doesn't take camera moves/);
  });

  it("refuses a camera parameter that is not verified", () => {
    const model = structuredClone(video("seedance-1-0-pro-250528"));
    model.id = "invented-camera";
    model.capabilities = {
      ...model.capabilities,
      camera: { params: ["camera_control"] },
    } as unknown as VideoModel["capabilities"];
    assert.throws(() => assertRegistry([model]), /not verified/);
  });
});

describe("camera chip Reuse", () => {
  it("restores chips in order, and a single legacy preset as one chip", () => {
    const model = video("seedance-2.5");
    const prompt = "Rain on @Image 1";
    const chips = ["tilt-up", "pan-right", "handheld"];
    const req = request(model, { prompt, cameraMoves: chips });
    const syntax = mentionSyntax(model.refSyntax);
    const outbound = applyCameraMoves(model, { ...req, prompt: normalizeMentions(req.prompt, syntax) });

    const stored = { prompt: req.prompt, cameraMoves: req.cameraMoves };
    assert.equal(stored.prompt, prompt);
    assert.equal(stored.prompt.includes("tilts"), false);
    const tiltAt = outbound.prompt.indexOf("tilts up");
    const panAt = outbound.prompt.indexOf("pans smoothly to the right");
    const handAt = outbound.prompt.indexOf("handheld");
    assert.ok(tiltAt !== -1 && tiltAt < panAt && panAt < handAt);

    assert.deepEqual(keptCameraMoves(model, stored.cameraMoves), chips);
    const again = applyCameraMoves(model, {
      ...req,
      prompt: normalizeMentions(stored.prompt, syntax),
      cameraMoves: keptCameraMoves(model, stored.cameraMoves),
    });
    assert.equal(again.prompt, outbound.prompt);

    assert.deepEqual(keptCameraMoves(model, undefined, "crane-up"), ["crane-up"]);
    const legacy = applyCameraMoves(model, request(model, { prompt, cameraMove: "crane-up" }));
    assert.match(legacy.prompt, /cranes upward/);
    assert.equal(legacy.prompt.includes(prompt) || legacy.prompt.startsWith("Rain"), true);

    const avatar = video("openrouter:heygen/avatar-iv");
    assert.deepEqual(keptCameraMoves(avatar, chips, "push-in"), []);
  });
});
