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

// Ada and Ben share a team. Cid is on no team with either.
const ADA = "user-ada";
const BEN = "user-ben";
const CID = "user-cid";
const TOKENS: Record<string, string> = { [ADA]: "token-ada", [CID]: "token-cid" };

const database = new DatabaseSync(":memory:");
database.exec("PRAGMA foreign_keys = ON");
for (const file of readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort()) {
  database.exec(readFileSync(join("migrations", file), "utf8"));
}
for (const [id, name] of [
  [ADA, "Ada Lovelace"],
  [BEN, "Ben Ito"],
  [CID, "Cid Moss"],
]) {
  database.prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, 1)").run(id, `${id}@example.com`, name);
}
for (const [user, token] of Object.entries(TOKENS)) {
  database
    .prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .run(sha256(token), user, Date.now() + 86_400_000, Date.now());
}
database.exec(`
  INSERT INTO teams (id, name, owner_id, created_at) VALUES ('team', 'Studio', '${ADA}', 1);
  INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ('team', '${ADA}', 'owner', 1), ('team', '${BEN}', 'member', 2);
`);

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
  R2_ACCOUNT_ID: "abc123",
  R2_ACCESS_KEY_ID: "r2-access",
  R2_SECRET_ACCESS_KEY: "r2-secret",
  R2_ENDPOINT: "https://r2.example.com",
  R2_BUCKET: "reelfling-media",
});

const { GET: listVideos } = await import("../generations/route");
const { GET: listImages } = await import("../images/route");
const { GET: listFal } = await import("../fal/route");
const { GET: listAssets } = await import("../assets/route");
const { GET: getFile } = await import("../assets/file/route");
const { GET: getMe } = await import("../me/route");

type Storage = { run: <T>(store: object, fn: () => Promise<T>) => Promise<T> };

/** `requireUser` reads the session cookie through Next's request store. */
function as<T>(user: string, fn: () => Promise<T>) {
  const headers = HeadersAdapter.seal(new Headers());
  const cookies = RequestCookiesAdapter.seal(new RequestCookies(new Headers({ cookie: `sid=${TOKENS[user]}` })));
  const work = workAsyncStorage as unknown as Storage;
  const unit = workUnitAsyncStorage as unknown as Storage;
  return work.run({ forceStatic: false }, () => unit.run({ type: "request", phase: "render", headers, cookies }, fn));
}

const row = (table: string, id: string, user: string, createdAt: number, data: object) =>
  database
    .prepare(`INSERT INTO ${table} (id, user_id, created_at, data) VALUES (?, ?, ?, ?)`)
    .run(id, user, createdAt, JSON.stringify({ id, createdAt, updatedAt: createdAt, ...data }));

row("generations", "gen-ada", ADA, 1000, { taskId: "task-ada", status: "succeeded", prompt: "Ada's boat", stored: true });
row("generations", "gen-ben", BEN, 2000, {
  taskId: "task-ben-secret",
  status: "succeeded",
  prompt: "Ben's fox",
  stored: true,
  remoteVideoUrl: "https://provider.example/signed?sig=secret",
  falStatusUrl: "https://queue.fal.run/status",
  falResponseUrl: "https://queue.fal.run/response",
  falCancelUrl: "https://queue.fal.run/cancel",
});
row("generations", "gen-cid", CID, 3000, { taskId: "task-cid", status: "succeeded", prompt: "Cid's owl" });
row("image_generations", "img-ben", BEN, 2500, { status: "succeeded", prompt: "Ben's poster", images: [], references: [] });
row("image_generations", "img-cid", CID, 2600, { status: "succeeded", prompt: "Cid's poster", images: [], references: [] });
row("fal_jobs", "fal-ben", BEN, 2700, {
  endpointId: "fal-ai/flux",
  status: "succeeded",
  request: { prompt: "Ben's fal" },
  responseUrl: "https://queue.fal.run/secret",
  outputs: [],
});
for (const [user, key, type] of [
  [ADA, "uploads/ada-moodboard.jpg", "image/jpeg"],
  [BEN, "videos/gen-ben.mp4", "video/mp4"],
  [BEN, "uploads/ben-notes.html", "text/html"],
  [CID, "uploads/cid-logo.png", "image/png"],
]) {
  database
    .prepare(
      "INSERT INTO assets (user_id, key, bucket, bytes, content_type, created_at, name, generation_id) VALUES (?, ?, 'reelfling-media', 5, ?, 10, ?, ?)",
    )
    .run(user, key, type, key.split("/")[1], key.startsWith("videos/") ? "gen-ben" : null);
}

const originalFetch = globalThis.fetch;
let fetched: string[] = [];
function serveObjects() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    fetched.push(url);
    return new Response("VIDEO", { status: 200, headers: { "content-type": "video/mp4", "content-length": "5" } });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  fetched = [];
  database.exec(`INSERT OR IGNORE INTO team_members (team_id, user_id, role, joined_at) VALUES ('team', '${BEN}', 'member', 2)`);
});

