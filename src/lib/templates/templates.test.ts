import "../../../scripts/next-als-preload.mjs";
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
import { normalizeMentions } from "@/lib/mentions";
import { falQueueInput } from "@/lib/providers/fal";
import { buildOpenRouterVideo } from "@/lib/providers/openrouter";
import { isStudioProvider, isVideo, mentionSyntax, videoRequestError } from "@/lib/registry";
import { buildModelArkVideo } from "@/lib/registry/bodies";
import { catalogModel, FAL_VIDEO_ENDPOINTS } from "@/lib/registry/generated";
import type { Generation } from "@/lib/types";
import {
  TEMPLATES,
  buildTemplateRequest,
  categoryLabel,
  getTemplate,
  previewOf,
  restoredSlotInputs,
  slotErrors,
  type SlotInput,
  type VideoTemplate,
} from "./templates";

const BANNED = ["higgsfield", "vidu", "kling", "seedance", "byteplus", "openrouter", "fal.ai", "modelark"];
const LINE = "Say it once, then stop.";
const USER = "user-templates";
const TOKEN = "template-session";
const KEYS = {
  fal: "rf_test_fal_key_do_not_send_9f3a",
  modelark: "rf_test_ark_key_do_not_send_9f3b",
  openrouter: "rf_test_or_key_do_not_send_9f3c",
};

function valuesFor(template: VideoTemplate, text = LINE): Record<string, SlotInput> {
  const values: Record<string, SlotInput> = {};
  for (const slot of template.slots) {
    if (slot.kind === "text") {
      if (slot.required) values[slot.id] = { text };
      continue;
    }
    values[slot.id] = {
      image: `https://cdn.example/${slot.id}.jpg`,
      key: `uploads/${slot.id}.jpg`,
    };
  }
  return values;
}

