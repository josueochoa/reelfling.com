// Teammates' work in the main tabs. Read-only: everyone keeps their own keys and storage,
// and access lasts only while two people share a team.

import { all, first } from "./db";
import { getAsset, listAssets, openAsset } from "./storage";
import { publicAuthor, teamMediaContentType, teamMediaHeaders, teammateAsset, type TeamAuthor } from "./teamPolicy";
import { isAssetKey, type AssetItem } from "./uploads";

/** Each teammate's newest rows per list. Older ones stay in their owner's own tabs. */
export const TEAMMATE_ROWS = 300;

/** User ids sharing at least one team with ?1 (bound twice), not counting them. */
const SHARED_IDS = `SELECT other.user_id FROM team_members mine
  JOIN team_members other ON other.team_id = mine.team_id
  WHERE mine.user_id = ? AND other.user_id != ?`;

export async function teammates(userId: string): Promise<TeamAuthor[]> {
  const rows = await all<TeamAuthor>(
    `SELECT id, name, email FROM users WHERE id IN (${SHARED_IDS}) ORDER BY COALESCE(name, email)`,
    userId,
    userId,
  );
  return rows.map(publicAuthor);
}

export async function sharesTeam(viewerId: string, ownerId: string): Promise<boolean> {
  if (!viewerId || !ownerId || viewerId === ownerId) return false;
  const row = await first<{ ok: number }>(
    `SELECT 1 AS ok FROM team_members mine
     JOIN team_members other ON other.team_id = mine.team_id
     WHERE mine.user_id = ? AND other.user_id = ? LIMIT 1`,
    viewerId,
    ownerId,
  );
  return !!row;
}

type Table = "generations" | "image_generations" | "fal_jobs";

/** Teammates' rows from one table, newest first, with who made each. Pass them through a teammate* view. */
export async function teammateRows<T>(viewerId: string, table: Table): Promise<{ data: T; owner: TeamAuthor }[]> {
  const rows = await all<{ data: string; id: string; name: string | null; email: string }>(
    `SELECT t.data, u.id, u.name, u.email FROM ${table} t JOIN users u ON u.id = t.user_id
     WHERE t.user_id IN (${SHARED_IDS})
     ORDER BY t.created_at DESC LIMIT ${TEAMMATE_ROWS}`,
    viewerId,
    viewerId,
  );
  return rows.flatMap((row) => {
    try {
      return [{ data: JSON.parse(row.data) as T, owner: publicAuthor(row) }];
    } catch {
      return [];
    }
  });
}

export const newestFirst = <T extends { createdAt: number }>(...lists: T[][]): T[] =>
  lists.flat().sort((a, b) => b.createdAt - a.createdAt);

/** Every teammate's library files, for the Assets tab. Not in the viewer's library, so they can't be references. */
export async function teammateAssets(viewerId: string): Promise<AssetItem[]> {
  const people = await teammates(viewerId);
  const lists = await Promise.all(
    people.map(async (owner) =>
      (await listAssets(owner.id)).slice(0, TEAMMATE_ROWS).map((item) => teammateAsset(item, owner)),
    ),
  );
  return newestFirst(...lists);
}

const notFound = () => new Response("Not found", { status: 404 });

/**
 * Streams a teammate's file, or its thumbnail. Not found unless the two share a team right now,
 * and a thumbnail that was never made is not found either (a video card asks without knowing).
 */
export async function serveTeammateFile(
  viewerId: string,
  ownerId: string,
  key: string,
  request: Request,
  opts: { thumb?: boolean; download?: boolean } = {},
): Promise<Response> {
  if (!isAssetKey(key) || !(await sharesTeam(viewerId, ownerId))) return notFound();
  const asset = await getAsset(ownerId, key);
  if (!asset || !teamMediaContentType(asset.contentType)) return notFound();
  if (opts.thumb && !asset.meta?.thumb) return notFound();
  const thumb = !!opts.thumb;
  const opened = await openAsset(asset, { thumb, range: request.headers.get("range") });
  const contentType = teamMediaContentType(thumb ? opened.contentType || "image/jpeg" : opened.contentType || asset.contentType);
  if (!contentType) {
    await opened.body?.cancel();
    return notFound();
  }
  return new Response(opened.body, {
    status: opened.status,
    headers: teamMediaHeaders({
      contentType,
      contentLength: opened.contentLength,
      contentRange: opened.contentRange,
      downloadName: opts.download ? (asset.name ?? key.split("/").slice(-2).join("-")) : undefined,
    }),
  });
}
