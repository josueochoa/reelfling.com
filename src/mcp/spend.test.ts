import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import type { ConnectorEnv } from "./app";
import { claimQuote, DAILY_CAP_USD, readQuote, releaseClaim, saveQuote, spentToday, type Quote } from "./spend";

const database = new DatabaseSync(":memory:");
for (const file of readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort())
  database.exec(readFileSync(join("migrations", file), "utf8"));
database.prepare("INSERT INTO users (id, email, created_at) VALUES ('ada', 'ada@example.com', 1), ('ben', 'ben@example.com', 1)").run();

function statement(sql: string, params: (string | number | null)[] = []) {
  const stmt = database.prepare(sql);
  return {
    bind: (...next: (string | number | null)[]) => statement(sql, next),
    async first<T>() {
      return (stmt.get(...params) as T | undefined) ?? null;
    },
    async run() {
      return { meta: { changes: Number(stmt.run(...params).changes) } };
    },
  };
}

const env = {
  DB: {
    prepare: (sql: string) => statement(sql),
    async batch(list: ReturnType<typeof statement>[]) {
      for (const item of list) await item.run();
    },
  },
} as unknown as ConnectorEnv;

const who = { userId: "ada", clientId: "claude" };
const errorOf = (result: object) => ("error" in result ? String(result.error) : "");
const quote = (cost: number, extra: Partial<Omit<Quote, "id">> = {}) =>
  saveQuote(env, {
    ...who,
    kind: "video",
    request: { model: "seedance-2.5", prompt: "A paper boat" },
    cost,
    expiresAt: Date.now() + 60_000,
    ...extra,
  });

describe("connector quotes", () => {
  it("gives a short id that reads back for the same user and connection only", async () => {
    const saved = await quote(1.5);
    assert.match(saved.id, /^q_[0-9a-f]{16}$/);
    const read = await readQuote(env, ` ${saved.id} `, who);
    assert.ok(!("error" in read));
    assert.equal(read.cost, 1.5);
    assert.deepEqual(read.request, { model: "seedance-2.5", prompt: "A paper boat" });
    assert.match(errorOf(await readQuote(env, saved.id, { userId: "ben", clientId: "claude" })), /another connection/);
    assert.match(errorOf(await readQuote(env, saved.id, { userId: "ada", clientId: "other" })), /another connection/);
    assert.match(errorOf(await readQuote(env, "q_0000000000000000", who)), /no quote/);
  });

  it("refuses an expired quote, and clears day-old ones", async () => {
    const old = await quote(1, { expiresAt: Date.now() - 1 });
    assert.match(errorOf(await readQuote(env, old.id, who)), /expired/);
    await quote(1, { expiresAt: Date.now() - 2 * 24 * 60 * 60 * 1000 });
    await quote(1);
    const stale = database
      .prepare("SELECT COUNT(*) AS n FROM connector_quotes WHERE expires_at < ?")
      .get(Date.now() - 86_400_000) as { n: number };
    assert.equal(stale.n, 0);
  });
});

describe("connector spend cap", () => {
  it("starts a quote once, stops at the daily cap, and gives back a failed start", async () => {
    const first = await quote(DAILY_CAP_USD - 5);
    const claimed = await claimQuote(env, first);
    assert.ok("id" in claimed);
    assert.match(errorOf(await claimQuote(env, first)), /already used/);

    const over = await quote(6);
    assert.match(errorOf(await claimQuote(env, over)), /\$20 daily limit/);
    assert.equal(await spentToday(env, "ada", "claude"), DAILY_CAP_USD - 5);

    // Another connection has its own cap.
    assert.ok("id" in (await claimQuote(env, await quote(6, { clientId: "cowork" }))));

    await releaseClaim(env, claimed.id);
    assert.equal(await spentToday(env, "ada", "claude"), 0);
    assert.ok("id" in (await claimQuote(env, over)));

    // Yesterday's spending no longer counts.
    const later = Date.now() + 25 * 60 * 60 * 1000;
    assert.equal(await spentToday(env, "ada", "claude", later), 0);
  });
});
