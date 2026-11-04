import { errorResponse, requireUser } from "@/lib/auth";
import { getAsset, openAsset } from "@/lib/storage";
import { canReadTeamItem, teamMediaContentType, teamMediaHeaders } from "@/lib/teamPolicy";
import { memberIds } from "@/lib/teams";
import { isAssetKey } from "@/lib/uploads";

/**
 * Streams one teammate's file for this request. Membership is checked first.
 * The response is the bytes, not a signed URL.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/teams/[id]/media">) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const params = new URL(request.url).searchParams;
    const ownerId = params.get("owner") ?? "";
    const key = params.get("key") ?? "";
    if (!isAssetKey(key)) return new Response("Not found", { status: 404 });
    const ids = await memberIds(id);
    if (!canReadTeamItem(ids, user.id, ownerId)) return new Response("Not found", { status: 404 });
    const asset = await getAsset(ownerId, key);
    if (!asset || !teamMediaContentType(asset.contentType)) return new Response("Not found", { status: 404 });
    const thumb = params.has("thumb");
    const opened = await openAsset(asset, { thumb, range: request.headers.get("range") });
    const contentType = teamMediaContentType(thumb ? opened.contentType || "image/jpeg" : opened.contentType || asset.contentType);
    if (!contentType) {
      await opened.body?.cancel();
      return new Response("Not found", { status: 404 });
    }
    return new Response(opened.body, {
      status: opened.status,
      headers: teamMediaHeaders({
        contentType,
        contentLength: opened.contentLength,
        contentRange: opened.contentRange,
      }),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
