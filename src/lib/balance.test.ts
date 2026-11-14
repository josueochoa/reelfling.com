import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { argoLinkBalance, falBalance, formatBalance, openRouterBalance } from "./balance";
import { argoBalance } from "./providers/argolink";
import { falAccountBalance } from "./providers/fal";
import { openRouterKeyBalance } from "./providers/openrouter";

const KEY = "sk-test-BALANCE-do-not-leak";
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Answers by URL and records what was asked, with the Authorization header. */
function serve(routes: Record<string, () => Response>) {
  const calls: { url: string; authorization: string | null }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    const answer = routes[url];
    return answer ? answer() : json(404, { message: "not found" });
  }) as typeof fetch;
  return calls;
}

describe("provider balances", () => {
  it("reads what each provider's response says is left", () => {
    assert.deepEqual(argoLinkBalance({ available: 12.345, currency: "usd" }), {
      provider: "argolink",
      amount: 12.345,
      currency: "USD",
      scope: "account",
    });
    assert.equal(argoLinkBalance({}).amount, undefined);
    assert.deepEqual(openRouterBalance({ limit_remaining: 4.5 }, undefined), {
      provider: "openrouter",
      amount: 4.5,
      currency: "USD",
      scope: "key",
    });
    // No limit on the key: the account's totals, when the key may read them.
    assert.deepEqual(openRouterBalance({ limit_remaining: null }, { total_credits: 100, total_usage: 25.5 }), {
      provider: "openrouter",
      amount: 74.5,
      currency: "USD",
      scope: "account",
    });
    const unknown = openRouterBalance({ limit_remaining: null }, undefined);
    assert.equal(unknown.amount, undefined);
    assert.match(unknown.note!, /management key/);
    assert.deepEqual(falBalance({ credits: { current_balance: 24.5, currency: "USD" } }), {
      provider: "fal",
      amount: 24.5,
      currency: "USD",
      scope: "account",
    });
    assert.equal(falBalance({}).amount, undefined);
  });

  it("formats an amount for the top bar", () => {
    assert.equal(formatBalance({ amount: 12.345, currency: "USD" }), "$12.35");
    assert.equal(formatBalance({ amount: 0 }), "$0.00");
    assert.equal(formatBalance({ amount: -1.5, currency: "USD" }), "-$1.50");
    assert.equal(formatBalance({ amount: 3, currency: "EUR" }), "3.00 EUR");
    assert.equal(formatBalance({}), undefined);
  });

  it("asks ArgoLink for the account balance with the user's key", async () => {
    const calls = serve({ "https://argolink.io/v1/account/balance": () => json(200, { available: 8.2, currency: "USD" }) });
    assert.deepEqual(await argoBalance({ apiKey: KEY }), { provider: "argolink", amount: 8.2, currency: "USD", scope: "account" });
    assert.deepEqual(calls, [{ url: "https://argolink.io/v1/account/balance", authorization: `Bearer ${KEY}` }]);
  });

  it("uses an OpenRouter key's own limit and skips the account call", async () => {
    const calls = serve({ "https://openrouter.ai/api/v1/key": () => json(200, { data: { limit_remaining: 19.75 } }) });
    assert.deepEqual(await openRouterKeyBalance(KEY), { provider: "openrouter", amount: 19.75, currency: "USD", scope: "key" });
    assert.deepEqual(calls.map((call) => call.url), ["https://openrouter.ai/api/v1/key"]);
  });

  it("falls back to OpenRouter's account credits, and to a note when the key can't read them", async () => {
    serve({
      "https://openrouter.ai/api/v1/key": () => json(200, { data: { limit_remaining: null } }),
      "https://openrouter.ai/api/v1/credits": () => json(200, { data: { total_credits: 50, total_usage: 12.25 } }),
    });
    assert.deepEqual(await openRouterKeyBalance(KEY), { provider: "openrouter", amount: 37.75, currency: "USD", scope: "account" });

    serve({
      "https://openrouter.ai/api/v1/key": () => json(200, { data: { limit_remaining: null } }),
      "https://openrouter.ai/api/v1/credits": () => json(403, { error: { message: `management key required, got ${KEY}` } }),
    });
    const noAccess = await openRouterKeyBalance(KEY);
    assert.equal(noAccess.amount, undefined);
    assert.equal(JSON.stringify(noAccess).includes(KEY), false);
  });

  it("reads fal's credit balance, and reports a key that can't see it without failing", async () => {
    const url = "https://api.fal.ai/v1/account/billing?expand=credits";
    const calls = serve({ [url]: () => json(200, { username: "team", credits: { current_balance: 24.5, currency: "USD" } }) });
    assert.deepEqual(await falAccountBalance(KEY), { provider: "fal", amount: 24.5, currency: "USD", scope: "account" });
    assert.deepEqual(calls, [{ url, authorization: `Key ${KEY}` }]);

    serve({ [url]: () => json(403, { detail: `forbidden for ${KEY}` }) });
    const denied = await falAccountBalance(KEY);
    assert.equal(denied.amount, undefined);
    assert.equal(JSON.stringify(denied).includes(KEY), false);
  });
});
