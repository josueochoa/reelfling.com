import "../../../../scripts/next-als-preload.mjs";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external.js";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external.js";
import { HeadersAdapter } from "next/dist/server/web/spec-extension/adapters/headers.js";
import { RequestCookiesAdapter } from "next/dist/server/web/spec-extension/adapters/request-cookies.js";
import { RequestCookies } from "next/dist/server/web/spec-extension/cookies.js";
import { sha256 } from "@/lib/crypto";
import { setTestEnv, type AppEnv } from "@/lib/db";
import { saveKey } from "@/lib/keys";
import { falQueueInput } from "@/lib/providers/fal";
import { isVideo } from "@/lib/registry";
import { ALL_MODELS, FAL_VIDEO_ENDPOINTS } from "@/lib/registry/generated";
import type { VideoModel } from "@/lib/registry/types";

const USER = "user-1";
const TOKEN = "session-token";
/** Distinctive fake key. The refusal must not echo it or put it on a request. */
const KEY = "rf_test_fal_key_do_not_send_9f3a";

const database = new DatabaseSync(":memory:");
database.exec("PRAGMA foreign_keys = ON");
for (const file of readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort()) {
  database.exec(readFileSync(join("migrations", file), "utf8"));
}
database.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").run(USER, "a@b.c", 1);
database
  .prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
  .run(sha256(TOKEN), USER, Date.now() + 86_400_000, Date.now());

function fakeD1(db: DatabaseSync) {
  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      return {
        bind(...params: (string | number | null)[]) {
          return {
            async first<T>() {
              return (stmt.get(...params) as T | undefined) ?? null;
            },
            async all<T>() {
              return { results: stmt.all(...params) as T[] };
            },
            async run() {
              const info = stmt.run(...params);
              return { meta: { changes: Number(info.changes) } };
            },
          };
        },
      };
    },
  };
}

setTestEnv({
  DB: fakeD1(database) as unknown as AppEnv["DB"],
  AUTH_SECRET: "test-auth-secret-at-least-32-characters",
  AUTH_MODE: "google",
});

await saveKey(USER, "fal", KEY);

const { POST } = await import("./route");
const { PATCH: patchMe } = await import("../me/route");

type Storage = { run: <T>(store: object, fn: () => Promise<T>) => Promise<T> };

/** `requireUser` reads cookies through Next's request store. */
function asRequest<T>(fn: () => Promise<T>) {
  const headers = HeadersAdapter.seal(new Headers());
  const cookies = RequestCookiesAdapter.seal(new RequestCookies(new Headers({ cookie: `sid=${TOKEN}` })));
  const work = workAsyncStorage as unknown as Storage;
  const unit = workUnitAsyncStorage as unknown as Storage;
  return work.run({ forceStatic: false }, () =>
    unit.run({ type: "request", phase: "render", headers, cookies }, fn),
  );
}

const originalFetch = globalThis.fetch;
const originalError = console.error;
let calls: { url: string; body: string }[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.error = originalError;
  calls = [];
  database.prepare("DELETE FROM generations").run();
});

const IMAGE_URL = "https://cdn.example/frame.png";
const VIDEO_URL = "https://cdn.example/clip.mp4";

function modelFor(endpoint: string): VideoModel {
  const model = ALL_MODELS.find(
    (item) => isVideo(item) && item.routes.some((route) => route.provider === "fal" && route.endpoint === endpoint),
  );
  assert.ok(model && isVideo(model) && model.inputs, endpoint);
  return model;
}

/** A request this model's caps accept, with https media when the schema takes it. */
function requestFor(model: VideoModel) {
  const caps = model.capabilities;
  const ratio = caps.ratios.find((item) => item !== "auto" && item !== "adaptive") ?? "16:9";
  const resolution = caps.resolutions.includes("720p") ? "720p" : (caps.resolutions[0] ?? "720p");
  const frames = caps.references.image === 0 && caps.frames.start;
  const generateAudio = !!caps.audio;
  return {
    model: model.id,
    route: "fal",
    prompt: "a boat on a lake",
    mode: frames ? "frames" : "references",
    ratio,
    resolution,
    duration: caps.durations?.default ?? 5,
    ...(generateAudio ? { generateAudio: true } : {}),
    ...(frames ? { firstFrame: IMAGE_URL } : {}),
    ...(!frames && caps.references.image > 0 ? { referenceImages: [IMAGE_URL] } : {}),
    ...(!frames && caps.references.video > 0 ? { referenceVideos: [VIDEO_URL] } : {}),
  };
}

