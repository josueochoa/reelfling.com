import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { shouldCancelFal, shouldPollFal, storeFailureUpdate, storeGaveUp } from "../falTypes";
import {
  cancelFal,
  collectOutputs,
  endpointUrl,
  fetchFalOutput,
  fieldErrorsOf,
  isFalApiHost,
  outputBytes,
  pollFal,
  redactSecrets,
  submitFal,
  verifyFalKey,
  FalValidationError,
} from "./fal";

const KEY = "fal-test-key-do-not-leak-9f3a";
const ENDPOINT = "fal-ai/flux/schnell";
const STATUS_URL = "https://queue.fal.run/fal-ai/flux/requests/req_1/status";
const RESPONSE_URL = "https://queue.fal.run/fal-ai/flux/requests/req_1";
const CANCEL_URL = "https://queue.fal.run/fal-ai/flux/requests/req_1/cancel";

interface Call {
  url: string;
  method: string;
  authorization: string | null;
  body: string | undefined;
}

const calls: Call[] = [];
const originalFetch = globalThis.fetch;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
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
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  calls.length = 0;
});

function assertKeyStayedOnFal(key = KEY) {
  for (const call of calls) {
    const url = new URL(call.url);
    const blob = `${call.url}\n${call.authorization ?? ""}\n${call.body ?? ""}`;
    if (url.protocol !== "https:" || !isFalApiHost(url.hostname)) {
      assert.equal(blob.includes(key), false, call.url);
      assert.equal(call.authorization, null, call.url);
    }
  }
}

