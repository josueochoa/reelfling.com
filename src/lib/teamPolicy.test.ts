import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { CLAIM_INVITE_SQL, JOIN_CLAIMED_INVITE_SQL } from "./teams";
import { publicAuthor, teamMediaContentType, teamMediaHeaders, teammateGeneration } from "./teamPolicy";
import type { Generation } from "./types";

const ADA = "user-ada";
const BEN = "user-ben";

describe("teammate views", () => {
  it("drops the provider task id and URLs from a teammate's generation", () => {
    const gen = {
      id: "gen-1",
      taskId: "task-secret",
      status: "succeeded",
      prompt: "A red paper boat",
      remoteVideoUrl: "https://provider.example/video?X-Amz-Signature=abc",
      falStatusUrl: "https://queue.fal.run/status",
      falResponseUrl: "https://queue.fal.run/response",
      falCancelUrl: "https://queue.fal.run/cancel",
    } as unknown as Generation;
    const author = { id: ADA, name: "Ada", email: "ada@example.com", last4: "4455" } as never;
    const view = teammateGeneration(gen, author);
    assert.equal(view.prompt, "A red paper boat");
    assert.equal(view.taskId, "");
    assert.deepEqual(view.owner, { id: ADA, name: "Ada", email: "ada@example.com" });
    const json = JSON.stringify(view);
    assert.equal(/secret|X-Amz-Signature|fal\.run|4455/.test(json), false);
    // The owner's own record is untouched.
    assert.equal(gen.taskId, "task-secret");
  });

  it("keeps an author to a name and email", () => {
    const author = publicAuthor({ id: BEN, name: null, email: "ben@example.com" });
    assert.deepEqual(author, { id: BEN, name: null, email: "ben@example.com" });
  });

  it("sandboxes team media and refuses anything that is not image, video, or audio", () => {
    const headers = teamMediaHeaders({ contentType: "video/mp4", contentLength: "12", contentRange: null });
    assert.equal(headers.get("Cache-Control"), "private, no-store");
    assert.equal(headers.get("Content-Security-Policy"), "sandbox");
    assert.equal(headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(headers.has("Location"), false);
    assert.equal(headers.has("Content-Disposition"), false);
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

  it("names a download without letting the name break the header", () => {
    const headers = teamMediaHeaders({ contentType: "image/png", downloadName: 'a"b\r\nc.png' });
    assert.equal(headers.get("Content-Disposition"), 'attachment; filename="a_b__c.png"');
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
