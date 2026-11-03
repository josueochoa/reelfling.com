import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  canReadTeamItem,
  personalGenerationScope,
  publicAuthor,
  publicTeamAsset,
  publicTeamGeneration,
  teamMediaHeaders,
  teamMediaUrl,
  visibleTeamItems,
} from "./teamPolicy";

const ADA = "user-ada";
const BEN = "user-ben";
const CID = "user-cid";

describe("team membership", () => {
  const boat = { ownerId: ADA, prompt: "A red paper boat" };
  const fox = { ownerId: BEN, prompt: "A blue fox" };

  it("hides the team from someone who was never a member", () => {
    const members = [ADA, BEN];
    assert.equal(canReadTeamItem(members, CID, ADA), false);
    assert.deepEqual(visibleTeamItems(members, CID, [boat, fox]), []);
  });

  it("lets a member read every current teammate's items", () => {
    const members = [ADA, BEN];
    assert.equal(canReadTeamItem(members, ADA, BEN), true);
    assert.equal(canReadTeamItem(members, BEN, ADA), true);
    assert.deepEqual(
      visibleTeamItems(members, BEN, [boat, fox]).map((item) => item.ownerId),
      [ADA, BEN],
    );
  });

  it("drops access once a member is removed", () => {
    const before = [ADA, BEN];
    assert.equal(canReadTeamItem(before, BEN, ADA), true);
    // Removal is the member id leaving the current set. The next request sees that set.
    const after = [ADA];
    assert.equal(canReadTeamItem(after, BEN, ADA), false);
    assert.equal(canReadTeamItem(after, BEN, BEN), false);
    assert.deepEqual(visibleTeamItems(after, BEN, [boat, fox]), []);
    // What they made is no longer part of the team, either.
    assert.deepEqual(
      visibleTeamItems(after, ADA, [boat, fox]).map((item) => item.prompt),
      ["A red paper boat"],
    );
  });
});

describe("generation scope", () => {
  it("uses only the caller's key and storage, ignoring a team or another user", () => {
    const secret = "sk-live-SHOULD-NOT-BE-CHOSEN-9981";
    const scope = personalGenerationScope(ADA, {
      teamId: "team-1",
      userId: BEN,
      keyUserId: BEN,
      storageUserId: BEN,
      apiKey: secret,
    });
    assert.deepEqual(scope, { keyUserId: ADA, storageUserId: ADA });
    assert.equal(scope.keyUserId, scope.storageUserId);
    const json = JSON.stringify(scope);
    assert.equal(json.includes(secret), false);
    assert.equal(json.includes(BEN), false);
    assert.equal(json.includes("team-1"), false);
  });
});

