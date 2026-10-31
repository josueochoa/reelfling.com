import { errorResponse } from "@/lib/auth";
import { getImageGeneration } from "@/lib/images";
import { getAsset, serveAsset } from "@/lib/storage";
import { requireWorkspace } from "@/lib/workspaces";

/** ?i=N[&download] — redirects to a short-lived signed URL for one of the generation's images. */
export async function GET(request: Request, ctx: RouteContext<"/api/images/[id]/file">) {
  try {
    const { workspace } = await requireWorkspace(request);
    const { id } = await ctx.params;
    const params = new URL(request.url).searchParams;
    const image = (await getImageGeneration(workspace.id, id))?.images[Number(params.get("i") ?? 0)];
    const asset = image && (await getAsset(workspace.id, image.key));
    if (!asset) return new Response("Not found", { status: 404 });
    const ext = image.key.split(".").pop();
    return serveAsset(
      asset,
      params.has("download") ? { downloadName: `reelfling-${id.slice(0, 8)}-${params.get("i") ?? 0}.${ext}` } : {},
    );
  } catch (e) {
    return errorResponse(e);
  }
}
