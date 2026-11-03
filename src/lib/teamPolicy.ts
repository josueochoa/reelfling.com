// Who may do what in a team. Routes call these; the role tests cover the same table.

import type { KeySource } from "./scope";

export type Role = "owner" | "admin" | "member";
export type WorkspaceKind = "personal" | "team";

export type TeamAction =
  | "rename"
  | "invite"
  | "revokeInvite"
  | "setRole"
  | "removeOther"
  | "leave"
  | "manageKeys"
  | "setRoute"
  | "setMemberKeys"
  | "setAdminsManageKeys"
  | "setCap"
  | "viewUsage"
  | "transfer"
  | "deleteTeam"
  | "generate"
  | "editOwn"
  | "editOther";

export function canCreateTeam() {
  return true;
}

export function canManageKeys(kind: WorkspaceKind, role: Role, adminsManageKeys: boolean) {
  if (kind === "personal") return true;
  if (role === "owner") return true;
  return role === "admin" && adminsManageKeys;
}

export function canModify(role: Role, createdBy: string | null | undefined, userId: string) {
  if (role === "owner" || role === "admin") return true;
  return createdBy === userId;
}

/**
 * Role check for one action. `targetIsOwner` applies to setRole and removeOther.
 * `self` applies to leave. `adminsManageKeys` applies to manageKeys and setRoute.
 */
export function permit(
  role: Role,
  action: TeamAction,
  opts: { adminsManageKeys?: boolean; targetIsOwner?: boolean; self?: boolean } = {},
) {
  switch (action) {
    case "rename":
    case "setMemberKeys":
    case "setAdminsManageKeys":
    case "setCap":
    case "transfer":
    case "deleteTeam":
      return role === "owner";
    case "invite":
    case "revokeInvite":
    case "viewUsage":
    case "editOther":
      return role === "owner" || role === "admin";
    case "setRole":
    case "removeOther":
      if (opts.targetIsOwner) return false;
      return role === "owner" || role === "admin";
    case "leave":
      return !!opts.self && role !== "owner";
    case "manageKeys":
    case "setRoute":
      return canManageKeys("team", role, !!opts.adminsManageKeys);
    case "generate":
    case "editOwn":
      return true;
    default:
      return false;
  }
}

/** Team-key spend is capped. A member's own key is not. */
export function countsTowardCap(source: KeySource) {
  return source === "team";
}