const json = async <T>(res: Response) => (await res.json()) as T;
type Item = { id?: string; key?: string; owner?: { id: string; name: string | null; email: string }; [field: string]: unknown };
const file = (query: string) => new Request(`https://reelfling.com/api/assets/file?${query}`);

describe("teammates' work in the main tabs", () => {
  it("lists a teammate's generations with who made them, and nobody else's", async () => {
    const list = await as(ADA, async () => json<Item[]>(await listVideos()));
    assert.deepEqual(
      list.map((gen) => gen.id),
      ["gen-ben", "gen-ada"],
    );
    assert.deepEqual(list[0].owner, { id: BEN, name: "Ben Ito", email: `${BEN}@example.com` });
    assert.equal(list[1].owner, undefined);

    const images = await as(ADA, async () => json<Item[]>(await listImages()));
    assert.deepEqual(
      images.map((gen) => [gen.id, gen.owner?.id]),
      [["img-ben", BEN]],
    );
    const fal = await as(ADA, async () => json<Item[]>(await listFal()));
    assert.deepEqual(
      fal.map((job) => [job.id, job.owner?.id, job.prompt]),
      [["fal-ben", BEN, "Ben's fal"]],
    );

    const stranger = await as(CID, async () => json<Item[]>(await listVideos()));
    assert.deepEqual(
      stranger.map((gen) => gen.id),
      ["gen-cid"],
    );
  });

  it("drops the provider task id and URLs from a teammate's generation", async () => {
    const list = await as(ADA, async () => json<Item[]>(await listVideos()));
    const ben = list.find((gen) => gen.id === "gen-ben")!;
    assert.equal(ben.taskId, "");
    for (const field of ["remoteVideoUrl", "falStatusUrl", "falResponseUrl", "falCancelUrl"]) assert.equal(ben[field], undefined);
    assert.doesNotMatch(JSON.stringify(list), /secret/);
    assert.equal(list.find((gen) => gen.id === "gen-ada")!.taskId, "task-ada");

    const fal = await as(ADA, async () => (await listFal()).text());
    assert.doesNotMatch(fal, /secret/);
  });

  it("keeps teammates' files out of the viewer's own library", async () => {
    const own = await as(ADA, async () => json<Item[]>(await listAssets(new Request("https://reelfling.com/api/assets"))));
    assert.deepEqual(
      own.map((item) => [item.key, item.owner]),
      [["uploads/ada-moodboard.jpg", undefined]],
    );
    const team = await as(ADA, async () =>
      json<Item[]>(await listAssets(new Request("https://reelfling.com/api/assets?team=1"))),
    );
    // Ben's HTML upload isn't a library file, so it isn't listed (or served) at all.
    assert.deepEqual(
      team.map((item) => [item.key, item.owner?.id]),
      [["videos/gen-ben.mp4", BEN]],
    );
    const me = await as(ADA, async () => json<{ teammates: number }>(await getMe()));
    assert.equal(me.teammates, 1);
  });

  it("streams a teammate's file without a redirect, and sandboxes it", async () => {
    serveObjects();
    const res = await as(ADA, () => getFile(file(`key=videos%2Fgen-ben.mp4&owner=${BEN}&download`)));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "VIDEO");
    assert.equal(res.headers.get("location"), null);
    assert.equal(res.headers.get("content-security-policy"), "sandbox");
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    assert.match(res.headers.get("content-disposition") ?? "", /^attachment; filename="gen-ben.mp4"$/);
    assert.equal(fetched.length, 1);
    assert.match(fetched[0], new RegExp(`/reelfling-media/${BEN}/videos/gen-ben\\.mp4`));
  });

  it("refuses a teammate's file to anyone off the team, and anything that isn't media", async () => {
    serveObjects();
    const stranger = await as(CID, () => getFile(file(`key=videos%2Fgen-ben.mp4&owner=${BEN}`)));
    assert.equal(stranger.status, 404);
    const html = await as(ADA, () => getFile(file(`key=uploads%2Fben-notes.html&owner=${BEN}`)));
    assert.equal(html.status, 404);
    const outsider = await as(ADA, () => getFile(file(`key=uploads%2Fcid-logo.png&owner=${CID}`)));
    assert.equal(outsider.status, 404);
    // A thumbnail that was never made: not the whole video in its place.
    const thumb = await as(ADA, () => getFile(file(`key=videos%2Fgen-ben.mp4&owner=${BEN}&thumb=1`)));
    assert.equal(thumb.status, 404);
    assert.deepEqual(fetched, []);
  });

  it("ends access when a member leaves the team", async () => {
    serveObjects();
    database.prepare("DELETE FROM team_members WHERE user_id = ?").run(BEN);
    const list = await as(ADA, async () => json<Item[]>(await listVideos()));
    assert.deepEqual(
      list.map((gen) => gen.id),
      ["gen-ada"],
    );
    const res = await as(ADA, () => getFile(file(`key=videos%2Fgen-ben.mp4&owner=${BEN}`)));
    assert.equal(res.status, 404);
    assert.deepEqual(fetched, []);
  });
});
