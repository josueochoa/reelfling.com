import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { join } from "node:path";
import { setTestEnv, type AppEnv } from "./db";
import { isAssetKey } from "./uploads";

const UID = "user-1";
const SECRET = "r2-secret-test-value";
const BUCKET = "reelfling-media";
const ENDPOINT = "https://r2.example.com";

const database = new DatabaseSync(":memory:");
database.exec("PRAGMA foreign_keys = ON");
for (const file of readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort()) {
  database.exec(readFileSync(join("migrations", file), "utf8"));
}
database.prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)").run(UID, "dev@localhost.test", "Dev", 1);

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
  R2_ACCOUNT_ID: "abc123",
  R2_ACCESS_KEY_ID: "r2-access",
  R2_SECRET_ACCESS_KEY: SECRET,
  R2_ENDPOINT: ENDPOINT,
  R2_BUCKET: BUCKET,
  STORAGE_QUOTA_GB: "2",
});

const {
  attachThumb,
  completeUpload,
  createThumbUpload,
  createUpload,
  deleteAsset,
  discardUpload,
  ensureBucket,
  getAsset,
  openAsset,
  providerUrl,
  putAsset,
  serveAsset,
} = await import("./storage");

interface Call {
  url: string;
  method: string;
}

const calls: Call[] = [];
const originalFetch = globalThis.fetch;

function install(handler: (call: Call) => Response) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.href : String(input);
    const call = { url, method: init?.method ?? "GET" };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  calls.length = 0;
  database.prepare("DELETE FROM assets").run();
});

function pathOf(url: string) {
  return decodeURIComponent(new URL(url).pathname);
}

function assertNoBucketAdmin() {
  for (const call of calls) {
    const url = new URL(call.url);
    assert.equal(url.search.includes("cors"), false, call.url);
    assert.equal(url.href.includes(SECRET), false, "secret leaked into the request URL");
    const parts = url.pathname.split("/").filter(Boolean);
    assert.equal(call.method === "PUT" && parts.length < 2, false, `bucket create ${call.method} ${url.pathname}`);
  }
}

const shared = {
  userId: UID,
  key: "images/x.png",
  bucket: BUCKET,
  bytes: 8,
  contentType: "image/png",
  generationId: null,
  createdAt: 1,
  meta: { thumb: "images/x.thumb.jpg" },
};

