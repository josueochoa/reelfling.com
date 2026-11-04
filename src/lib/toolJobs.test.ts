import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { join } from "node:path";
import { setTestEnv, type AppEnv } from "./db";
import { isFalApiHost } from "./providers/fal";
import { outputLineage, parseToolParams, TOOL_FORMS } from "./registry/tool-forms";
import { publicTools, runnableTools } from "./toolCatalog";
import { toolsForKind, type ToolView } from "./toolTypes";

const SECRET = "test-auth-secret-at-least-32-characters";
const KEY = "fal-test-key-do-not-leak-9f3a";
const USER = "user-1";
const PARENT = "uploads/portrait.jpg";
const VIDEO = "uploads/clip.mp4";
const ENDPOINT = "fal-ai/birefnet/v2";
const STATUS_URL = `https://queue.fal.run/${ENDPOINT}/requests/req_tool/status`;
const RESPONSE_URL = `https://queue.fal.run/${ENDPOINT}/requests/req_tool`;
const CANCEL_URL = `https://queue.fal.run/${ENDPOINT}/requests/req_tool/cancel`;
const OUTPUT_URL = "https://v3.fal.media/files/rabbit/cut.png";

const database = new DatabaseSync(":memory:");
database.exec("PRAGMA foreign_keys = ON");
for (const file of readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort()) {
  database.exec(readFileSync(join("migrations", file), "utf8"));
}

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
  AUTH_SECRET: SECRET,
  R2_ACCOUNT_ID: "abc123",
  R2_ACCESS_KEY_ID: "r2-access",
  R2_SECRET_ACCESS_KEY: "r2-secret",
  R2_ENDPOINT: "https://r2.example.com",
  R2_BUCKET: "reelfling-media",
  STORAGE_QUOTA_GB: "2",
});

const { createToolJob, cancelFalJob, getFalJob, removeFalJob, syncFalJob } = await import("./falJobs");
const { saveKey } = await import("./keys");

interface Call {
  url: string;
  method: string;
  authorization: string | null;
  body: string | undefined;
}

const calls: Call[] = [];
const originalFetch = globalThis.fetch;

function json(status: number, body: unknown, extra?: HeadersInit) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });
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
      // R2 signs with its own credentials. The fal key must not be on that request.
      assert.equal(blob.includes(key), false, call.url);
      assert.equal((call.authorization ?? "").startsWith("Key "), false, call.url);
    }
  }
}

function parentRow() {
  return database.prepare("SELECT bytes, name, parent_id, tool FROM assets WHERE user_id = ? AND key = ?").get(USER, PARENT) as {
    bytes: number;
    name: string;
    parent_id: string | null;
    tool: string | null;
  };
}

function childRows() {
  return database
    .prepare("SELECT key, parent_id, tool, content_type, name FROM assets WHERE user_id = ? AND key LIKE 'fal/%'")
    .all(USER) as { key: string; parent_id: string | null; tool: string | null; content_type: string; name: string | null }[];
}

database
  .prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)")
  .run(USER, "dev@localhost.test", "Dev", 1);
database
  .prepare("INSERT INTO buckets (user_id, name, created_at, cors) VALUES (?, ?, ?, ?)")
  .run(USER, "dev-user-1", 1, 1);
database
  .prepare(
    "INSERT INTO assets (user_id, key, bucket, bytes, content_type, created_at, name) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
  .run(USER, PARENT, "dev-user-1", 1200, "image/jpeg", 1, "portrait.jpg");
database
  .prepare(
    "INSERT INTO assets (user_id, key, bucket, bytes, content_type, created_at, name) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
  .run(USER, VIDEO, "dev-user-1", 4000, "video/mp4", 2, "clip.mp4");

await saveKey(USER, "fal", KEY);

function submitResponse() {
  return json(200, {
    status: "IN_QUEUE",
    request_id: "req_tool",
    status_url: STATUS_URL,
    response_url: RESPONSE_URL,
    cancel_url: CANCEL_URL,
  });
}

const imageTools: ToolView[] = [{ id: "image-tool", name: "Cut", description: "", accepts: "image", fields: [] }];
const videoTools: ToolView[] = [{ id: "video-tool", name: "Clip", description: "", accepts: "video", fields: [] }];

describe("tool catalog", () => {
  it("offers background removal for images and nothing for video", () => {
    const tools = runnableTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].id, "fal:fal-ai/birefnet/v2");
    assert.equal(tools[0].accepts, "image");
    assert.equal(tools[0].endpoint, ENDPOINT);
    assert.equal(publicTools().some((tool) => "endpoint" in tool), false);
    assert.deepEqual(
      toolsForKind(tools, "image").map((tool) => tool.id),
      ["fal:fal-ai/birefnet/v2"],
    );
    assert.deepEqual(toolsForKind(tools, "video"), []);
    assert.deepEqual(toolsForKind(tools, "audio"), []);
    assert.deepEqual(
      toolsForKind([...imageTools, ...videoTools], "image").map((tool) => tool.id),
      ["image-tool"],
    );
    assert.deepEqual(
      toolsForKind([...imageTools, ...videoTools], "video").map((tool) => tool.id),
      ["video-tool"],
    );
  });

  it("rejects a tool setting the schema does not list", () => {
    const form = TOOL_FORMS[0];
    assert.equal(parseToolParams(form, { model: "Portrait" }).model, "Portrait");
    assert.throws(() => parseToolParams(form, { model: "nope" }), /isn't one of the listed choices/);
    assert.throws(() => parseToolParams(form, { image_url: "https://evil.example/x" }), /Unknown tool setting/);
    assert.deepEqual(outputLineage({ tool: { id: form.id, inputAssetIds: [PARENT] } }), {
      parentId: PARENT,
      tool: form.id,
    });
    assert.deepEqual(outputLineage({}), { parentId: null, tool: null });
  });

  it("does not import the generated catalog into client components", () => {
    const files = walk("src").filter((file) => (file.endsWith(".tsx") || file.endsWith(".ts")) && !file.endsWith(".test.ts"));
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (!text.includes("use client")) continue;
      assert.equal(text.includes("registry/generated"), false, file);
      assert.equal(text.includes("catalog/fal"), false, file);
      assert.equal(text.includes("tool-forms"), false, file);
      assert.equal(text.includes("toolCatalog"), false, file);
    }
  });
});

