import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { savedKeyBody } from "./keys";

describe("saved key response", () => {
  it("returns last4 and never the key", () => {
    const apiKey = "fal-secret-key-abcdefghij-WXYZ";
    const body = savedKeyBody(apiKey);
    assert.deepEqual(body, { ok: true, last4: "WXYZ" });
    assert.equal(JSON.stringify(body).includes(apiKey), false);

    const withDetail = savedKeyBody(apiKey, "$1.00 available");
    assert.equal(withDetail.detail, "$1.00 available");
    assert.equal(JSON.stringify(withDetail).includes(apiKey), false);
    assert.equal("apiKey" in withDetail, false);
  });
});