describe("template slots", () => {
  it("lists templates across the gallery categories and only shows a safe preview", () => {
    assert.ok(TEMPLATES.length >= 6, String(TEMPLATES.length));
    for (const category of ["effects", "product", "ugc"] as const) {
      assert.ok(TEMPLATES.filter((template) => template.category === category).length >= 2, category);
      assert.equal(categoryLabel(category).length > 0, true);
    }
    const names = new Set(TEMPLATES.map((template) => template.name));
    const prompts = new Set(TEMPLATES.map((template) => template.prompt));
    assert.equal(names.size, TEMPLATES.length);
    assert.equal(prompts.size, TEMPLATES.length);
    for (const template of TEMPLATES) {
      const copy = `${template.name}\n${template.summary}\n${template.prompt}`.toLowerCase();
      for (const word of BANNED) assert.equal(copy.includes(word), false, `${template.id} ${word}`);
      assert.equal(template.model.includes("o3"), false);
      assert.equal(template.model.includes("vidu"), false);
      assert.equal(template.model.includes("effects"), false);
      const spoken = /"\{\{line\}\}"|\bsays\b|\btalks\b/.test(template.prompt);
      if (spoken) {
        assert.equal(template.audio, true, `${template.id} speaks without audio`);
        const speaking = catalogModel(template.model);
        assert.ok(speaking && isVideo(speaking), template.id);
        assert.notEqual(speaking.capabilities.audio, false, template.id);
      }
      const shown = previewOf(template);
      if (template.preview?.video?.startsWith("https://")) assert.equal(shown.video, template.preview.video);
      else assert.equal(shown.video, undefined, template.id);
      if (template.preview?.poster?.startsWith("https://") || template.preview?.poster?.startsWith("/"))
        assert.equal(shown.poster, template.preview.poster);
      else assert.equal(shown.poster, undefined, template.id);
    }
    const preview = previewOf({
      preview: { video: "https://cdn.example/clip.mp4", poster: "javascript:alert(1)" },
    });
    assert.equal(preview.video, "https://cdn.example/clip.mp4");
    assert.equal(preview.poster, undefined);
    assert.equal(previewOf({ preview: { poster: "/previews/paper-peel.jpg" } }).poster, "/previews/paper-peel.jpg");
    assert.deepEqual(previewOf({ preview: { video: "", poster: "http://cdn.example/a.jpg" } }), {});
    assert.deepEqual(previewOf({}), {});
  });

  it("rejects a missing required slot and accepts the slots a template actually has", () => {
    const kitchen = getTemplate("kitchen-aside");
    assert.ok(kitchen);
    const empty = slotErrors(kitchen, {});
    assert.deepEqual(
      empty.map((error) => error.id),
      ["character", "location", "line"],
    );
    const partial = buildTemplateRequest(kitchen, { character: { image: "https://cdn.example/person.jpg" } });
    assert.equal(partial.request, undefined);
    assert.deepEqual(
      partial.errors.map((error) => error.id),
      ["location", "line"],
    );
    const mention = buildTemplateRequest(kitchen, { ...valuesFor(kitchen), line: { text: "hello @Image 1" } });
    assert.equal(mention.request, undefined);
    assert.equal(mention.errors[0]?.message, "Line can't include @mentions");
    const braces = buildTemplateRequest(kitchen, { ...valuesFor(kitchen), line: { text: "hello {{name" } });
    assert.equal(braces.request, undefined);
    assert.equal(braces.errors[0]?.message, "Line has an unclosed {{");

    const beam = getTemplate("crossing-beam");
    assert.ok(beam);
    const blank = buildTemplateRequest(beam, valuesFor(beam));
    assert.equal(blank.errors.length, 0);
    assert.ok(blank.request);
    assert.equal(blank.request.prompt.includes("{{"), false);
    assert.equal(blank.request.prompt.includes("  "), false);
    assert.equal(blank.request.prompt.includes("@Image 1"), true);
    assert.equal(blank.request.templateSlots?.some((slot) => slot.id === "line"), false);
    const noted = buildTemplateRequest(beam, { ...valuesFor(beam), line: { text: "Keep the beam warm." } });
    assert.ok(noted.request?.prompt.includes("unless a light note changes it. Keep the beam warm."));
    assert.equal(blank.request?.prompt.includes("Light note:"), false);
  });

  it("builds a reference-to-video body on each allowed route", () => {
    assert.equal(FAL_VIDEO_ENDPOINTS.has("fal-ai/kling-video/o3/pro/reference-to-video"), false);
    const routes = new Set<string>();
    for (const template of TEMPLATES) {
      routes.add(template.route);
      const model = catalogModel(template.model);
      assert.ok(model && isVideo(model), template.id);
      const route = model.routes.find((item) => item.provider === template.route);
      assert.ok(route, template.id);
      if (route.provider === "fal") {
        assert.equal(FAL_VIDEO_ENDPOINTS.has(route.endpoint), true, route.endpoint);
        assert.ok(model.inputs, template.id);
      } else {
        assert.equal(isStudioProvider(route.provider), true);
      }
      const built = buildTemplateRequest(template, valuesFor(template));
      assert.equal(built.errors.length, 0, template.id);
      const request = built.request;
      assert.ok(request);
      assert.equal(request.model, template.model);
      assert.equal(request.route, template.route);
      assert.equal(request.mode, "references");
      assert.equal(request.duration, template.duration);
      assert.equal(request.ratio, template.ratio);
      assert.equal(request.resolution, template.resolution);
      assert.equal(request.templateId, template.id);
      assert.equal(request.generateAudio, template.audio ? true : undefined);
      const images = template.slots.filter((slot) => slot.kind !== "text");
      assert.deepEqual(
        request.referenceImages,
        images.map((slot) => `https://cdn.example/${slot.id}.jpg`),
      );
      assert.equal(request.prompt.includes("{{"), false);
      images.forEach((slot, index) => {
        assert.equal(request.prompt.includes(`@Image ${index + 1}`), true, template.id);
      });
      assert.equal(videoRequestError(model, request), null, template.id);
      const again = getTemplate(request.templateId);
      assert.equal(again?.id, template.id);
      const restored = restoredSlotInputs({ templateId: request.templateId, templateSlots: request.templateSlots });
      for (const slot of images) assert.equal(restored[slot.id]?.key, `uploads/${slot.id}.jpg`);
      const line = template.slots.find((slot) => slot.id === "line" && slot.required);
      if (line) assert.equal(restored.line?.text, LINE);
    }
    assert.deepEqual([...routes].sort(), ["fal", "modelark", "openrouter"]);
  });
});

const database = new DatabaseSync(":memory:");
database.exec("PRAGMA foreign_keys = ON");
for (const file of readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort()) {
  database.exec(readFileSync(join("migrations", file), "utf8"));
}
database.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").run(USER, "templates@b.c", 1);
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

await saveKey(USER, "fal", KEYS.fal);
await saveKey(USER, "modelark", KEYS.modelark);
await saveKey(USER, "openrouter", KEYS.openrouter);

const { POST } = await import("../../app/api/generations/route");

type Storage = { run: <T>(store: object, fn: () => Promise<T>) => Promise<T> };

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

function installFetch() {
  calls = [];
  console.error = () => {};
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ url, body });
    const method = init?.method ?? "GET";
    if (method === "POST" && url.startsWith("https://queue.fal.run/")) {
      return Response.json({
        request_id: "req-template",
        status_url: "https://queue.fal.run/kling/v4/reference-to-video/requests/req-template/status",
        response_url: "https://queue.fal.run/kling/v4/reference-to-video/requests/req-template",
        cancel_url: "https://queue.fal.run/kling/v4/reference-to-video/requests/req-template/cancel",
      });
    }
    if (method === "POST" && url === "https://openrouter.ai/api/v1/videos") return Response.json({ id: "or-template" });
    if (method === "POST" && url.endsWith("/contents/generations/tasks")) return Response.json({ id: "ark-template" });
    return new Response(`unexpected ${method} ${url}`, { status: 500 });
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

