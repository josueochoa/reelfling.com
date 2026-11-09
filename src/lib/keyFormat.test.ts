import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { wrongBoxError } from "./keyFormat";

// Only the prefix matters. A realistic-looking value trips secret scanning.
const OPENROUTER = "sk-or-v1-not-a-real-key";
const FAL = "0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0:0123456789abcdef0123456789abcdef";

describe("keys pasted in the wrong box", () => {
  it("catches an OpenRouter key in the ArgoLink box, and the reverse for fal", () => {
    assert.equal(
      wrongBoxError("argolink", OPENROUTER),
      "This looks like an OpenRouter key. Paste it in the OpenRouter box instead of ArgoLink.",
    );
    assert.match(wrongBoxError("modelark", ` ${FAL} `)!, /fal key/);
  });

  it("lets keys through in their own box, and keys with no telltale format anywhere", () => {
    assert.equal(wrongBoxError("openrouter", OPENROUTER), null);
    assert.equal(wrongBoxError("fal", FAL), null);
    assert.equal(wrongBoxError("argolink", "sk-0123456789abcdef"), null);
    assert.equal(wrongBoxError("openrouter", "sk-0123456789abcdef"), null);
  });
});
