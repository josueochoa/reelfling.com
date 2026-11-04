import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ALL_MODELS } from "../registry/generated";
import { isImage, isVideo } from "../registry/index";
import { falImageInput, falQueueInput, submitFal } from "./fal";

const KEY = "placeholder-fal-key";

const ENDPOINTS = [
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
  "bytedance/seedream/v5/pro/text-to-image",
  "bytedance/seedream/v5/pro/edit",
  "fal-ai/flux-2-pro",
  "fal-ai/flux-2-pro/edit",
  "ideogram/v4.5",
  "fal-ai/recraft/v4.1/text-to-image",
  "xai/grok-imagine-image/v2.0/edit",
  "fal-ai/z-image/turbo",
] as const;

const calls: { url: string; authorization: string | null; body: string }[] = [];
const originalFetch = globalThis.fetch;

function modelFor(endpoint: string) {
  const model = ALL_MODELS.find((item) => item.routes.some((route) => route.provider === "fal" && route.endpoint === endpoint));
  assert.ok(model, endpoint);
  return model;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  calls.length = 0;
});

describe("fal lineup adapter", () => {
  it("runs each listed endpoint once through the generic adapter with a mocked provider", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        authorization: headers.get("authorization"),
        body: typeof init?.body === "string" ? init.body : "",
      });
      assert.equal(url.includes(KEY), false);
      assert.equal(headers.get("authorization"), `Key ${KEY}`);
      return new Response(
        JSON.stringify({
          request_id: "req_mock",
          status_url: "https://queue.fal.run/fal-ai/flux/requests/req_mock/status",
          response_url: "https://queue.fal.run/fal-ai/flux/requests/req_mock",
          cancel_url: "https://queue.fal.run/fal-ai/flux/requests/req_mock/cancel",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    for (const endpoint of ENDPOINTS) {
      const model = modelFor(endpoint);
      const prompt = "a paper boat in the rain";
      const body = isVideo(model)
        ? falQueueInput(
            {
              prompt,
              duration: model.capabilities.durations?.default ?? 5,
              resolution: model.capabilities.resolutions[0],
              ratio: model.capabilities.ratios.find((ratio) => ratio !== "auto" && ratio !== "adaptive") ?? "16:9",
              firstFrame: model.capabilities.frames.start ? "https://cdn.example/start.jpg" : undefined,
              referenceImages: model.capabilities.references.image > 0 ? ["https://cdn.example/ref.jpg"] : undefined,
              referenceVideos: model.capabilities.references.video > 0 ? ["https://cdn.example/ref.mp4"] : undefined,
            },
            model.inputs,
          )
        : isImage(model)
          ? falImageInput(
              {
                prompt,
                ratio: model.capabilities.ratios.find((ratio) => ratio !== "auto") ?? "1:1",
                resolution: model.capabilities.resolutions[0],
                quality: model.capabilities.qualities?.[0],
                count: 1,
                images: model.capabilities.references.image > 0 ? ["https://cdn.example/ref.jpg"] : undefined,
              },
              model.inputs ?? {},
            )
          : undefined;
      assert.ok(body, endpoint);
      const submitted = await submitFal(KEY, endpoint, body);
      assert.equal(submitted.requestId, "req_mock");
      const call = calls.at(-1);
      assert.ok(call);
      assert.equal(call.url, `https://queue.fal.run/${endpoint}`);
      assert.equal(new URL(call.url).search, "");
      const sent = JSON.parse(call.body) as { prompt?: string };
      assert.equal(sent.prompt, prompt);
    }
    assert.equal(calls.length, ENDPOINTS.length);
  });
});
