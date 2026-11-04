import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { GenerateRequest } from "../types";
import { buildOpenRouterImage } from "../registry/bodies";
import {
  buildOpenRouterVideo,
  fetchOpenRouterMedia,
  generateOpenRouterImages,
  isOpenRouterHost,
  openRouterImageFile,
  openRouterProvider,
} from "./openrouter";

const KEY = "sk-or-v1-test-key-do-not-leak-9f3a";
const API = "https://openrouter.ai/api/v1";

interface Call {
  url: string;
  method: string;
  authorization: string | null;
  body: string | undefined;
  referer: string | null;
}

const calls: Call[] = [];
const originalFetch = globalThis.fetch;

function json(status: number, body: unknown, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function install(handler: (call: Call) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.href : String(input);
    const headers = new Headers(init?.headers);
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
      body: typeof init?.body === "string" ? init.body : undefined,
      referer: headers.get("http-referer"),
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  calls.length = 0;
});

function assertKeyStayedOnOpenRouter(key = KEY) {
  for (const call of calls) {
    const url = new URL(call.url);
    const blob = `${call.url}\n${call.authorization ?? ""}\n${call.body ?? ""}`;
    assert.equal(blob.includes(key), url.protocol === "https:" && isOpenRouterHost(url.hostname), call.url);
    if (url.protocol !== "https:" || !isOpenRouterHost(url.hostname)) assert.equal(call.authorization, null, call.url);
    else assert.equal(call.authorization, `Bearer ${key}`, call.url);
  }
}

function request(model: string, duration: number): GenerateRequest {
  return {
    model,
    prompt: "a paper boat in the rain",
    mode: "frames",
    ratio: "16:9",
    resolution: "720p",
    duration,
    generateAudio: false,
    firstFrame: "https://cdn.example/start.jpg",
  };
}