function providerInput(model: VideoModel, req: ReturnType<typeof requestFor>) {
  return {
    prompt: req.prompt,
    duration: req.duration,
    resolution: req.resolution,
    ratio: req.ratio,
    generateAudio: req.generateAudio,
    firstFrame: "firstFrame" in req ? req.firstFrame : undefined,
    referenceImages: "referenceImages" in req ? req.referenceImages : undefined,
    referenceVideos: "referenceVideos" in req ? req.referenceVideos : undefined,
  };
}

function installFetch(refuse: boolean) {
  calls = [];
  console.error = () => {};
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ url, body });
    if (refuse) return new Response("provider should not be called", { status: 500 });
    return new Response(
      JSON.stringify({
        request_id: "req-checked",
        status_url: "https://queue.fal.run/status/req-checked",
        response_url: "https://queue.fal.run/response/req-checked",
        cancel_url: "https://queue.fal.run/cancel/req-checked",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

async function post(body: unknown) {
  return asRequest(() =>
    POST(
      new Request("https://internal.invalid/api/generations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  );
}

describe("POST /api/generations", () => {
  it("refuses a fal video route the studio cannot submit and does not call the provider", async () => {
    for (const model of [
      "fal:fal-ai/kling-video/v3/pro/text-to-video",
      "fal:fal-ai/wan/v2.2-a14b/text-to-video",
      "fal:fal-ai/minimax/video-01/image-to-video",
    ]) {
      installFetch(true);
      const res = await post({
        model,
        route: "fal",
        prompt: "a boat on a lake",
        mode: "references",
        ratio: "16:9",
        resolution: "720p",
        duration: 5,
        generateAudio: true,
      });
      const body = await res.text();
      assert.equal(res.status, 400, body);
      assert.equal(JSON.parse(body).error, "This model isn't available on the video tab.");
      assert.equal(body.includes(KEY), false);
      assert.deepEqual(calls, []);
    }
    const rows = database.prepare("SELECT COUNT(*) AS n FROM generations").get() as { n: number };
    assert.equal(rows.n, 0);
  });

  it("submits each schema-checked fal video with that model's body", async () => {
    assert.ok(FAL_VIDEO_ENDPOINTS.size > 0);
    for (const endpoint of FAL_VIDEO_ENDPOINTS) {
      const model = modelFor(endpoint);
      const req = requestFor(model);
      installFetch(false);
      const res = await post(req);
      const text = await res.text();
      assert.equal(res.status, 201, `${endpoint} ${text}`);
      assert.equal(text.includes(KEY), false);
      assert.equal(calls.length, 1, endpoint);
      const call = calls[0];
      assert.equal(call.url, `https://queue.fal.run/${endpoint}`);
      assert.equal(call.url.includes(KEY), false);
      assert.equal(call.body.includes(KEY), false);
      const sent = JSON.parse(call.body) as Record<string, unknown>;
      const input = providerInput(model, req);
      assert.deepEqual(sent, falQueueInput(input, model.inputs));
      assert.notDeepEqual(sent, falQueueInput(input));
    }
  });

  it("maps Kling keyframes into the published fields and refuses a model whose schema has none", async () => {
    const kling = modelFor("kling/v4/image-to-video");
    const middle = ["https://cdn.example/mid.jpg"];
    installFetch(false);
    const res = await post({
      ...requestFor(kling),
      lastFrame: "https://cdn.example/end.jpg",
      middleFrames: middle,
    });
    const text = await res.text();
    assert.equal(res.status, 201, text);
    assert.equal(text.includes(KEY), false);
    const sent = JSON.parse(calls[0].body) as Record<string, unknown>;
    assert.equal(sent.start_image_url, IMAGE_URL);
    assert.deepEqual(sent.middle_image_urls, middle);
    assert.equal(sent.end_image_url, "https://cdn.example/end.jpg");
    assert.equal(calls[0].url.includes(KEY), false);

    const flux = modelFor("blackforestlabs/flux-3/keyframes-to-video");
    installFetch(false);
    const fluxRes = await post({
      ...requestFor(flux),
      middleFrames: middle,
      lastFrame: "https://cdn.example/end.jpg",
    });
    const fluxText = await fluxRes.text();
    assert.equal(fluxRes.status, 201, fluxText);
    const fluxSent = JSON.parse(calls[0].body) as { keyframes?: { image_url: string; frame_index: number }[] };
    assert.deepEqual(fluxSent.keyframes, [
      { image_url: IMAGE_URL, frame_index: 0 },
      { image_url: middle[0], frame_index: 60 },
      { image_url: "https://cdn.example/end.jpg", frame_index: 120 },
    ]);

    const wan = modelFor("alibaba/wan-3.0/image-to-video");
    installFetch(true);
    const rejected = await post({ ...requestFor(wan), middleFrames: middle });
    const rejectedText = await rejected.text();
    assert.equal(rejected.status, 400, rejectedText);
    assert.match(JSON.parse(rejectedText).error, /doesn't support keyframes/);
    assert.equal(rejectedText.includes(KEY), false);
    assert.deepEqual(calls, []);
  });

  it("rejects malformed middleFrames with 400 and does not call the provider", async () => {
    const kling = modelFor("kling/v4/image-to-video");
    const base = { ...requestFor(kling), lastFrame: "https://cdn.example/end.jpg" };
    const shapes: [string, unknown][] = [
      ["string", "https://cdn.example/mid.jpg"],
      ["object", { url: "https://cdn.example/mid.jpg" }],
      ["number", 1],
      ["non-string entry", [1]],
      ["object entry", [{ url: "https://cdn.example/mid.jpg" }]],
      ["empty entry", [""]],
      ["null entry", [null]],
      ["invalid entry", ["not-a-url"]],
      ["http entry", ["http://cdn.example/mid.jpg"]],
      ["key entry", [KEY]],
    ];
    for (const [label, middleFrames] of shapes) {
      installFetch(true);
      const res = await post({ ...base, middleFrames });
      const text = await res.text();
      assert.equal(res.status, 400, `${label} ${text}`);
      assert.equal(JSON.parse(text).error, "Keyframes must be a list of images");
      assert.equal(text.includes(KEY), false, label);
      assert.deepEqual(calls, [], label);
    }
    installFetch(true);
    const upload = await post({ ...base, middleFrames: ["upload:uploads/mid.jpg"] });
    const uploadText = await upload.text();
    assert.equal(upload.status, 400, uploadText);
    assert.equal(JSON.parse(uploadText).error, "A reference is no longer in your uploads. Remove it and add it again.");
    assert.equal(uploadText.includes(KEY), false);
    assert.deepEqual(calls, []);
    const rows = database.prepare("SELECT COUNT(*) AS n FROM generations").get() as { n: number };
    assert.equal(rows.n, 0);
  });

  it("rejects a missing continueFrom before any provider call", async () => {
    const model = modelFor("xai/grok-imagine-video/v1.5/image-to-video");
    installFetch(true);
    const res = await post({ ...requestFor(model), continueFrom: "missing-generation" });
    const text = await res.text();
    assert.equal(res.status, 400, text);
    assert.equal(JSON.parse(text).error, "That video is no longer in your feed.");
    assert.equal(text.includes(KEY), false);
    assert.deepEqual(calls, []);
    const rows = database.prepare("SELECT COUNT(*) AS n FROM generations").get() as { n: number };
    assert.equal(rows.n, 0);
  });
});

describe("PATCH /api/me", () => {
  it("does not store fal as the route for a fal-only video model", async () => {
    for (const modelId of [
      "fal:fal-ai/kling-video/v3/pro/text-to-video",
      "fal:fal-ai/wan/v2.2-a14b/text-to-video",
      "fal:fal-ai/minimax/video-01/image-to-video",
      "fal:kling/v4/text-to-video",
      "fal:alibaba/wan-3.0/reference-to-video",
      "fal:minimax/h3/text-to-video",
    ]) {
      const res = await asRequest(() =>
        patchMe(
          new Request("https://internal.invalid/api/me", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ modelId, provider: "fal" }),
          }),
        ),
      );
      const text = await res.text();
      assert.equal(res.status, 400, `${modelId} ${text}`);
      assert.equal(JSON.parse(text).error, "That model has no stored route on this provider");
      assert.equal(text.includes(KEY), false);
      const row = database
        .prepare("SELECT provider FROM route_preferences WHERE user_id = ? AND model_id = ?")
        .get(USER, modelId) as { provider: string } | undefined;
      assert.equal(row, undefined, modelId);
    }
  });

  it("still stores a studio route the model can choose", async () => {
    const res = await asRequest(() =>
      patchMe(
        new Request("https://internal.invalid/api/me", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ modelId: "nano-banana-2.1", provider: "openrouter" }),
        }),
      ),
    );
    const text = await res.text();
    assert.equal(res.status, 200, text);
    assert.equal(JSON.parse(text).ok, true);
    const row = database
      .prepare("SELECT provider FROM route_preferences WHERE user_id = ? AND model_id = ?")
      .get(USER, "nano-banana-2.1") as { provider: string };
    assert.equal(row.provider, "openrouter");
  });
});