describe("team view payloads", () => {
  const secret = "sk-live-TEAMMATE-KEY-4455";

  it("shows who made a generation and drops urls and key material", () => {
    const view = publicTeamGeneration({
      id: "gen-1",
      ownerId: ADA,
      kind: "video",
      createdAt: 10,
      author: { id: ADA, name: "Ada", email: "ada@example.com", last4: "4455" } as never,
      data: {
        prompt: "A red paper boat",
        model: "seedance-2.0",
        status: "succeeded",
        stored: true,
        remoteVideoUrl: "https://provider.example/video?X-Amz-Signature=abc",
        apiKey: secret,
        request: { prompt: "ignored when prompt is set", apiKey: secret },
      },
    });
    assert.equal(view.prompt, "A red paper boat");
    assert.equal(view.author.name, "Ada");
    assert.deepEqual(Object.keys(view.author).sort(), ["email", "id", "name"]);
    const json = JSON.stringify(view);
    assert.equal(json.includes(secret), false);
    assert.equal(json.includes("remoteVideoUrl"), false);
    assert.equal(json.includes("X-Amz-Signature"), false);
    assert.equal(json.includes("last4"), false);
    assert.equal(json.includes("4455"), false);
  });

  it("keeps an author to a name and email", () => {
    const author = publicAuthor({ id: BEN, name: null, email: "ben@example.com" });
    assert.deepEqual(author, { id: BEN, name: null, email: "ben@example.com" });
  });

  it("serves teammate media from a same-origin route with no signature", () => {
    const url = teamMediaUrl("team-1", ADA, "images/gen-1/0.png", true);
    assert.equal(url.startsWith("/api/teams/team-1/media?"), true);
    assert.equal(url.includes("X-Amz-"), false);
    assert.equal(/https?:/i.test(url), false);
    const asset = publicTeamAsset({
      ownerId: ADA,
      key: "images/gen-1/0.png",
      name: "boat.png",
      contentType: "image/png",
      bytes: 12,
      createdAt: 10,
      hasThumb: false,
      author: { id: ADA, name: "Ada", email: "ada@example.com" },
    });
    assert.equal(asset?.name, "boat.png");
    assert.equal(publicTeamAsset({ ...asset!, key: "../secret", contentType: "image/png", name: "x" }), undefined);
  });

  it("does not redirect media or attach a cacheable signed url", () => {
    const headers = teamMediaHeaders({ contentType: "image/png", contentLength: "12", contentRange: null });
    assert.equal(headers.get("Cache-Control"), "private, no-store");
    assert.equal(headers.has("Location"), false);
    const raw = [...headers.entries()].map(([key, value]) => `${key}:${value}`).join("\n");
    assert.equal(/amz|signature|cloudflarestorage|secret/i.test(raw), false);
  });
});

function source(relative: string) {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = `${dir}/${name}`;
    if (statSync(path).isDirectory()) return filesUnder(path);
    return path.endsWith(".ts") || path.endsWith(".tsx") ? [path] : [];
  });
}

describe("generation routes", () => {
  it("passes the caller scope into the key lookup and the bucket", () => {
    const videos = source("../app/api/generations/route.ts");
    assert.match(videos, /personalGenerationScope\(user\.id, req\)/);
    assert.match(videos, /providerForUser\(scope\.keyUserId/);
    assert.match(videos, /assertStorageAvailable\(scope\.storageUserId\)/);
    assert.match(videos, /insertGeneration\(scope\.storageUserId/);

    const images = source("../app/api/images/route.ts");
    assert.match(images, /personalGenerationScope\(user\.id, req\)/);
    assert.match(images, /listKeys\(scope\.keyUserId\)/);
    assert.match(images, /assertStorageAvailable\(scope\.storageUserId\)/);
    assert.match(images, /insertImageGeneration\(scope\.storageUserId/);

    const fal = source("../app/api/fal/route.ts");
    assert.match(fal, /personalGenerationScope\(user\.id, body\)/);
    assert.match(fal, /getCredentials\(scope\.keyUserId, "fal"\)/);
    assert.match(fal, /assertStorageAvailable\(scope\.storageUserId\)/);
    assert.match(fal, /createFalJob\(\s*scope\.storageUserId/);
  });
});

describe("team routes", () => {
  it("checks membership and does not read keys", () => {
    const dir = fileURLToPath(new URL("../app/api/teams", import.meta.url));
    const banned = ["getCredentials", "listKeys", "api_keys", "last4", "R2_SECRET", "R2_ACCESS", "serveAsset", "presign"];
    const files = filesUnder(dir);
    assert.ok(files.length >= 6);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const word of banned) assert.equal(text.includes(word), false, `${file} contains ${word}`);
    }
    const media = source("../app/api/teams/[id]/media/route.ts");
    assert.match(media, /canReadTeamItem/);
    assert.match(media, /openAsset/);
    const lib = source("./teams.ts");
    assert.match(lib, /visibleTeamItems/);
    assert.match(lib, /canReadTeamItem/);
    for (const word of banned) assert.equal(lib.includes(word), false, `teams.ts contains ${word}`);
  });
});