describe("openrouter video client", () => {
  it("submits, polls, completes, and returns the mp4 for Seedance, Kling, and Veo", async () => {
    const provider = openRouterProvider({ apiKey: KEY });
    const models = [
      ["bytedance/seedance-2.5", 5],
      ["kwaivgi/kling-v3.0-pro", 5],
      ["google/veo-3.1-fast", 4],
    ] as const;

    for (const [model, duration] of models) {
      calls.length = 0;
      const jobId = `job-${model.replaceAll("/", "-")}`;
      const unsigned = `${API}/videos/${jobId}/content?index=0`;
      const signed = "https://cdn.example/signed.mp4";
      const script = [
        json(202, { id: jobId, polling_url: "https://evil.example/steal", status: "pending" }),
        json(200, { id: jobId, status: "pending" }),
        json(200, { id: jobId, status: "in_progress" }),
        json(200, { id: jobId, status: "completed", unsigned_urls: [unsigned], urls: [signed] }),
        new Response("mp4-bytes", { status: 200, headers: { "content-type": "video/mp4", "content-length": "9" } }),
      ];
      install(() => script.shift()!);

      const submitted = await provider.createTask(request(model, duration));
      assert.equal(submitted.taskId, jobId);
      assert.equal(calls[0].method, "POST");
      assert.equal(calls[0].url, `${API}/videos`);
      assert.equal(calls[0].authorization, `Bearer ${KEY}`);
      const body = JSON.parse(calls[0].body!);
      assert.equal(body.model, model);
      assert.equal(body.prompt, "a paper boat in the rain");
      assert.equal(body.duration, duration);
      assert.equal(body.resolution, "720p");
      assert.equal(body.aspect_ratio, "16:9");
      assert.equal(body.generate_audio, false);
      assert.deepEqual(body.frame_images, [
        { type: "image_url", image_url: { url: "https://cdn.example/start.jpg" }, frame_type: "first_frame" },
      ]);
      assert.equal(JSON.stringify(body).includes(KEY), false);
      assert.equal(calls.some((call) => call.url.includes("evil.example")), false);

      assert.equal((await provider.getTask(jobId)).status, "queued");
      assert.equal(calls[1].url, `${API}/videos/${encodeURIComponent(jobId)}`);
      assert.equal((await provider.getTask(jobId)).status, "running");
      const done = await provider.getTask(jobId);
      assert.equal(done.status, "succeeded");
      assert.equal(done.videoUrl, unsigned);

      const file = await provider.fetchVideo(jobId, { videoUrl: done.videoUrl });
      assert.equal(await file.text(), "mp4-bytes");
      assert.equal(calls.at(-1)?.authorization, `Bearer ${KEY}`);
      assert.equal(calls.at(-1)?.url, unsigned);
      assertKeyStayedOnOpenRouter();
    }
  });

  it("maps a failed job and a rejected key without echoing the key", async () => {
    const provider = openRouterProvider({ apiKey: KEY });
    install((call) => {
      if (call.method === "POST") return json(401, { error: { message: `bad key ${KEY}`, code: 401 } });
      return json(200, { id: "job-1", status: "failed", error: `exploded ${KEY}` });
    });

    await assert.rejects(() => provider.createTask(request("google/veo-3.1-fast", 4)), (err: unknown) => {
      assert.equal((err as Error).message.includes(KEY), false);
      assert.match((err as Error).message, /bad key \[redacted\]/);
      return true;
    });

    const failed = await provider.getTask("job-1");
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "exploded [redacted]");
    assert.equal(JSON.stringify(failed).includes(KEY), false);
    assertKeyStayedOnOpenRouter();
  });

  it("never sends the key off OpenRouter, including download redirects", async () => {
    const provider = openRouterProvider({ apiKey: KEY });
    install(() => json(200, { status: "completed" }));

    const blocked = [
      "http://openrouter.ai/api/v1/videos/job/content",
      "https://user:pass@openrouter.ai/api/v1/videos/job/content",
      `https://openrouter.ai/api/v1/videos/job/content?key=${KEY}`,
      "https://127.0.0.1/video.mp4",
      "https://10.0.0.8/video.mp4",
    ];
    for (const videoUrl of blocked) {
      calls.length = 0;
      await assert.rejects(() => provider.fetchVideo("job", { videoUrl }), /non-https|credentials|API key|non-public/);
      assert.equal(calls.length, 0, videoUrl);
    }

    calls.length = 0;
    install(() => new Response("cdn-bytes", { status: 200, headers: { "content-type": "video/mp4" } }));
    for (const videoUrl of [
      "https://cdn.example/out.mp4",
      "https://openrouter.ai.evil.com/out.mp4",
      "https://notopenrouter.ai/out.mp4",
    ]) {
      calls.length = 0;
      const file = await provider.fetchVideo("job", { videoUrl });
      assert.equal(await file.text(), "cdn-bytes");
      assert.equal(calls.length, 1, videoUrl);
      assert.equal(calls[0].authorization, null, videoUrl);
      assert.equal(calls[0].url.includes(KEY), false);
    }

    calls.length = 0;
    install((call) => {
      if (isOpenRouterHost(new URL(call.url).hostname)) {
        return new Response(null, { status: 302, headers: { location: "https://cdn.example/from-openrouter.mp4" } });
      }
      assert.equal(call.authorization, null);
      return new Response("redirected-mp4", { status: 200, headers: { "content-type": "video/mp4" } });
    });
    const redirected = await fetchOpenRouterMedia(KEY, `${API}/videos/job/content?index=0`);
    assert.equal(await redirected.text(), "redirected-mp4");
    assert.equal(calls[0].authorization, `Bearer ${KEY}`);
    assert.equal(calls[1].url, "https://cdn.example/from-openrouter.mp4");
    assert.equal(calls[1].authorization, null);
    assertKeyStayedOnOpenRouter();

    calls.length = 0;
    await assert.rejects(
      () => fetchOpenRouterMedia(KEY, `${API}/videos/job/content?next=${KEY}`),
      /contains the API key/,
    );
    assert.equal(calls.length, 0);
  });

  it("verifies a key with one call and reports a bad key", async () => {
    const provider = openRouterProvider({ apiKey: KEY });
    install((call) => {
      assert.equal(call.url, `${API}/key`);
      assert.equal(call.method, "GET");
      return json(200, { data: { limit_remaining: 4.5 } });
    });
    assert.deepEqual(await provider.verifyKey(), { detail: "$4.50 left on this key" });
    assert.equal(calls.length, 1);
    assertKeyStayedOnOpenRouter();

    calls.length = 0;
    install(() => json(401, { error: { message: "User not found.", code: 401 } }));
    await assert.rejects(() => provider.verifyKey(), (err: unknown) => {
      assert.equal((err as Error).message, "User not found.");
      assert.equal((err as Error).message.includes(KEY), false);
      return true;
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${API}/key`);
  });
});

describe("openrouter images", () => {
  it("fans out Nano Banana and posts GPT Image once, without the key on a CDN download", async () => {
    const google = buildOpenRouterImage(
      { prompt: "a red door", resolution: "2k", count: 2, aspect: "1:1" },
      "google/gemini-nano-banana-2.1",
    );
    assert.equal(google.times, 2);
    assert.equal(google.body.n, 1);
    assert.equal(google.body.resolution, "2K");
    assert.equal(JSON.stringify(google).includes(KEY), false);

    const gpt = buildOpenRouterImage(
      { prompt: "a red door", resolution: "2k", quality: "high", count: 2 },
      "openai/gpt-image-2.5-sunburst",
    );
    assert.equal(gpt.times, 1);
    assert.equal(gpt.body.n, 2);
    assert.equal(gpt.body.quality, "high");
    assert.equal("resolution" in gpt.body, false);
    assert.equal(gpt.body.aspect_ratio, "auto");

    install((call) => {
      assert.equal(call.url, `${API}/images`);
      assert.equal(call.method, "POST");
      assert.equal(call.authorization, `Bearer ${KEY}`);
      return json(200, { data: [{ b64_json: "aGVsbG8=", media_type: "image/png" }] });
    });
    const items = await generateOpenRouterImages(KEY, google);
    assert.equal(calls.length, 2);
    assert.equal(items.length, 2);
    const file = await openRouterImageFile(KEY, items[0]);
    assert.equal(file.headers.get("content-type"), "image/png");
    assert.equal(await file.text(), "hello");
    assert.equal(calls.length, 2);

    calls.length = 0;
    install((call) => {
      assert.equal(call.authorization, null);
      return new Response("img", { status: 200, headers: { "content-type": "image/jpeg" } });
    });
    const remote = await openRouterImageFile(KEY, { url: "https://cdn.example/out.jpg" });
    assert.equal(await remote.text(), "img");
    assertKeyStayedOnOpenRouter();
  });
});

describe("openrouter video body", () => {
  it("sends reference media and omits an empty prompt", () => {
    const body = buildOpenRouterVideo(
      {
        ...request("alibaba/wan-3.0", 5),
        mode: "references",
        prompt: "  ",
        firstFrame: undefined,
        referenceImages: ["https://cdn.example/a.jpg"],
        referenceVideos: ["https://cdn.example/b.mp4"],
      },
      "alibaba/wan-3.0",
    );
    assert.equal("prompt" in body, false);
    assert.equal("frame_images" in body, false);
    assert.deepEqual(body.input_references, [
      { type: "image_url", image_url: { url: "https://cdn.example/a.jpg" } },
      { type: "video_url", video_url: { url: "https://cdn.example/b.mp4" } },
    ]);
    assert.equal(JSON.stringify(body).includes(KEY), false);
  });
});
