// Workspaces: the unit everything belongs to (generations, assets, the R2 bucket, API keys).
// Every user has a Personal workspace (id = user id); teams are shared workspaces with
// roles. Each request says which workspace it acts in (x-workspace-id header, or ?ws= on
// media URLs, which can't carry headers); membership is checked here, once.

import { requireUser, setActiveProvider as setUserProvider, type User } from "./auth";
import { randomToken, sha256 } from "./crypto";
import { all, env, first, run } from "./db";
import { isStudioProvider, type StudioProviderId } from "./registry";
import { deleteBucketContents } from "./storage";
import type { KeySource } from "./scope";
import {
  canManageKeys,
  canModify,
  permit,
  type Role,
  type WorkspaceKind,
} from "./teamPolicy";

export type { Role, WorkspaceKind };
export { canCreateTeam, canManageKeys, permit } from "./teamPolicy";

export interface Workspace {
  id: string;
  name: string;
  kind: WorkspaceKind;
  ownerId: string;
  /** Which of this workspace's keys generations use. Personal and team are independent. */
  activeProvider: StudioProviderId | null;
  /** The current user's role in it. */
  role: Role;
  memberCount: number;
  /** Team only: members may generate with their personal key. */
  memberKeys: boolean;
  /** Team only: admins may add, replace and remove the team key. */
  adminsManageKeys: boolean;
}

export class ForbiddenError extends Error {
  name = "ForbiddenError";
  status = 403;
  constructor(message: string) {
    super(message);
  }
}
export class NotFoundError extends Error {
  name = "NotFoundError";
  status = 404;
  constructor(message: string) {
    super(message);
  }
}

interface WorkspaceRow {
  id: string;
  name: string;
  kind: WorkspaceKind;
  owner_id: string;
  active_provider: string | null;
  role: Role;
  member_count: number;
  member_keys: number | null;
  admins_manage_keys: number | null;
}

const toWorkspace = (r: WorkspaceRow): Workspace => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  ownerId: r.owner_id,
  activeProvider: r.active_provider && isStudioProvider(r.active_provider) ? r.active_provider : null,
  role: r.role,
  memberCount: r.member_count,
  memberKeys: !!r.member_keys,
  adminsManageKeys: !!r.admins_manage_keys,
});

const WORKSPACE_SELECT = `
  SELECT w.*, m.role, (SELECT COUNT(*) FROM workspace_members c WHERE c.workspace_id = w.id) AS member_count
  FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = ?`;

/** The user's Personal workspace, created on first use (same id as the user). */
export async function ensurePersonalWorkspace(user: { id: string }) {
  const now = Date.now();
  await run(
    "INSERT OR IGNORE INTO workspaces (id, name, kind, owner_id, created_at) VALUES (?, 'Personal', 'personal', ?, ?)",
    user.id,
    user.id,
    now,
  );
  await run(
    "INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)",
    user.id,
    user.id,
    now,
  );
}

export async function getWorkspace(userId: string, workspaceId: string) {
  const row = await first<WorkspaceRow>(`${WORKSPACE_SELECT} WHERE w.id = ?`, userId, workspaceId);
  return row && toWorkspace(row);
}

export async function listWorkspaces(userId: string): Promise<Workspace[]> {
  const rows = await all<WorkspaceRow>(
    `${WORKSPACE_SELECT} ORDER BY CASE w.kind WHEN 'personal' THEN 0 ELSE 1 END, w.name`,
    userId,
  );
  return rows.map(toWorkspace);
}

/**
 * The signed-in user and the workspace this request acts in. Falls back to their
 * Personal workspace when none is given; a workspace they're not in is a 404, unless
 * `fallback` (for /api/me, so a tab remembering a team you've left recovers).
 */
export async function requireWorkspace(
  request: Request,
  { fallback = false } = {},
): Promise<{ user: User; workspace: Workspace }> {
  const user = await requireUser();
  let asked = request.headers.get("x-workspace-id") || new URL(request.url).searchParams.get("ws") || user.id;
  let workspace = await getWorkspace(user.id, asked);
  if (!workspace && fallback) {
    asked = user.id;
    workspace = await getWorkspace(user.id, asked);
  }
  if (!workspace && asked === user.id) {
    await ensurePersonalWorkspace(user);
    workspace = await getWorkspace(user.id, user.id);
  }
  if (!workspace) throw new NotFoundError("Workspace not found, or you're no longer a member.");
  return { user, workspace };
}

export function requireAdmin(ws: Workspace) {
  if (!permit(ws.role, "invite")) throw new ForbiddenError("Only the team's owner and admins can do that.");
}

export function requireOwner(ws: Workspace) {
  if (ws.role !== "owner") throw new ForbiddenError("Only the team's owner can do that.");
}

