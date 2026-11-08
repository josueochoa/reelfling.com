import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { argoLink } from "./argolink";
import type { GenerateRequest } from "../types";
import { ProviderError, terminalPollUpdate } from "./types";

const KEY = "sk-argolink-TESTSECRET-do-not-store";

const originalFetch = globalThis.fetch;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function install(handler: () => Response | Promise<Response>) {
  globalThis.fetch = (() => handler()) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** What syncGeneration persists: a patch, or nothing when the row stays in flight. */
function storedFailure(e: unknown) {
  const patch = terminalPollUpdate(e);
  if (!patch) return undefined;
  return { ...patch, completedAt: 1 };
}

describe("ArgoLink video poll", () => {
  it("a 404 fails the job and the stored error does not contain the key", async () => {
    const provider = argoLink({ apiKey: KEY });
    install(() => json(404, { message: `task is not yours, key ${KEY}`, code: "not_found" }));
    const thrown = await provider.getTask("task-404").then(
      () => assert.fail("404 should throw"),
      (e: unknown) => e,
    );
    const stored = storedFailure(thrown);
    assert.equal(stored?.status, "failed");
    assert.equal(stored?.error, "The provider no longer has this task. It may belong to a different API key.");
    assert.equal(JSON.stringify(stored).includes(KEY), false);

    install(() => new Response(`plain body mentions ${KEY}`, { status: 404 }));
    const plain = await provider.getTask("task-404").then(
      () => assert.fail("404 should throw"),
      (e: unknown) => e,
    );
    const plainStored = storedFailure(plain);
    assert.equal(plainStored?.status, "failed");
    assert.equal(JSON.stringify(plainStored).includes(KEY), false);
  });

  it("a 5xx, 429, or network error leaves the job running", async () => {
    const provider = argoLink({ apiKey: KEY });
    install(() => json(503, { message: `upstream down, key ${KEY}` }));
    const server = await provider.getTask("task-slow").then(
      () => assert.fail("503 should throw"),
      (e: unknown) => e,
    );
    assert.ok(server instanceof ProviderError);
    assert.equal(server.status, 503);
    assert.equal(storedFailure(server), undefined);

    install(() => json(429, { message: `slow down ${KEY}` }));
    const limited = await provider.getTask("task-slow").then(
      () => assert.fail("429 should throw"),
      (e: unknown) => e,
    );
    assert.equal(storedFailure(limited), undefined);

    install(() => Promise.reject(new TypeError(`network ${KEY}`)));
    const network = await provider.getTask("task-slow").then(
      () => assert.fail("network error should throw"),
      (e: unknown) => e,
    );
    assert.ok(network instanceof TypeError);
    assert.equal(storedFailure(network), undefined);
  });

  it("a missing key fails the job without copying the thrown message", () => {
    const stored = storedFailure(new ProviderError(`Add your ArgoLink API key ${KEY} in Settings first.`, 400, "missing_key"));
    assert.equal(stored?.status, "failed");
    assert.equal(stored?.error, "Add your API key in Settings. This job can no longer be checked.");
    assert.equal(JSON.stringify(stored).includes(KEY), false);
  });
});

describe("ArgoLink video edit", () => {
  const SOURCE = "https://r2.example/uploads/clip.mov?X-Amz-Signature=abc";
  const editRequest: GenerateRequest = {
    model: "seedance-2.5",
    prompt: "  Edita el video: @Video 1 bajo la nieve, como @Image 1  ",
    mode: "edit",
    ratio: "16:9",
    resolution: "720p",
    duration: 5,
    generateAudio: true,
    editVideo: SOURCE,
    referenceImages: ["https://r2.example/uploads/snow.png"],
  };

  it("uploads the video first and sends it as the first reference video, without duration or ratio", async () => {
    const sent: { url: string; method: string; body?: unknown; type?: string | null }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
      sent.push({ url, method, body, type: new Headers(init?.headers).get("content-type") });
      if (url === SOURCE) return new Response(new Uint8Array(1234), { headers: { "content-type": "binary/octet-stream" } });
      if (url.endsWith("/v1/media/uploads"))
        return json(200, { upload_url: "https://upload.argolink.example/put", media_url: "https://media.argolink.example/clip.mov" });
      if (url === "https://upload.argolink.example/put") return new Response(null, { status: 200 });
      return json(200, { request_id: "req-edit" });
    }) as typeof fetch;

    const { taskId } = await argoLink({ apiKey: KEY }).createTask(editRequest);
    assert.equal(taskId, "req-edit");
    assert.deepEqual(
      sent.map((call) => `${call.method} ${call.url}`),
      [
        `GET ${SOURCE}`,
        "POST https://argolink.io/v1/media/uploads",
        "PUT https://upload.argolink.example/put",
        "POST https://argolink.io/v1/videos/generations",
      ],
    );
    assert.deepEqual(sent[1].body, { model: "seedance-2.5", type: "video", content_type: "video/quicktime", size_bytes: 1234 });
    assert.equal(sent[2].type, "video/quicktime");
    assert.deepEqual(sent[3].body, {
      model: "seedance-2.5",
      omni_reference_task_type: "edit",
      prompt: "Edita el video: @Video 1 bajo la nieve, como @Image 1",
      resolution: "720p",
      reference_videos: [{ url: "https://media.argolink.example/clip.mov" }],
      reference_images: [{ url: "https://r2.example/uploads/snow.png" }],
    });
  });

  it("shows the whole error, with a hint when the edit was read as another task", async () => {
    install(() => json(400, { error: { message: "Task type does not match the inputs", code: "TaskTypeMismatch" } }));
    const plain = { ...editRequest, editVideo: "data:video/mp4;base64,AAAA" };
    await assert.rejects(argoLink({ apiKey: KEY }).createTask(plain), (e: ProviderError) => {
      assert.equal(
        e.message,
        'Task type does not match the inputs (TaskTypeMismatch) The model didn\'t read the request as an edit. Start the prompt with "Edit the video:".',
      );
      assert.equal(e.code, "TaskTypeMismatch");
      return true;
    });

    install(() => json(200, { request_id: "r", status: "failed", error: { message: "Edit could not run", code: "TaskTypeMismatch" } }));
    const snap = await argoLink({ apiKey: KEY }).getTask("r");
    assert.match(snap.error!, /^Edit could not run \(TaskTypeMismatch\) The model didn't read/);

    install(() => json(200, { request_id: "r", status: "failed", error: { message: "Content policy", code: "OutputModeration" } }));
    assert.equal((await argoLink({ apiKey: KEY }).getTask("r")).error, "Content policy (OutputModeration)");
  });
});
