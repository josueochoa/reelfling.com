import { deleteWorkspaceAsset } from "@/lib/assets";
import { errorResponse } from "@/lib/auth";
import { getAsset, listAssets } from "@/lib/storage";
import { requireCanModify, requireWorkspace } from "@/lib/workspaces";

/** The workspace's assets (uploads and generated), newest first. */
export async function GET(request: Request) {
  try {
    const { workspace } = await requireWorkspace(request);
    return Response.json(await listAssets(workspace.id));
  } catch (e) {
    return errorResponse(e);
  }
}

/** { keys } — delete assets the caller is allowed to change. */
export async function DELETE(request: Request) {
  try {
    const { user, workspace } = await requireWorkspace(request);
    const { keys } = (await request.json()) as { keys: string[] };
    if (!Array.isArray(keys) || keys.length > 500) return Response.json({ error: "Invalid keys" }, { status: 400 });
    for (const key of keys) {
      const asset = await getAsset(workspace.id, key);
      if (!asset) continue;
      requireCanModify(workspace, user, asset.createdBy);
      await deleteWorkspaceAsset(workspace.id, key);
    }
    return new Response(null, { status: 204 });
  } catch (e) {
    return errorResponse(e);
  }
}
