import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scrubSecret, savedKeyBody } from "./keys";
import { reportedUsd } from "./reportedCost";
import { CapError, capMessage, monthStart, overCap, startAfterCap } from "./spend";

describe("caps", () => {
  it("rejects before the provider call and names the cap and the month-to-date total", async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        startAfterCap({ source: "team", cap: 10, spent: 8.5, estimate: 2, now: Date.UTC(2026, 10, 3) }, async () => {
          calls += 1;
        }),
      (e: unknown) => {
        assert.ok(e instanceof CapError);
        assert.match(e.message, /\$10\.00/);
        assert.match(e.message, /\$8\.50/);
        assert.match(e.message, /November 2026/);
        return true;
      },
    );
    assert.equal(calls, 0);
    assert.equal(capMessage(10, 8.5, Date.UTC(2026, 10, 3)).includes("November 2026"), true);
  });

  it("lets an own-key generation through even when the team cap is already spent", async () => {
    let calls = 0;
    await startAfterCap({ source: "member", cap: 1, spent: 5, estimate: 3 }, async () => {
      calls += 1;
    });
    assert.equal(calls, 1);
    assert.equal(overCap(null, 100, 100), false);
    assert.equal(overCap(5, 4, 1), false);
    assert.equal(overCap(5, 4, 1.01), true);
  });

  it("starts the month on UTC midnight", () => {
    assert.equal(monthStart(Date.UTC(2026, 10, 3, 15)), Date.UTC(2026, 10, 1));
  });
});

describe("key material", () => {
  const secret = "sk-live-super-secret-key-ABCD";

  it("never puts a decrypted key in a save response or an error string", () => {
    const body = savedKeyBody(secret, "verified");
    assert.equal(JSON.stringify(body).includes(secret), false);
    assert.equal(JSON.stringify(body).includes("secret"), false);
    assert.deepEqual(Object.keys(body).sort(), ["detail", "last4", "ok"]);
    const error = scrubSecret(`Provider said ${secret} is invalid`, secret);
    assert.equal(error.includes(secret), false);
    assert.match(error, /\[redacted\]/);
  });

  it("reads a provider cost only from an explicit cost field", () => {
    assert.equal(reportedUsd({ usage: { cost: 0.42, total_tokens: 99 } }), 0.42);
    assert.equal(reportedUsd({ cost: 1.5 }), 1.5);
    assert.equal(reportedUsd({ usage: { total_tokens: 99 } }), undefined);
    assert.equal(reportedUsd({ billed_seconds: 5 }), undefined);
  });
});