describe("fal queue client", () => {
  it("submits, polls through queued and running, then completes", async () => {
    const script = [
      json(200, {
        status: "IN_QUEUE",
        request_id: "req_1",
        status_url: STATUS_URL,
        response_url: RESPONSE_URL,
        cancel_url: CANCEL_URL,
      }),
      json(202, { status: "IN_QUEUE", request_id: "req_1", queue_position: 2 }),
      json(202, { status: "IN_PROGRESS", request_id: "req_1" }),
      json(200, { status: "COMPLETED", request_id: "req_1", metrics: { inference_time: 1.2 } }),
      json(200, {
        images: [{ url: "https://v3.fal.media/files/rabbit/out.png", content_type: "image/png", width: 1024, height: 1024 }],
        prompt: "a sunset",
      }),
    ];
    install(() => script.shift()!);

    const submitted = await submitFal(KEY, ENDPOINT, { prompt: "a sunset" });
    assert.equal(submitted.requestId, "req_1");
    assert.equal(submitted.statusUrl, STATUS_URL);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url, `https://queue.fal.run/${ENDPOINT}`);
    assert.equal(calls[0].authorization, `Key ${KEY}`);
    assert.deepEqual(JSON.parse(calls[0].body!), { prompt: "a sunset" });

    assert.equal((await pollFal(KEY, submitted)).status, "queued");
    assert.equal((await pollFal(KEY, submitted)).status, "running");
    const done = await pollFal(KEY, submitted);
    assert.equal(done.status, "succeeded");
    assert.deepEqual(done.outputs, [
      {
        url: "https://v3.fal.media/files/rabbit/out.png",
        contentType: "image/png",
        fileName: undefined,
        width: 1024,
        height: 1024,
      },
    ]);
    assert.equal(JSON.stringify(done.response).includes(KEY), false);
    assertKeyStayedOnFal();
  });

  it("maps a completed error and a 422 field error to failed", async () => {
    install((call) => {
      if (call.method === "POST") {
        return json(422, { detail: [{ loc: ["body", "prompt"], msg: "Field required", type: "missing" }] });
      }
      if (call.url.endsWith("/status")) {
        return json(200, { status: "COMPLETED", request_id: "req_1", error: "Model exploded" });
      }
      return json(500, { detail: "Model exploded", error_type: "internal_error" });
    });

    await assert.rejects(() => submitFal(KEY, ENDPOINT, {}), (err: unknown) => {
      assert.ok(err instanceof FalValidationError);
      assert.equal(err.status, 422);
      assert.deepEqual(err.fields, [{ field: "prompt", message: "Field required" }]);
      assert.equal(err.message.includes(KEY), false);
      return true;
    });

    const failed = await pollFal(KEY, { statusUrl: STATUS_URL, responseUrl: RESPONSE_URL });
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "Model exploded");
    assert.equal(JSON.stringify(failed).includes(KEY), false);
    assert.deepEqual(
      collectOutputs({
        audio_url: "https://v3.fal.media/files/a.mp3",
        video: { url: "https://v3.fal.media/files/b.mp4", file_name: "b.mp4" },
      }).map((file) => file.url),
      ["https://v3.fal.media/files/a.mp3", "https://v3.fal.media/files/b.mp4"],
    );
  });

  it("never sends the key to a non-fal host", async () => {
    install(() => json(200, { status: "COMPLETED", request_id: "req_1" }));

    const blocked = [
      "https://evil.example/status",
      "https://queue.fal.run.evil.com/status",
      "https://fal.ai.evil.com/status",
      "https://notfal.ai/status",
      "http://queue.fal.run/fal-ai/flux/requests/req_1/status",
      "https://user:pass@queue.fal.run/status",
      `https://queue.fal.run/status?key=${KEY}`,
    ];
    for (const statusUrl of blocked) {
      calls.length = 0;
      await assert.rejects(() => pollFal(KEY, { statusUrl, responseUrl: RESPONSE_URL }), /non-fal|non-https|credentials|contains the API key/);
      assert.equal(calls.length, 0, statusUrl);
    }

    await assert.rejects(() => submitFal(KEY, "https://evil.example/steal", { prompt: "x" }));
    assert.equal(calls.length, 0);

    calls.length = 0;
    await assert.rejects(() => pollFal(KEY, { statusUrl: STATUS_URL, responseUrl: "https://evil.example/steal" }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, STATUS_URL);
    assert.equal(calls[0].authorization, `Key ${KEY}`);
    assertKeyStayedOnFal();

    calls.length = 0;
    install(async (call) => {
      assert.equal(call.authorization, null);
      assert.equal(call.url.includes(KEY), false);
      return new Response("bytes", { status: 200, headers: { "content-type": "image/png" } });
    });
    const file = await fetchFalOutput("https://cdn.example.com/out.png");
    assert.equal(await file.text(), "bytes");
    const media = await fetchFalOutput("https://v3.fal.media/files/out.png");
    assert.equal(media.headers.get("content-type"), "image/png");
    assert.equal(calls.every((call) => call.authorization === null), true);
    await assert.rejects(() => fetchFalOutput("http://cdn.example.com/out.png"));
    await assert.rejects(() => fetchFalOutput("https://127.0.0.1/secret"));
    await assert.rejects(() => cancelFal(KEY, "https://evil.example/cancel"));
    assert.equal(calls.some((call) => call.url.includes("evil.example")), false);
  });

  it("verifies a key with one catalog call and rejects a bad key without echoing it", async () => {
    install((call) => {
      assert.equal(call.url, "https://api.fal.ai/v1/models?limit=1");
      assert.equal(call.authorization, `Key ${KEY}`);
      return json(200, { models: [], has_more: false });
    });
    assert.deepEqual(await verifyFalKey(KEY), {});
    assert.equal(calls.length, 1);

    calls.length = 0;
    install(() =>
      json(401, { error: { type: "authorization_error", message: "Invalid API key or malformed Authorization header" } }),
    );
    await assert.rejects(() => verifyFalKey(KEY), (err: Error) => {
      assert.match(err.message, /Invalid API key/);
      assert.equal(err.message.includes(KEY), false);
      return true;
    });
    assert.equal(calls.length, 1);
  });

  it("scrubs the key out of stored payloads and only cancels in-flight jobs", () => {
    const echoed = { prompt: `hello ${KEY}`, nested: { note: KEY } };
    const clean = JSON.stringify(redactSecrets(echoed, KEY));
    assert.equal(clean.includes(KEY), false);
    assert.match(clean, /\[redacted\]/);
    assert.deepEqual(fieldErrorsOf({ detail: [{ loc: ["body", "image_url"], msg: KEY }] }, KEY), [
      { field: "image_url", message: "[redacted]" },
    ]);
    assert.equal(endpointUrl(" fal-ai/flux/schnell/ "), "https://queue.fal.run/fal-ai/flux/schnell");
    assert.throws(() => endpointUrl("https://evil.example/x"));
    assert.equal(shouldCancelFal("queued"), true);
    assert.equal(shouldCancelFal("running"), true);
    assert.equal(shouldCancelFal("succeeded"), false);
    assert.equal(shouldCancelFal("failed"), false);
  });

  it("a failed output download fails the job and the tab stops polling", async () => {
    install((call) => {
      assert.equal(call.authorization, null);
      assert.equal(call.url.includes(KEY), false);
      return new Response("gone", { status: 404 });
    });
    let reason = "";
    await assert.rejects(() => fetchFalOutput("https://v3.fal.media/files/missing.png"), (err: Error) => {
      reason = err.message;
      assert.match(reason, /Couldn't download fal output \(404\)/);
      assert.equal(reason.includes(KEY), false);
      return true;
    });
    // One retry is allowed; the second failure is terminal and is not polled.
    assert.equal(storeGaveUp(1), false);
    assert.equal(storeGaveUp(2), true);
    const failed = storeFailureUpdate(reason);
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /Couldn't save the result/);
    assert.match(failed.error, /404/);
    assert.equal(failed.error.includes(KEY), false);
    assert.equal(shouldPollFal(failed.status), false);
    assert.equal(shouldPollFal("succeeded"), false);
    assert.equal(shouldPollFal("queued"), true);
    assert.equal(shouldPollFal("running"), true);
    assert.throws(() => outputBytes(null), /no size/);
    assert.throws(() => outputBytes("0"), /no size/);
    assert.equal(outputBytes("1200"), 1200);
  });

  it("cancels with PUT on the URL fal returned", async () => {
    install((call) => {
      assert.equal(call.method, "PUT");
      assert.equal(call.url, CANCEL_URL);
      assert.equal(call.authorization, `Key ${KEY}`);
      return json(202, { status: "CANCELLATION_REQUESTED" });
    });
    await cancelFal(KEY, CANCEL_URL);
    assert.equal(calls.length, 1);
  });
});
