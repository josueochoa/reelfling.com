import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { argoLink } from "./argolink";
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