export function requireKeyManager(ws: Workspace) {
  if (!canManageKeys(ws.kind, ws.role, ws.adminsManageKeys))
    throw new ForbiddenError(
      ws.adminsManageKeys
        ? "Only the team's owner and admins can change its API keys."
        : "Only the team's owner can change its API keys.",
    );
}

/** Members can change their own items; owners and admins anyone's. */
export function requireCanModify(ws: Workspace, user: User, createdBy: string | null | undefined) {
  if (!canModify(ws.role, createdBy, user.id))
    throw new ForbiddenError("Only its creator or a team admin can change this.");
}

/**
 * Which key a generation uses. Personal workspaces always use the person's key.
 * A team uses its shared key unless the owner has allowed own keys and the
 * request asks for one.
 */
export function chooseKey(workspace: Workspace, userId: string, requested?: KeySource | null) {
  if (workspace.kind === "personal") return { source: "member" as const, keyWorkspaceId: workspace.id };
  if (requested === "member") {
    if (!workspace.memberKeys) throw new ForbiddenError("This team uses the shared key.");
    return { source: "member" as const, keyWorkspaceId: userId };
  }
  return { source: "team" as const, keyWorkspaceId: workspace.id };
}

/** Route preference for this workspace. A personal change also updates the user row, which wins on backfill. */
export async function setActiveProvider(workspace: Workspace, provider: StudioProviderId | null) {
  await run("UPDATE workspaces SET active_provider = ? WHERE id = ?", provider, workspace.id);
  if (workspace.kind === "personal") await setUserProvider(workspace.id, provider);
}

export async function setTeamFlags(
  id: string,
  flags: { memberKeys?: boolean; adminsManageKeys?: boolean },
) {
  if (flags.memberKeys !== undefined)
    await run("UPDATE workspaces SET member_keys = ? WHERE id = ? AND kind = 'team'", flags.memberKeys ? 1 : 0, id);
  if (flags.adminsManageKeys !== undefined)
    await run(
      "UPDATE workspaces SET admins_manage_keys = ? WHERE id = ? AND kind = 'team'",
      flags.adminsManageKeys ? 1 : 0,
      id,
    );
}

// ---------------------------------------------------------------- teams

export async function createTeam(user: User, name: string) {
  const id = crypto.randomUUID();
  const now = Date.now();
  await run(
    "INSERT INTO workspaces (id, name, kind, owner_id, created_at) VALUES (?, ?, 'team', ?, ?)",
    id,
    name,
    user.id,
    now,
  );
  await run(
    "INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)",
    id,
    user.id,
    now,
  );
  return (await getWorkspace(user.id, id))!;
}

export async function renameWorkspace(id: string, name: string) {
  await run("UPDATE workspaces SET name = ? WHERE id = ?", name, id);
}

/** Owner becomes an admin; the admin becomes the owner. */
export async function transferOwnership(workspaceId: string, fromUserId: string, toUserId: string) {
  await run(
    "UPDATE workspace_members SET role = 'owner' WHERE workspace_id = ? AND user_id = ? AND role = 'admin'",
    workspaceId,
    toUserId,
  );
  const nowOwner = await memberRole(workspaceId, toUserId);
  if (nowOwner !== "owner") throw new ForbiddenError("Ownership can only move to an admin.");
  await run(
    "UPDATE workspace_members SET role = 'admin' WHERE workspace_id = ? AND user_id = ?",
    workspaceId,
    fromUserId,
  );
  await run("UPDATE workspaces SET owner_id = ? WHERE id = ?", toUserId, workspaceId);
}

/** Deletes the team's rows (members, invites, generations, keys, bucket index) and its R2 bucket. */
export async function deleteTeam(workspaceId: string) {
  await deleteBucketContents(workspaceId);
  await run("DELETE FROM workspaces WHERE id = ? AND kind = 'team'", workspaceId);
}

export interface Member {
  userId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: Role;
  joinedAt: number;
  /** Optional monthly USD cap for team-key generations. Null means no cap. */
  monthlyCapUsd: number | null;
}

export async function listMembers(workspaceId: string): Promise<Member[]> {
  return all<Member>(
    `SELECT u.id AS userId, u.email, u.name, u.avatar_url AS avatarUrl, m.role, m.joined_at AS joinedAt,
            m.monthly_cap_usd AS monthlyCapUsd
     FROM workspace_members m JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.email`,
    workspaceId,
  );
}

export async function memberRole(workspaceId: string, userId: string) {
  return (
    await first<{ role: Role }>(
      "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
      workspaceId,
      userId,
    )
  )?.role;
}

export async function setMemberRole(workspaceId: string, userId: string, role: Role) {
  await run("UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?", role, workspaceId, userId);
}

