import { errorResponse } from "@/lib/auth";
import { getAsset, serveAsset } from "@/lib/storage";
import { isAssetKey } from "@/lib/uploads";
import { requireWorkspace } from "@/lib/workspaces";

/** ?key=…&ws=…[&thumb=1][&download] — redirects to a short-lived signed URL for one of the workspace's assets. */
export async function GET(request: Request) {
  try {
    const { workspace } = await requireWorkspace(request);
    const params = new URL(request.url).searchParams;
    const key = params.get("key") ?? "";
    const asset = isAssetKey(key) ? await getAsset(workspace.id, key) : undefined;
    if (!asset) return new Response("Not found", { status: 404 });
    const name = asset.name ?? key.split("/").slice(-2).join("-");
    return serveAsset(asset, { thumb: params.has("thumb"), downloadName: params.has("download") ? name : undefined });
  } catch (e) {
    return errorResponse(e);
  }
}
