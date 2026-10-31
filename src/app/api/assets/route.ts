import { deleteWorkspaceAsset } from "@/lib/assets";
import { errorResponse } from "@/lib/auth";
import { getAsset, listAssets } from "@/lib/storage";
import { isAssetKey } from "@/lib/uploads";
import { requireCanModify, requireWorkspace } from "@/lib/workspaces";

/** All of the workspace's assets (uploads and generated), newest first. */
export async function GET(request: Request) {
  try {
    const { workspace } = await requireWorkspace(request);
    return Response.json(await listAssets(workspace.id));
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * { keys } — delete assets. Generated ones take their generation with them (see assets.ts).
 * In a team, members can only delete what they made; owners and admins anything.
 */
export async function DELETE(request: Request) {
  try {
    const { user, workspace } = await requireWorkspace(request);
    const { keys } = (await request.json()) as { keys: string[] };
    if (!Array.isArray(keys) || keys.length > 500) return Response.json({ error: "Invalid keys" }, { status: 400 });
    // Check them all first, so a refused one doesn't leave a half-done delete.
    const assets = await Promise.all(keys.map((k) => (isAssetKey(k) ? getAsset(workspace.id, k) : undefined)));
    for (const a of assets) if (a) requireCanModify(workspace, user, a.createdBy);
    for (const a of assets) if (a) await deleteWorkspaceAsset(workspace.id, a.key);
    return new Response(null, { status: 204 });
  } catch (e) {
    return errorResponse(e);
  }
}
