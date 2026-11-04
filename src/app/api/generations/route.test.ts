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
});
