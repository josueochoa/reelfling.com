import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeMentions } from "../mentions";
import type { GenerateRequest } from "../types";
import { buildArgoVideoBody } from "../providers/argolink";
import { buildOpenRouterVideo } from "../providers/openrouter";
import { applyCameraMove } from "./camera-apply";
import { cameraMovesFor, keptCameraMove } from "./camera";
import { ALL_MODELS } from "./generated";
import { buildModelArkVideo } from "./bodies";
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

describe("camera move mapping", () => {
  it("maps Static to camera_fixed on Seedance 1.0 Pro and leaves the prompt alone", () => {
    const model = video("seedance-1-0-pro-250528");
    const prompt = "a paper boat in the rain";
    const applied = applyCameraMove(model, request(model, { prompt, cameraMove: "static" }));
    assert.equal(applied.prompt, prompt);
    assert.equal(applied.cameraFixed, true);
    assert.equal("cameraMove" in applied, false);
    const body = buildModelArkVideo({ ...applied, model: "seedance-1-0-pro-250528" });
    assert.equal(body.camera_fixed, true);
    assert.deepEqual(body.content[0], { type: "text", text: prompt });
  });

  it("writes Push in as a prompt suffix and does not send camera_fixed", () => {
    const model = video("seedance-1-0-pro-250528");
    const applied = applyCameraMove(model, request(model, { cameraMove: "push-in", cameraFixed: true }));
    assert.match(applied.prompt, /^a paper boat in the rain\. The camera slowly pushes in toward the subject\.$/);
    assert.equal(applied.cameraFixed, undefined);
    const body = buildModelArkVideo({ ...applied, model: "seedance-1-0-pro-250528" });
    assert.equal("camera_fixed" in body, false);
    assert.equal(body.content[0].type === "text" && body.content[0].text, applied.prompt);
  });

  it("does not send camera_fixed for Seedance 2.0, which is not on that parameter's model list", () => {
    const model = video("dreamina-seedance-2-0-260128");
    const applied = applyCameraMove(model, request(model, { cameraMove: "static", cameraFixed: true }));
    assert.match(applied.prompt, /locked off/);
    assert.equal(applied.cameraFixed, undefined);
    const body = buildModelArkVideo({ ...applied, model: "dreamina-seedance-2-0-260128" });
    assert.equal("camera_fixed" in body, false);
  });

  it("appends the instruction for ArgoLink and OpenRouter, which have no camera parameter", async () => {
    const argo = video("seedance-2.5");
    const argoApplied = applyCameraMove(argo, request(argo, { cameraMove: "orbit" }));
    const argoBody = await buildArgoVideoBody({ apiKey: "local-test" }, { ...argoApplied, model: "seedance-2.5" });
    assert.match(argoBody.prompt, /orbits around the subject/);
    assert.equal("camera_fixed" in argoBody, false);
    assert.equal("camera_control" in argoBody, false);

    const veo = video("openrouter:google/veo-3.1-fast");
    const veoApplied = applyCameraMove(veo, request(veo, { cameraMove: "pan-left" }));
    const veoBody = buildOpenRouterVideo(veoApplied, "google/veo-3.1-fast");
    assert.match(String(veoBody.prompt), /pans smoothly to the left/);
    assert.equal("camera_fixed" in veoBody, false);
    assert.equal("provider" in veoBody, false);
  });

  it("hides the picker where a camera line would do nothing", () => {
    assert.equal(cameraMovesFor(video("openrouter:black-forest-labs/flux-video-upscale")).length, 0);
    assert.equal(cameraMovesFor(video("openrouter:heygen/avatar-iv")).length, 0);
    const upscale = video("openrouter:black-forest-labs/flux-video-upscale");
    const prompt = "make it sharper";
    const applied = applyCameraMove(upscale, request(upscale, { prompt, cameraMove: "dolly-zoom" }));
    assert.equal(applied.prompt, prompt);
    const avatar = video("openrouter:heygen/avatar-iv");
    assert.match(
      videoRequestError(avatar, request(avatar, { cameraMove: "pan-left" })) ?? "",
      /doesn't take camera moves/,
    );
    assert.equal(videoRequestError(video("seedance-2.5"), request(video("seedance-2.5"), { cameraMove: "pan-left" })), null);
  });

  it("refuses a parameter the registry does not know how to send", () => {
    const model = structuredClone(video("seedance-1-0-pro-250528"));
    model.id = "invented-camera";
    model.capabilities = {
      ...model.capabilities,
      camera: { native: { static: { param: "camera_control", value: "left" } } },
    } as unknown as VideoModel["capabilities"];
    assert.throws(() => assertRegistry([model]), /camera_fixed/);
    const applied = applyCameraMove(model, request(model, { cameraMove: "static" }));
    const body = buildModelArkVideo({ ...applied, model: "seedance-1-0-pro-250528" });
    assert.equal(JSON.stringify(body).includes("camera_control"), false);
    assert.equal("camera_fixed" in body, false);
  });
});

describe("camera move Reuse", () => {
  it("restores the preset and does not show or stack the instruction", () => {
    const model = video("seedance-2.5");
    const prompt = "Rain on @Image 1";
    const req = request(model, { prompt, cameraMove: "crane-up" });
    const syntax = mentionSyntax(model.refSyntax);
    const outbound = applyCameraMove(model, { ...req, prompt: normalizeMentions(req.prompt, syntax) });

    // What POST /api/generations stores. The provider sentence is not in it.
    const stored = { prompt: req.prompt, cameraMove: req.cameraMove };
    assert.equal(stored.prompt, "Rain on @Image 1");
    assert.equal(stored.prompt.includes("cranes"), false);
    assert.match(outbound.prompt, /Rain on @Image 1\. The camera cranes upward/);

    const restored = keptCameraMove(model, stored.cameraMove);
    assert.equal(restored, "crane-up");
    const again = applyCameraMove(model, { ...req, prompt: normalizeMentions(stored.prompt, syntax), cameraMove: restored });
    assert.equal(again.prompt, outbound.prompt);

    const avatar = video("openrouter:heygen/avatar-iv");
    assert.equal(keptCameraMove(avatar, stored.cameraMove), undefined);
  });
});