describe("template generations", { concurrency: 1 }, () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.error = originalError;
    calls = [];
    database.prepare("DELETE FROM generations").run();
  });

  it("stores the template id and submits each route's normal generation body", async () => {
    for (const template of TEMPLATES) {
      const built = buildTemplateRequest(template, valuesFor(template));
      assert.ok(built.request);
      const model = catalogModel(template.model);
      assert.ok(model && isVideo(model));
      const route = model.routes.find((item) => item.provider === template.route);
      assert.ok(route);
      installFetch();
      const res = await post(built.request);
      const text = await res.text();
      assert.equal(res.status, 201, `${template.id} ${text}`);
      for (const secret of Object.values(KEYS)) {
        assert.equal(text.includes(secret), false, template.id);
        assert.equal(calls.some((call) => call.url.includes(secret) || call.body.includes(secret)), false);
      }
      assert.equal(calls.length, 1, template.id);
      const call = calls[0];
      if (template.route === "fal") assert.equal(call.url, `https://queue.fal.run/${route.endpoint}`);
      if (template.route === "openrouter") assert.equal(call.url, "https://openrouter.ai/api/v1/videos");
      if (template.route === "modelark") assert.equal(call.url.endsWith("/api/v3/contents/generations/tasks"), true);
      const sent = JSON.parse(call.body) as Record<string, unknown>;
      assert.equal("templateId" in sent, false);
      assert.equal(call.body.includes("templateSlots"), false);
      const normalized = normalizeMentions(built.request.prompt, mentionSyntax(model.refSyntax));
      const images = built.request.referenceImages ?? [];
      const providerReq = {
        model: route.endpoint,
        prompt: normalized,
        mode: "references" as const,
        ratio: template.ratio,
        resolution: template.resolution,
        duration: template.duration,
        referenceImages: images,
        ...(template.audio ? { generateAudio: true } : {}),
      };
      if (template.route === "fal") {
        assert.ok(model.inputs);
        assert.deepEqual(sent, falQueueInput(providerReq, model.inputs));
      } else if (template.route === "openrouter") {
        assert.deepEqual(sent, buildOpenRouterVideo(providerReq, route.endpoint));
      } else {
        assert.deepEqual(sent, buildModelArkVideo(providerReq));
      }
      const gen = JSON.parse(text) as Generation;
      assert.equal(gen.templateId, template.id);
      assert.equal(gen.model, template.model);
      assert.equal(gen.route, template.route);
      assert.equal(typeof gen.estimatedCost, "number");
      assert.ok((gen.estimatedCost ?? 0) > 0, template.id);
      const row = database.prepare("SELECT data FROM generations WHERE id = ?").get(gen.id) as { data: string };
      const stored = JSON.parse(row.data) as Generation;
      assert.equal(getTemplate(stored.templateId)?.id, template.id);
      const restored = restoredSlotInputs(stored);
      for (const slot of template.slots) {
        if (slot.kind === "text") {
          if (slot.required) assert.equal(restored[slot.id]?.text, LINE);
        } else {
          assert.equal(restored[slot.id]?.key, `uploads/${slot.id}.jpg`);
          assert.equal(restored[slot.id]?.image, `upload:uploads/${slot.id}.jpg`);
        }
      }
    }
  });

  it("rejects a non-array templateSlots with 400 and does not call the provider", async () => {
    const template = getTemplate("paper-peel");
    assert.ok(template);
    const built = buildTemplateRequest(template, valuesFor(template));
    assert.ok(built.request);
    for (const templateSlots of [{ length: 1 }, "uploads/person.jpg", 4]) {
      installFetch();
      const res = await post({ ...built.request, templateSlots });
      const text = await res.text();
      assert.equal(res.status, 400, text);
      assert.equal(JSON.parse(text).error, "Template slots must be a list");
      assert.deepEqual(calls, []);
      for (const secret of Object.values(KEYS)) assert.equal(text.includes(secret), false);
    }
    const rows = database.prepare("SELECT COUNT(*) AS n FROM generations").get() as { n: number };
    assert.equal(rows.n, 0);
  });

  it("refuses an unknown template id and a template on the wrong model without calling a provider", async () => {
    installFetch();
    const unknown = await post({
      model: "fal:kling/v4/reference-to-video",
      route: "fal",
      templateId: "not-a-template",
      prompt: "a person",
      mode: "references",
      ratio: "9:16",
      resolution: "720p",
      duration: 5,
      referenceImages: ["https://cdn.example/person.jpg"],
    });
    assert.equal(unknown.status, 400);
    const unknownBody = (await unknown.json()) as { error?: string };
    assert.equal(unknownBody.error, "Unknown template");
    assert.deepEqual(calls, []);

    installFetch();
    const mismatch = await post({
      model: "dreamina-seedance-2-0-260128",
      route: "modelark",
      templateId: "paper-peel",
      prompt: "a person",
      mode: "references",
      ratio: "9:16",
      resolution: "720p",
      duration: 5,
      referenceImages: ["https://cdn.example/person.jpg"],
    });
    const body = (await mismatch.json()) as { error?: string };
    assert.equal(mismatch.status, 400);
    assert.equal(body.error, "This template runs on a different model.");
    assert.deepEqual(calls, []);
    const rows = database.prepare("SELECT COUNT(*) AS n FROM generations").get() as { n: number };
    assert.equal(rows.n, 0);
  });
});
