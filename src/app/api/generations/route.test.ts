import "../../../../scripts/next-als-preload.mjs";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external.js";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external.js";
import { HeadersAdapter } from "next/dist/server/web/spec-extension/adapters/headers.js";
import { RequestCookiesAdapter } from "next/dist/server/web/spec-extension/adapters/request-cookies.js";
import { RequestCookies } from "next/dist/server/web/spec-extension/cookies.js";
import { sha256 } from "@/lib/crypto";
import { setTestEnv, type AppEnv } from "@/lib/db";
import { saveKey } from "@/lib/keys";

const USER = "user-1";
const TOKEN = "session-token";
/** Distinctive fake key. The refusal must not echo it or put it on a request. */
const KEY = "rf_test_fal_key_do_not_send_9f3a";

const database = new DatabaseSync(":memory:");
database.exec("PRAGMA foreign_keys = ON");
for (const file of readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort()) {
  database.exec(readFileSync(join("migrations", file), "utf8"));
}
database.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").run(USER, "a@b.c", 1);
database
  .prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
  .run(sha256(TOKEN), USER, Date.now() + 86_400_000, Date.now());

function fakeD1(db: DatabaseSync) {
  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      return {
        bind(...params: (string | number | null)[]) {
          return {
            async first<T>() {
              return (stmt.get(...params) as T | undefined) ?? null;
            },
            async all<T>() {
              return { results: stmt.all(...params) as T[] };
            },
            async run() {
              const info = stmt.run(...params);
              return { meta: { changes: Number(info.changes) } };
            },
          };
        },
      };
    },
  };
}

setTestEnv({
  DB: fakeD1(database) as unknown as AppEnv["DB"],
  AUTH_SECRET: "test-auth-secret-at-least-32-characters",
  AUTH_MODE: "google",
});

await saveKey(USER, "fal", KEY);

const { POST } = await import("./route");

type Storage = { run: <T>(store: object, fn: () => Promise<T>) => Promise<T> };

/** `requireUser` reads cookies through Next's request store. */
function asRequest<T>(fn: () => Promise<T>) {
  const headers = HeadersAdapter.seal(new Headers());
  const cookies = RequestCookiesAdapter.seal(new RequestCookies(new Headers({ cookie: `sid=${TOKEN}` })));
  const work = workAsyncStorage as unknown as Storage;
  const unit = workUnitAsyncStorage as unknown as Storage;
  return work.run({ forceStatic: false }, () =>
    unit.run({ type: "request", phase: "render", headers, cookies }, fn),
  );
}

const originalFetch = globalThis.fetch;
const originalError = console.error;
let calls: string[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.error = originalError;
  calls = [];
  database.prepare("DELETE FROM generations").run();
});

async function post(model: string) {
  calls = [];
  console.error = () => {};
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    return new Response("provider should not be called", { status: 500 });
  }) as typeof fetch;
  return asRequest(() =>
    POST(
      new Request("https://internal.invalid/api/generations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          route: "fal",
          prompt: "a boat on a lake",
          mode: "references",
          ratio: "16:9",
          resolution: "720p",
          duration: 5,
          generateAudio: true,
        }),
      }),
    ),
  );
}

describe("POST /api/generations", () => {
  it("refuses a fal video route the studio cannot submit and does not call the provider", async () => {
    for (const model of [
      "fal:fal-ai/kling-video/v3/pro/text-to-video",
      "fal:fal-ai/wan/v2.2-a14b/text-to-video",
      "fal:alibaba/wan-3.0/reference-to-video",
      "fal:fal-ai/minimax/video-01/image-to-video",
    ]) {
      const res = await post(model);
      const body = await res.text();
      assert.equal(res.status, 400, body);
      assert.equal(JSON.parse(body).error, "This model isn't available on the video tab.");
      assert.equal(body.includes(KEY), false);
      assert.deepEqual(calls, []);
    }
    const rows = database.prepare("SELECT COUNT(*) AS n FROM generations").get() as { n: number };
    assert.equal(rows.n, 0);
  });
});