export async function setMemberCap(workspaceId: string, userId: string, cap: number | null) {
  await run(
    "UPDATE workspace_members SET monthly_cap_usd = ? WHERE workspace_id = ? AND user_id = ?",
    cap,
    workspaceId,
    userId,
  );
}

/** Removing or leaving: their work stays in the team; they just lose access. */
export async function removeMember(workspaceId: string, userId: string) {
  await run("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?", workspaceId, userId);
}

async function addMember(workspaceId: string, userId: string, role: Role) {
  await run(
    `INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (workspace_id, user_id) DO NOTHING`,
    workspaceId,
    userId,
    role,
    Date.now(),
  );
}

// ---------------------------------------------------------------- invites

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export interface Invite {
  id: string;
  workspaceId: string;
  workspaceName: string;
  /** Email invites; link invites have none. */
  email: string | null;
  role: Role;
  invitedBy: string | null;
  createdAt: number;
  expiresAt: number;
}

const INVITE_SELECT = `
  SELECT i.id, i.workspace_id AS workspaceId, w.name AS workspaceName, i.email, i.role,
         COALESCE(u.name, u.email) AS invitedBy, i.created_at AS createdAt, i.expires_at AS expiresAt
  FROM workspace_invites i JOIN workspaces w ON w.id = i.workspace_id LEFT JOIN users u ON u.id = i.invited_by`;

/** An email invite (the person sees it when they sign in), or a link (returns the one-time token). */
export async function createInvite(
  workspaceId: string,
  by: User,
  role: Role,
  email?: string,
): Promise<{ invite: Invite; token?: string }> {
  const id = crypto.randomUUID();
  const token = email ? undefined : randomToken(24);
  const now = Date.now();
  if (email)
    await run("DELETE FROM workspace_invites WHERE workspace_id = ? AND email = ?", workspaceId, email.toLowerCase());
  await run(
    `INSERT INTO workspace_invites (id, workspace_id, email, token_hash, role, invited_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    workspaceId,
    email?.toLowerCase() ?? null,
    token ? sha256(token) : null,
    role,
    by.id,
    now,
    now + INVITE_TTL_MS,
  );
  const invite = (await first<Invite>(`${INVITE_SELECT} WHERE i.id = ?`, id))!;
  return { invite, token };
}

export async function listInvites(workspaceId: string) {
  return all<Invite>(
    `${INVITE_SELECT} WHERE i.workspace_id = ? AND i.expires_at > ? ORDER BY i.created_at DESC`,
    workspaceId,
    Date.now(),
  );
}

/** Pending email invites for someone, across teams they're not in yet. */
export async function invitesForEmail(email: string, userId?: string) {
  return all<Invite>(
    `${INVITE_SELECT} WHERE i.email = ? AND i.expires_at > ?
       AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = i.workspace_id AND m.user_id = ?)`,
    email.toLowerCase(),
    Date.now(),
    userId ?? "",
  );
}

export async function revokeInvite(workspaceId: string, inviteId: string) {
  await run("DELETE FROM workspace_invites WHERE id = ? AND workspace_id = ?", inviteId, workspaceId);
}

/** Looks up an unexpired invite by its link token, or by id for an email invite to `email`. */
export async function findInvite(by: { token: string } | { id: string; email: string }) {
  return "token" in by
    ? first<Invite>(`${INVITE_SELECT} WHERE i.token_hash = ? AND i.expires_at > ?`, sha256(by.token), Date.now())
    : first<Invite>(
        `${INVITE_SELECT} WHERE i.id = ? AND i.email = ? AND i.expires_at > ?`,
        by.id,
        by.email.toLowerCase(),
        Date.now(),
      );
}

/** Joins the team. Email invites are used up; links stay valid for others until they expire. */
export async function acceptInvite(invite: Invite, user: User) {
  await addMember(invite.workspaceId, user.id, invite.role);
  if (invite.email) await run("DELETE FROM workspace_invites WHERE id = ?", invite.id);
}

export async function declineInvite(invite: Invite) {
  await run("DELETE FROM workspace_invites WHERE id = ?", invite.id);
}

// ---------------------------------------------------------------- who may sign up

/**
 * Who may get an account. By default anyone who signs in: Cloudflare Access's policy is
 * the gate. With INVITE_ONLY=true, only the first account ever and emails with a pending
 * invite (or an invite link, see /api/invites/accept). Existing users always get in.
 */
export async function mayCreateAccount(email: string) {
  if (env().INVITE_ONLY !== "true") return true;
  if ((await invitesForEmail(email)).length) return true;
  return !(await first<{ n: number }>("SELECT 1 AS n FROM users LIMIT 1"));
}
