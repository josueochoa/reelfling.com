import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { devMockProviders, isNextDev } from "./devMock";

const env = process.env as { NODE_ENV?: string; DEV_MOCK_PROVIDERS?: string };
const previousNode = env.NODE_ENV;
const previousFlag = env.DEV_MOCK_PROVIDERS;

afterEach(() => {
  env.NODE_ENV = previousNode;
  if (previousFlag === undefined) delete env.DEV_MOCK_PROVIDERS;
  else env.DEV_MOCK_PROVIDERS = previousFlag;
});

describe("dev provider mock", () => {
  it("stays off in production even when the flag is set", () => {
    env.NODE_ENV = "production";
    env.DEV_MOCK_PROVIDERS = "1";
    assert.equal(isNextDev(), false);
    assert.equal(devMockProviders(), false);
  });

  it("stays off in test runs", () => {
    env.NODE_ENV = "test";
    env.DEV_MOCK_PROVIDERS = "1";
    assert.equal(devMockProviders(), false);
  });
});

describe("dev seed route", () => {
  it("404s outside next dev and does not return a key", () => {
    const source = readFileSync(new URL("../app/api/dev/seed/route.ts", import.meta.url), "utf8");
    assert.match(source, /if \(!isNextDev\(\)\) return new Response\("Not found", \{ status: 404 \}\)/);
    assert.doesNotMatch(source, /Response\.json\([\s\S]*PLACEHOLDER/);
    assert.match(source, /return Response\.json\(\{ ok: true, videoId, imageId, teamId: team\.id \}\)/);
  });
});
