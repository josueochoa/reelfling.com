import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { canCreateTeam, canManageKeys, canModify, countsTowardCap, permit, type Role, type TeamAction } from "./teamPolicy";

const ROLES: Role[] = ["owner", "admin", "member"];

/** Every team route and the action its handler checks. */
const ROUTES: { file: string; action: TeamAction | "createTeam"; needle: string }[] = [
  { file: "src/app/api/workspaces/route.ts", action: "createTeam", needle: "canCreateTeam(" },
  { file: "src/app/api/workspaces/[id]/route.ts", action: "rename", needle: 'permit(ws.role, "rename")' },
  { file: "src/app/api/workspaces/[id]/route.ts", action: "setMemberKeys", needle: 'permit(ws.role, "setMemberKeys")' },
  { file: "src/app/api/workspaces/[id]/route.ts", action: "deleteTeam", needle: 'permit(ws.role, "deleteTeam")' },
  { file: "src/app/api/workspaces/[id]/transfer/route.ts", action: "transfer", needle: 'permit(ws.role, "transfer")' },
  { file: "src/app/api/workspaces/[id]/invites/route.ts", action: "invite", needle: 'permit(ws.role, "invite")' },
  { file: "src/app/api/workspaces/[id]/invites/[inviteId]/route.ts", action: "revokeInvite", needle: 'permit(ws.role, "revokeInvite")' },
  { file: "src/app/api/workspaces/[id]/members/route.ts", action: "invite", needle: 'permit(ws.role, "invite")' },
  { file: "src/app/api/workspaces/[id]/members/[userId]/route.ts", action: "setRole", needle: 'permit(ws.role, "setRole"' },
  { file: "src/app/api/workspaces/[id]/members/[userId]/route.ts", action: "setCap", needle: 'permit(ws.role, "setCap")' },
  { file: "src/app/api/workspaces/[id]/members/[userId]/route.ts", action: "removeOther", needle: 'permit(ws.role, "removeOther"' },
  { file: "src/app/api/workspaces/[id]/members/[userId]/route.ts", action: "leave", needle: 'permit(ws.role, "leave"' },
  { file: "src/app/api/workspaces/[id]/usage/route.ts", action: "viewUsage", needle: 'permit(ws.role, "viewUsage")' },
  { file: "src/app/api/keys/route.ts", action: "manageKeys", needle: "requireKeyManager(" },
  // A route preference is the signed-in user's, not the team's shared switch.
  { file: "src/app/api/me/route.ts", action: "setRoute", needle: "requireWorkspace(" },
  { file: "src/app/api/generations/[id]/route.ts", action: "editOwn", needle: "requireCanModify(" },
  { file: "src/app/api/images/[id]/route.ts", action: "editOwn", needle: "requireCanModify(" },
  { file: "src/app/api/fal/[id]/route.ts", action: "editOwn", needle: "requireCanModify(" },
  { file: "src/app/api/assets/route.ts", action: "editOwn", needle: "requireCanModify(" },
  { file: "src/app/api/uploads/route.ts", action: "editOwn", needle: "requireCanModify(" },
];

describe("team roles", () => {
  it("lets any signed-in user create a team", () => {
    assert.equal(canCreateTeam(), true);
    const src = readFileSync("src/app/api/workspaces/route.ts", "utf8");
    assert.equal(src.includes("plan"), false);
    assert.equal(src.includes("stripe"), false);
  });

  for (const role of ROLES) {
    it(`${role} permissions`, () => {
      assert.equal(permit(role, "generate"), true);
      assert.equal(permit(role, "editOwn"), true);
      assert.equal(permit(role, "rename"), role === "owner");
      assert.equal(permit(role, "setCap"), role === "owner");
      assert.equal(permit(role, "setMemberKeys"), role === "owner");
      assert.equal(permit(role, "setAdminsManageKeys"), role === "owner");
      assert.equal(permit(role, "transfer"), role === "owner");
      assert.equal(permit(role, "deleteTeam"), role === "owner");
      assert.equal(permit(role, "invite"), role !== "member");
      assert.equal(permit(role, "revokeInvite"), role !== "member");
      assert.equal(permit(role, "viewUsage"), role !== "member");
      assert.equal(permit(role, "editOther"), role !== "member");
      assert.equal(permit(role, "setRole", { targetIsOwner: false }), role !== "member");
      assert.equal(permit(role, "setRole", { targetIsOwner: true }), false);
      assert.equal(permit(role, "removeOther", { targetIsOwner: false }), role !== "member");
      assert.equal(permit(role, "removeOther", { targetIsOwner: true }), false);
      assert.equal(permit(role, "leave", { self: true }), role !== "owner");
      assert.equal(permit(role, "leave", { self: false }), false);
      assert.equal(permit(role, "manageKeys", { adminsManageKeys: false }), role === "owner");
      assert.equal(permit(role, "manageKeys", { adminsManageKeys: true }), role !== "member");
      assert.equal(permit(role, "setRoute", { adminsManageKeys: false }), role === "owner");
      assert.equal(canManageKeys("personal", role, false), true);
      assert.equal(canManageKeys("team", role, false), role === "owner");
      assert.equal(canManageKeys("team", role, true), role !== "member");
      assert.equal(canModify(role, "someone-else", "me"), role !== "member");
      assert.equal(canModify(role, "me", "me"), true);
    });
  }

  it("checks a role on every team route", () => {
    for (const route of ROUTES) {
      const src = readFileSync(route.file, "utf8");
      assert.equal(src.includes(route.needle), true, `${route.file} should check ${route.action}`);
      assert.equal(/stripe|plan_override|effectivePlan/.test(src), false, route.file);
    }
  });

  it("counts only team-key generations toward a cap", () => {
    assert.equal(countsTowardCap("team"), true);
    assert.equal(countsTowardCap("member"), false);
  });
});
