// Team rows. Keys and buckets are not here: generations keep using the caller's own.

import { randomToken, sha256 } from "./crypto";
import { all, env, first, run } from "./db";
import { cleanTeamName, type TeamMember, type TeamRole, type TeamSummary } from "./teamPolicy";

export class TeamError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface MemberRow {
  user_id: string;
  role: TeamRole;
  joined_at: number;
  name: string | null;
  email: string;
}

const toMember = (row: MemberRow): TeamMember => ({
  id: row.user_id,
  name: row.name,
  email: row.email,
  role: row.role,
  joinedAt: row.joined_at,
});

export async function listTeams(userId: string): Promise<TeamSummary[]> {
  const rows = await all<{ id: string; name: string; role: TeamRole; created_at: number }>(
    `SELECT t.id, t.name, m.role, t.created_at
     FROM teams t JOIN team_members m ON m.team_id = t.id
     WHERE m.user_id = ?
     ORDER BY t.created_at DESC`,
    userId,
  );
  return rows.map((row) => ({ id: row.id, name: row.name, role: row.role, createdAt: row.created_at }));
}

export async function createTeam(ownerId: string, rawName: unknown): Promise<TeamSummary> {
  let name: string;
  try {
    name = cleanTeamName(rawName);
  } catch (e) {
    throw new TeamError((e as Error).message);
  }
  const id = crypto.randomUUID();
  const now = Date.now();
  const db = env().DB;
  await db.batch([
    db.prepare("INSERT INTO teams (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)").bind(id, name, ownerId, now),
    db
      .prepare("INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)")
      .bind(id, ownerId, now),
  ]);
  return { id, name, role: "owner", createdAt: now };
}

export async function listMembers(teamId: string): Promise<TeamMember[]> {
  const rows = await all<MemberRow>(
    `SELECT m.user_id, m.role, m.joined_at, u.name, u.email
     FROM team_members m JOIN users u ON u.id = m.user_id
     WHERE m.team_id = ?
     ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, m.joined_at`,
    teamId,
  );
  return rows.map(toMember);
}

async function membership(teamId: string, userId: string) {
  const members = await listMembers(teamId);
  const me = members.find((member) => member.id === userId);
  if (!me) throw new TeamError("Not found", 404);
  return { members, me };
}

export async function teamDetail(teamId: string, userId: string) {
  const { members, me } = await membership(teamId, userId);
  const team = await first<{ id: string; name: string; created_at: number }>(
    "SELECT id, name, created_at FROM teams WHERE id = ?",
    teamId,
  );
  if (!team) throw new TeamError("Not found", 404);
  return {
    team: { id: team.id, name: team.name, role: me.role, createdAt: team.created_at },
    members,
  };
}

export async function deleteTeam(teamId: string, userId: string) {
  const { me } = await membership(teamId, userId);
  if (me.role !== "owner") throw new TeamError("Only the owner can delete the team");
  await run("DELETE FROM teams WHERE id = ?", teamId);
}

export async function leaveTeam(teamId: string, userId: string) {
  const { me } = await membership(teamId, userId);
  if (me.role === "owner") throw new TeamError("Delete the team to close it");
  await run("DELETE FROM team_members WHERE team_id = ? AND user_id = ? AND role = 'member'", teamId, userId);
}

export async function removeMember(teamId: string, actorId: string, memberId: string) {
  const { me } = await membership(teamId, actorId);
  if (me.role !== "owner") throw new TeamError("Only the owner can remove members");
  if (memberId === actorId) throw new TeamError("Delete the team to close it");
  const result = await run(
    "DELETE FROM team_members WHERE team_id = ? AND user_id = ? AND role = 'member'",
    teamId,
    memberId,
  );
  if (!result.meta.changes) throw new TeamError("Not found", 404);
}

/** Replaces any outstanding link. The raw token is returned once and is not stored. */
export async function createInvite(teamId: string, userId: string, origin: string) {
  const { me } = await membership(teamId, userId);
  if (me.role !== "owner") throw new TeamError("Only the owner can invite members");
  const token = randomToken();
  const now = Date.now();
  const expiresAt = now + INVITE_TTL_MS;
  const db = env().DB;
  await db.batch([
    db.prepare("DELETE FROM team_invites WHERE team_id = ?").bind(teamId),
    db
      .prepare(
        "INSERT INTO team_invites (id, team_id, token_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(crypto.randomUUID(), teamId, sha256(token), userId, now, expiresAt),
  ]);
  return { url: `${origin.replace(/\/+$/, "")}/invite/${token}`, expiresAt };
}

/** Marks the invite used. A second update matches no row. */
export const CLAIM_INVITE_SQL =
  "UPDATE team_invites SET used_by = ? WHERE token_hash = ? AND used_by IS NULL AND expires_at > ?";

/**
 * Adds the member only when the claim update in this same transaction changed a row
 * (`changes() = 1`). A repeat, a second person, or a removed member inserts nothing.
 * Both statements go out in one D1 batch, which is one transaction: if the insert
 * fails, the claim rolls back with it.
 */
export const JOIN_CLAIMED_INVITE_SQL = `INSERT OR IGNORE INTO team_members (team_id, user_id, role, joined_at)
SELECT team_id, ?, 'member', ?
FROM team_invites
WHERE token_hash = ? AND used_by = ? AND changes() = 1`;

export async function acceptInvite(userId: string, token: unknown) {
  if (typeof token !== "string" || token.length < 20 || token.length > 200)
    throw new TeamError("Invite is invalid or expired", 404);
  const hash = sha256(token);
  const now = Date.now();
  const db = env().DB;
  await db.batch([
    db.prepare(CLAIM_INVITE_SQL).bind(userId, hash, now),
    db.prepare(JOIN_CLAIMED_INVITE_SQL).bind(userId, now, hash, userId),
  ]);
  const row = await first<{ team_id: string; used_by: string | null }>(
    "SELECT team_id, used_by FROM team_invites WHERE token_hash = ?",
    hash,
  );
  if (!row || row.used_by !== userId) throw new TeamError("Invite is invalid or expired", 404);
  // Still a member: a repeat of their own claim. Removed: the link stays claimed and does not re-add them.
  const member = await first<{ user_id: string }>(
    "SELECT user_id FROM team_members WHERE team_id = ? AND user_id = ?",
    row.team_id,
    userId,
  );
  if (!member) throw new TeamError("Invite is invalid or expired", 404);
  return teamDetail(row.team_id, userId);
}
