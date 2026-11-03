// Team rows. Keys and buckets are not here: generations keep using the caller's own.

import { randomToken, sha256 } from "./crypto";
import { all, env, first, run } from "./db";
import {
  canReadTeamItem,
  cleanTeamName,
  publicTeamAsset,
  publicTeamGeneration,
  visibleTeamItems,
  type TeamAsset,
  type TeamAuthor,
  type TeamGeneration,
  type TeamMember,
  type TeamRole,
  type TeamSummary,
} from "./teamPolicy";

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

const authorOf = (member: TeamMember): TeamAuthor => ({ id: member.id, name: member.name, email: member.email });

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

export async function memberIds(teamId: string): Promise<string[]> {
  const rows = await all<{ user_id: string }>("SELECT user_id FROM team_members WHERE team_id = ?", teamId);
  return rows.map((row) => row.user_id);
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

export async function acceptInvite(userId: string, token: unknown) {
  if (typeof token !== "string" || token.length < 20 || token.length > 200)
    throw new TeamError("Invite is invalid or expired", 404);
  const hash = sha256(token);
  const now = Date.now();
  // One claim wins. A second request from that same person, while they are still
  // a member, is the same join. After removal the row stays claimed, so the link
  // cannot add them again.
  const claimed = await run(
    "UPDATE team_invites SET used_by = ? WHERE token_hash = ? AND used_by IS NULL AND expires_at > ?",
    userId,
    hash,
    now,
  );
  const row = await first<{ team_id: string; used_by: string | null }>(
    "SELECT team_id, used_by FROM team_invites WHERE token_hash = ?",
    hash,
  );
  if (!row || row.used_by !== userId) throw new TeamError("Invite is invalid or expired", 404);
  if (claimed.meta.changes) {
    await run(
      "INSERT OR IGNORE INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)",
      row.team_id,
      userId,
      now,
    );
  } else {
    const still = await first<{ user_id: string }>(
      "SELECT user_id FROM team_members WHERE team_id = ? AND user_id = ?",
      row.team_id,
      userId,
    );
    if (!still) throw new TeamError("Invite is invalid or expired", 404);
  }
  return teamDetail(row.team_id, userId);
}

interface ItemRow {
  id: string;
  user_id: string;
  created_at: number;
  data: string;
  name: string | null;
  email: string;
}

function parseData(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

async function generationRows(table: string, memberIds: string[]): Promise<ItemRow[]> {
  const marks = memberIds.map(() => "?").join(", ");
  return all<ItemRow>(
    `SELECT g.id, g.user_id, g.created_at, g.data, u.name, u.email
     FROM ${table} g JOIN users u ON u.id = g.user_id
     WHERE g.user_id IN (${marks})
     ORDER BY g.created_at DESC LIMIT 100`,
    ...memberIds,
  );
}

export async function teamFeed(teamId: string, viewerId: string) {
  const members = await listMembers(teamId);
  const ids = members.map((member) => member.id);
  // Viewer must still be a member. A removed member gets nothing, including their own rows.
  if (!canReadTeamItem(ids, viewerId, viewerId)) throw new TeamError("Not found", 404);
  const byId = new Map(members.map((member) => [member.id, authorOf(member)]));

  const [videos, images, fal] = await Promise.all([
    generationRows("generations", ids),
    generationRows("image_generations", ids),
    generationRows("fal_jobs", ids),
  ]);
  const generations: TeamGeneration[] = [
    ...videos.map((row) =>
      publicTeamGeneration({
        id: row.id,
        ownerId: row.user_id,
        kind: "video",
        createdAt: row.created_at,
        data: parseData(row.data),
        author: byId.get(row.user_id) ?? { id: row.user_id, name: row.name, email: row.email },
      }),
    ),
    ...images.map((row) =>
      publicTeamGeneration({
        id: row.id,
        ownerId: row.user_id,
        kind: "image",
        createdAt: row.created_at,
        data: parseData(row.data),
        author: byId.get(row.user_id) ?? { id: row.user_id, name: row.name, email: row.email },
      }),
    ),
    ...fal.map((row) =>
      publicTeamGeneration({
        id: row.id,
        ownerId: row.user_id,
        kind: "fal",
        createdAt: row.created_at,
        data: parseData(row.data),
        author: byId.get(row.user_id) ?? { id: row.user_id, name: row.name, email: row.email },
      }),
    ),
  ].sort((a, b) => b.createdAt - a.createdAt);

  const marks = ids.map(() => "?").join(", ");
  const assets = await all<{
    user_id: string;
    key: string;
    bytes: number;
    content_type: string;
    created_at: number;
    name: string | null;
    has_thumb: number;
    author_name: string | null;
    email: string;
  }>(
    `SELECT a.user_id, a.key, a.bytes, a.content_type, a.created_at, a.name,
            CASE WHEN json_extract(a.meta, '$.thumb') IS NOT NULL THEN 1 ELSE 0 END AS has_thumb,
            u.name AS author_name, u.email
     FROM assets a JOIN users u ON u.id = a.user_id
     WHERE a.user_id IN (${marks})
       AND (a.key LIKE 'uploads/%' OR a.key LIKE 'videos/%' OR a.key LIKE 'images/%' OR a.key LIKE 'fal/%')
     ORDER BY a.created_at DESC LIMIT 200`,
    ...ids,
  );
  const publicAssets: TeamAsset[] = [];
  for (const row of assets) {
    const item = publicTeamAsset({
      ownerId: row.user_id,
      key: row.key,
      name: row.name,
      contentType: row.content_type,
      bytes: row.bytes,
      createdAt: row.created_at,
      hasThumb: row.has_thumb === 1,
      author: byId.get(row.user_id) ?? { id: row.user_id, name: row.author_name, email: row.email },
    });
    if (item) publicAssets.push(item);
  }

  return {
    generations: visibleTeamItems(ids, viewerId, generations),
    assets: visibleTeamItems(ids, viewerId, publicAssets),
  };
}
