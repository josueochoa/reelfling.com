import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { CLAIM_INVITE_SQL, JOIN_CLAIMED_INVITE_SQL } from "./teams";
import {
  canReadTeamItem,
  publicAuthor,
  publicTeamAsset,
  publicTeamGeneration,
  teamMediaContentType,
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

  it("sandboxes team media and refuses anything that is not image, video, or audio", () => {
    const headers = teamMediaHeaders({ contentType: "video/mp4", contentLength: "12", contentRange: null });
    assert.equal(headers.get("Cache-Control"), "private, no-store");
    assert.equal(headers.get("Content-Security-Policy"), "sandbox");
    assert.equal(headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(headers.has("Location"), false);
    const raw = [...headers.entries()].map(([key, value]) => `${key}:${value}`).join("\n");
    assert.equal(/amz|cloudflarestorage|secret/i.test(raw), false);

    assert.equal(teamMediaContentType("video/mp4"), "video/mp4");
    assert.equal(teamMediaContentType("image/jpeg; charset=binary"), "image/jpeg");
    assert.equal(teamMediaContentType("audio/mpeg"), "audio/mpeg");
    assert.equal(teamMediaContentType("application/pdf"), undefined);
    assert.equal(teamMediaContentType("text/html"), undefined);
    assert.equal(teamMediaContentType("application/octet-stream"), undefined);
    assert.equal(teamMediaContentType(null), undefined);
  });
});

describe("invite claim", () => {
  function claimDb() {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE team_invites (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        used_by TEXT,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE team_members (
        team_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (team_id, user_id)
      );
      INSERT INTO team_invites (id, team_id, token_hash, expires_at) VALUES ('inv', 'team', 'hash', 5000);
    `);
    const claim = db.prepare(CLAIM_INVITE_SQL);
    const join = db.prepare(JOIN_CLAIMED_INVITE_SQL);
    const attempt = (userId: string, now: number) => {
      db.exec("BEGIN");
      claim.run(userId, "hash", now);
      join.run(userId, now, "hash", userId);
      db.exec("COMMIT");
    };
    const members = () => db.prepare("SELECT user_id FROM team_members ORDER BY user_id").all() as { user_id: string }[];
    return { db, attempt, members };
  }

  it("lets one claim add one member and a second claim add nobody", () => {
    const { db, attempt, members } = claimDb();
    attempt(ADA, 10);
    attempt(ADA, 11);
    attempt(BEN, 12);
    assert.deepEqual(members().map((row) => row.user_id), [ADA]);
    assert.equal((db.prepare("SELECT used_by FROM team_invites").get() as { used_by: string }).used_by, ADA);

    db.exec("DELETE FROM team_members");
    attempt(ADA, 13);
    assert.deepEqual(members(), []);
  });
});