describe("shared bucket layout", () => {
  it("resolves an asset in reelfling-media to <id>/<key>, including its thumbnail", async () => {
    install(() => new Response(null, { status: 500 }));
    const file = await serveAsset(shared);
    assert.equal(file.status, 302);
    assert.equal(pathOf(file.headers.get("location")!), `/${BUCKET}/${UID}/images/x.png`);

    const thumb = await serveAsset(shared, { thumb: true });
    assert.equal(pathOf(thumb.headers.get("location")!), `/${BUCKET}/${UID}/images/x.thumb.jpg`);

    const opened = pathOf(await providerUrl(shared));
    assert.equal(opened, `/${BUCKET}/${UID}/images/x.png`);

    install(() => new Response("png", { status: 200, headers: { "content-type": "image/png" } }));
    const body = await openAsset(shared, { thumb: true });
    assert.equal(await new Response(body.body).text(), "png");
    assert.equal(pathOf(calls.at(-1)!.url), `/${BUCKET}/${UID}/images/x.thumb.jpg`);
    assert.equal(calls.at(-1)!.method, "GET");
    assertNoBucketAdmin();
  });

  it("uses workspace id when the row has one, and a bare key in any other bucket", async () => {
    const inWorkspace = await serveAsset({ ...shared, workspaceId: "ws-personal" });
    assert.equal(pathOf(inWorkspace.headers.get("location")!), `/${BUCKET}/ws-personal/images/x.png`);

    const legacy = await serveAsset({ ...shared, bucket: "dev-user-1", workspaceId: "ws-personal" });
    assert.equal(pathOf(legacy.headers.get("location")!), "/dev-user-1/images/x.png");
  });

  it("writes a new upload under the prefix and stores the bare key", async () => {
    const [uploadUrl] = await createUpload(UID, ["uploads/clip.png"]);
    assert.equal(pathOf(uploadUrl), `/${BUCKET}/${UID}/uploads/clip.png`);
    assert.equal(calls.length, 0);

    install((call) => {
      assert.equal(call.method, "HEAD");
      return new Response(null, {
        status: 200,
        headers: { "content-length": "12", "content-type": "image/png" },
      });
    });
    const saved = await completeUpload(UID, "uploads/clip.png", { name: "clip.png", meta: {} });
    assert.equal(saved?.key, "uploads/clip.png");
    assert.equal(saved?.bucket, BUCKET);
    assert.equal(isAssetKey(saved!.key), true);
    assert.equal(pathOf(calls[0].url), `/${BUCKET}/${UID}/uploads/clip.png`);
    const row = database.prepare("SELECT key, bucket FROM assets WHERE user_id = ?").get(UID) as {
      key: string;
      bucket: string;
    };
    assert.equal(row.key, "uploads/clip.png");
    assert.equal(row.bucket, BUCKET);
    assertNoBucketAdmin();
  });

  it("stores generated objects under the prefix without prefixing the D1 key", async () => {
    install(() => new Response(null, { status: 200 }));
    const asset = await putAsset(UID, {
      key: "images/gen/0.png",
      source: new Response(new Uint8Array(4), { headers: { "content-type": "image/png", "content-length": "4" } }),
      contentType: "image/png",
      generationId: "gen",
    });
    assert.equal(asset.key, "images/gen/0.png");
    assert.equal(asset.bucket, BUCKET);
    assert.equal(isAssetKey(asset.key), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "PUT");
    assert.equal(pathOf(calls[0].url), `/${BUCKET}/${UID}/images/gen/0.png`);
    assertNoBucketAdmin();
  });

  it("deletes and thumbnails use the prefix and never create a bucket or set CORS", async () => {
    install(() => new Response(null, { status: 204 }));
    await deleteAsset(shared);
    assert.deepEqual(
      calls.map((call) => `${call.method} ${pathOf(call.url)}`),
      [`DELETE /${BUCKET}/${UID}/images/x.thumb.jpg`, `DELETE /${BUCKET}/${UID}/images/x.png`],
    );

    calls.length = 0;
    const thumbUrl = await createThumbUpload(shared);
    assert.equal(pathOf(thumbUrl), `/${BUCKET}/${UID}/images/x.thumb.jpg`);

    calls.length = 0;
    install((call) => {
      if (call.method === "HEAD") {
        return new Response(null, { status: 200, headers: { "content-length": "20", "content-type": "image/jpeg" } });
      }
      return new Response(null, { status: 204 });
    });
    assert.equal(await attachThumb(shared), true);
    assert.equal(pathOf(calls[0].url), `/${BUCKET}/${UID}/images/x.thumb.jpg`);
    const stored = await getAsset(UID, shared.key);
    assert.equal(stored?.meta?.thumb, "images/x.thumb.jpg");
    assert.equal(stored?.key.startsWith(`${UID}/`), false);

    calls.length = 0;
    install(() => new Response(null, { status: 200, headers: { "content-length": "99999999", "content-type": "image/jpeg" } }));
    assert.equal(await attachThumb({ ...shared, meta: {} }), false);
    assert.equal(calls.at(-1)!.method, "DELETE");
    assert.equal(pathOf(calls.at(-1)!.url), `/${BUCKET}/${UID}/images/x.thumb.jpg`);

    calls.length = 0;
    install(() => new Response(null, { status: 204 }));
    await discardUpload(UID, "uploads/orphan.png");
    assert.deepEqual(
      calls.map((call) => `${call.method} ${pathOf(call.url)}`),
      [`DELETE /${BUCKET}/${UID}/uploads/orphan.png`],
    );

    calls.length = 0;
    assert.equal(await ensureBucket(), BUCKET);
    assert.equal(calls.length, 0);
    assertNoBucketAdmin();
  });
});
