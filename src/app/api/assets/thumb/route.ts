import { errorResponse } from "@/lib/auth";
import { attachThumb, createThumbUpload, getAsset } from "@/lib/storage";
import { isAssetKey, uploadKindOf } from "@/lib/uploads";
import { requireWorkspace } from "@/lib/workspaces";

// Generated images and videos get their thumbnail lazily: the first time a browser shows
// one without a thumbnail, it draws a small JPEG and sends it here.

async function generatedAsset(request: Request) {
  // Any member viewing it can make its thumbnail.
  const { workspace } = await requireWorkspace(request);
  const { key } = (await request.json()) as { key: string };
  const asset = isAssetKey(key) && !key.startsWith("uploads/") ? await getAsset(workspace.id, key) : undefined;
  const kind = asset && (uploadKindOf(asset.contentType) ?? (asset.contentType.startsWith("image/") ? "image" : null));
  return asset && (kind === "image" || kind === "video") ? asset : undefined;
}

/** { key } → { uploadUrl } to PUT the JPEG thumbnail to. */
export async function POST(request: Request) {
  try {
    const asset = await generatedAsset(request);
    if (!asset) return Response.json({ error: "Not found" }, { status: 404 });
    if (asset.meta?.thumb) return Response.json({ done: true });
    return Response.json({ uploadUrl: await createThumbUpload(asset.workspaceId, asset) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** { key } — after the PUT: records the thumbnail. */
export async function PUT(request: Request) {
  try {
    const asset = await generatedAsset(request);
    if (!asset) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({ ok: await attachThumb(asset) });
  } catch (e) {
    return errorResponse(e);
  }
}
