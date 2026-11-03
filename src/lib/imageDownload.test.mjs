import assert from "node:assert/strict";
import { test } from "node:test";
import { downloadGeneratedImage } from "./imageDownload.ts";

const originalFetch = globalThis.fetch;

function installFetch(handler) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  };
  return calls;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

function assertNoAuthorization(calls) {
  for (const call of calls) {
    const headers = new Headers(call.init?.headers ?? {});
    assert.equal(headers.get("authorization"), null, call.url);
    const raw = JSON.stringify(call.init ?? {});
    assert.equal(/authorization/i.test(raw), false, raw);
    assert.equal(/bearer/i.test(raw), false, raw);
  }
}

test("a public image URL is fetched once with no Authorization header", async () => {
  const calls = installFetch(
    async () => new Response("png-bytes", { status: 200, headers: { "content-type": "image/png" } }),
  );
  try {
    const res = await downloadGeneratedImage({ url: "https://cdn.example/picture.png" });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "png-bytes");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://cdn.example/picture.png");
    assert.equal(calls[0].init, undefined);
    assertNoAuthorization(calls);
  } finally {
    restoreFetch();
  }
});

test("401 and 403 are not retried, including lookalike ArgoLink hosts", async () => {
  const urls = [
    "https://cdn.example/generated/1.png",
    "https://evil-argolink.io/generated/1.png",
    "https://argolink.io.evil.example/generated/1.png",
    "https://not-argolink.io/generated/1.png",
    "https://cdn.argolink.io/generated/1.png",
    "https://argolink.io/v1/images/generated/1.png",
    "http://argolink.io/generated/1.png",
  ];
  try {
    for (const url of urls) {
      for (const status of [401, 403]) {
        const calls = installFetch(async () => new Response("denied", { status }));
        await assert.rejects(
          () => downloadGeneratedImage({ url }),
          (err) => {
            assert.ok(err instanceof Error);
            assert.equal(err.message, `Couldn't download the generated image (${status})`);
            assert.equal(/authorization/i.test(err.message), false);
            assert.equal(/bearer/i.test(err.message), false);
            assert.equal(err.message.includes(url), false);
            return true;
          },
        );
        assert.equal(calls.length, 1, `${status} ${url}`);
        assert.equal(calls[0].url, url);
        assertNoAuthorization(calls);
      }
    }
  } finally {
    restoreFetch();
  }
});

test("b64_json does not fetch", async () => {
  const calls = installFetch(async () => {
    throw new Error("fetch should not be called");
  });
  try {
    const res = await downloadGeneratedImage({ b64_json: Buffer.from("hi").toString("base64") });
    assert.equal(calls.length, 0);
    assert.equal(await res.text(), "hi");
    assert.equal(res.headers.get("content-type"), "image/jpeg");
  } finally {
    restoreFetch();
  }
});

test("missing image data throws before any request", async () => {
  const calls = installFetch(async () => {
    throw new Error("fetch should not be called");
  });
  try {
    await assert.rejects(() => downloadGeneratedImage({}), /without data/);
    assert.equal(calls.length, 0);
  } finally {
    restoreFetch();
  }
});