describe("tool jobs", () => {
  it("submits, polls, and completes into a new asset without changing the parent", async () => {
    const script = [
      submitResponse(),
      json(202, { status: "IN_QUEUE", request_id: "req_tool", queue_position: 2 }),
      json(202, { status: "IN_PROGRESS", request_id: "req_tool" }),
      json(200, { status: "COMPLETED", request_id: "req_tool" }),
      json(200, {
        image: { url: OUTPUT_URL, content_type: "image/png", file_name: "cut.png", width: 64, height: 64 },
      }),
      new Response(new Uint8Array(32), { headers: { "content-type": "image/png", "content-length": "32" } }),
      new Response(null, { status: 200 }),
    ];
    install(() => script.shift()!);
    const before = parentRow();

    const created = await createToolJob(
      USER,
      { toolId: "fal:fal-ai/birefnet/v2", assetIds: [PARENT], params: { model: "Portrait", refine_foreground: false } },
      KEY,
    );
    assert.equal(created.status, "queued");
    assert.equal(created.endpointId, ENDPOINT);
    assert.equal(created.cancelUrl, CANCEL_URL);
    assert.equal(created.tool?.id, "fal:fal-ai/birefnet/v2");
    assert.deepEqual(created.tool?.inputAssetIds, [PARENT]);
    assert.equal(created.tool?.route.provider, "fal");
    assert.equal(created.tool?.route.endpoint, ENDPOINT);
    assert.equal(created.tool?.route.mapper, "fal.queue");
    assert.equal(created.tool?.params.model, "Portrait");
    assert.equal(created.tool?.params.refine_foreground, false);
    assert.equal(created.tool?.params.output_format, "png");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url, `https://queue.fal.run/${ENDPOINT}`);
    assert.equal(calls[0].authorization, `Key ${KEY}`);
    const posted = JSON.parse(calls[0].body!) as { image_url: string; model: string };
    assert.equal(posted.model, "Portrait");
    assert.equal(posted.image_url.startsWith("https://"), true);
    assert.equal(posted.image_url.includes(PARENT), true);
    assert.equal(JSON.stringify(created).includes(KEY), false);

    const queued = await syncFalJob(USER, created.id);
    assert.equal(queued?.status, "queued");
    assert.equal(queued?.queuePosition, 2);

    const running = await syncFalJob(USER, created.id);
    assert.equal(running?.status, "running");

    const done = await syncFalJob(USER, created.id);
    assert.equal(done?.status, "succeeded");
    assert.equal(done?.stored, true);
    assert.equal(done?.outputs.length, 1);
    const children = childRows();
    assert.equal(children.length, 1);
    assert.equal(children[0].parent_id, PARENT);
    assert.equal(children[0].tool, "fal:fal-ai/birefnet/v2");
    assert.equal(children[0].content_type, "image/png");
    assert.equal(children[0].name, "Birefnet Background Removal V2");
    assert.deepEqual(parentRow(), before);
    assert.equal(calls.some((call) => call.url === OUTPUT_URL && call.authorization === null), true);
    assert.equal(calls.some((call) => call.url.startsWith("https://r2.example.com/") && call.method === "PUT"), true);
    assertKeyStayedOnFal();
  });

  it("marks a failed tool job failed and writes no output", async () => {
    const before = childRows().length;
    install((call) => {
      if (call.method === "POST") return submitResponse();
      if (call.url.endsWith("/status")) return json(200, { status: "COMPLETED", request_id: "req_tool" });
      return json(200, { error: "Model exploded" });
    });
    const created = await createToolJob(USER, { toolId: "fal:fal-ai/birefnet/v2", assetIds: [PARENT], params: {} }, KEY);
    const failed = await syncFalJob(USER, created.id);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.error, "Model exploded");
    assert.equal(failed?.stored, undefined);
    assert.equal(childRows().length, before);
    assert.equal(JSON.stringify(failed).includes(KEY), false);
    assertKeyStayedOnFal();
  });

  it("cancels with the cancel_url fal returned", async () => {
    install((call) => {
      if (call.method === "POST") return submitResponse();
      if (call.method === "PUT") return json(202, { status: "CANCELLATION_REQUESTED" });
      return json(500, { error: "unexpected" });
    });
    const created = await createToolJob(USER, { toolId: "fal:fal-ai/birefnet/v2", assetIds: [PARENT], params: {} }, KEY);
    await cancelFalJob(USER, created);
    const cancel = calls.find((call) => call.method === "PUT");
    assert.equal(cancel?.url, CANCEL_URL);
    assert.equal(cancel?.authorization, `Key ${KEY}`);
    await removeFalJob(USER, created.id);
    assert.equal(await getFalJob(USER, created.id), undefined);
    assert.equal(parentRow().name, "portrait.jpg");
    assert.equal(parentRow().tool, null);
    assertKeyStayedOnFal();
  });

  it("refuses a video asset for an image tool", async () => {
    install(() => submitResponse());
    await assert.rejects(
      () => createToolJob(USER, { toolId: "fal:fal-ai/birefnet/v2", assetIds: [VIDEO], params: {} }, KEY),
      /needs an image/,
    );
    assert.equal(calls.length, 0);
  });
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}
